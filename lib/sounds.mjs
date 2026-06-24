// Biblioteca de sonidos. Política: TODOS los sonidos viven siempre en disco
// local (espejo en data/sounds/); el object-store es solo respaldo durable y
// destino de los uploads. La reproducción nunca toca la red → latencia mínima.
import { existsSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, now } from './db.mjs'
import { getStore } from './storage/index.mjs'
import { paths } from './config.mjs'
import { canSeeSound } from './rbac.mjs'

export function localPath(sound) {
  return join(paths.sounds, `${sound.id}.${sound.ext}`)
}

function objectKey(id, ext) { return `sounds/${id}.${ext}` }

// Sube un sonido: object-store (respaldo) + espejo local (listo para sonar ya).
export async function upload({ ownerUserId = null, label, folder = '', ext, buffer, durationMs = null, visibility = 'global' }) {
  const db = getDb()
  const ts = now()
  const info = db.prepare(
    `INSERT INTO sounds (owner_user_id, label, folder, object_key, ext, size_bytes, duration_ms, visibility, created_at)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)`
  ).run(ownerUserId, label, folder, ext, buffer.length, durationMs, visibility, ts)
  const id = Number(info.lastInsertRowid)
  const key = objectKey(id, ext)
  db.prepare('UPDATE sounds SET object_key = ? WHERE id = ?').run(key, id)

  await getStore().put(key, buffer)          // respaldo durable
  writeFileSync(localPath({ id, ext }), buffer) // espejo local inmediato
  return getById(id)
}

export function getById(id) {
  return getDb().prepare('SELECT * FROM sounds WHERE id = ?').get(id)
}

// Asegura que cada sonido tenga su espejo local; baja del object-store lo que falte.
export async function syncFromStore() {
  const db = getDb()
  const store = getStore()
  const rows = db.prepare('SELECT * FROM sounds').all()
  let restored = 0
  for (const s of rows) {
    const lp = localPath(s)
    if (existsSync(lp)) continue
    if (await store.exists(s.object_key)) {
      await store.getToFile(s.object_key, lp)
      restored++
    }
  }
  return { total: rows.length, restored }
}

// Sonidos visibles para un usuario (global + propios privados − ocultos por rol).
// Incluye `owner_name` (nombre para mostrar de quien lo subió), y el overlay de
// personalización del propio usuario: `alias` (nombre propio, NULL = original) y
// `hidden` (1 = el usuario lo ocultó para sí mismo) vía LEFT JOIN.
export function listForUser(userId) {
  const db = getDb()
  const candidates = db.prepare(
    `SELECT s.*, COALESCE(u.display_name, u.username) AS owner_name,
            p.alias AS alias, COALESCE(p.hidden, 0) AS hidden
       FROM sounds s
       LEFT JOIN users u ON u.id = s.owner_user_id
       LEFT JOIN user_sound_prefs p ON p.sound_id = s.id AND p.user_id = ?
      WHERE s.visibility = 'global' OR (s.visibility = 'private' AND s.owner_user_id = ?)`
  ).all(userId ?? -1, userId ?? -1)
  return candidates.filter(s => canSeeSound(userId, s))
}

// Fija/limpia el nombre propio de un sonido para un usuario (alias vacío = original).
export function setAlias(userId, soundId, alias) {
  const clean = (alias || '').trim() || null
  const db = getDb()
  db.prepare(
    `INSERT INTO user_sound_prefs (user_id, sound_id, alias, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, sound_id) DO UPDATE SET alias = excluded.alias, updated_at = excluded.updated_at`
  ).run(userId, soundId, clean, now())
}

// Oculta/restaura un sonido solo para ese usuario.
export function setHidden(userId, soundId, hidden) {
  const db = getDb()
  db.prepare(
    `INSERT INTO user_sound_prefs (user_id, sound_id, hidden, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, sound_id) DO UPDATE SET hidden = excluded.hidden, updated_at = excluded.updated_at`
  ).run(userId, soundId, hidden ? 1 : 0, now())
}

// ── Vistas de gestión (solo admin) ───────────────────────────────────────────
// Todos los sonidos privados, con el nombre de su dueño.
export function allPrivate() {
  return getDb().prepare(
    `SELECT s.id, s.label, s.folder, s.created_at,
            COALESCE(u.display_name, u.username) AS owner_name, s.owner_user_id
       FROM sounds s
       LEFT JOIN users u ON u.id = s.owner_user_id
      WHERE s.visibility = 'private'
      ORDER BY owner_name COLLATE NOCASE, s.label COLLATE NOCASE`
  ).all()
}

// Todos los renombres hechos por los usuarios: original → alias, quién lo renombró
// y de quién es el sonido.
export function allAliases() {
  return getDb().prepare(
    `SELECT p.sound_id, p.alias, p.updated_at,
            s.label AS original, s.visibility,
            COALESCE(ru.display_name, ru.username) AS renamer,
            COALESCE(ou.display_name, ou.username) AS owner_name
       FROM user_sound_prefs p
       JOIN sounds s  ON s.id  = p.sound_id
       JOIN users ru  ON ru.id = p.user_id
       LEFT JOIN users ou ON ou.id = s.owner_user_id
      WHERE p.alias IS NOT NULL AND p.alias <> ''
      ORDER BY p.updated_at DESC`
  ).all()
}

// Árbol de carpetas compatible con el panel: { name, sounds:[{id,file,label}], folders:[...] }
// `extraFolders` (rutas "a/b/c") siembra carpetas aunque no tengan sonidos, para
// que aparezcan las carpetas vacías creadas explícitamente.
export function tree(rows, extraFolders = []) {
  const root = { name: '', sounds: [], folders: new Map() }
  const ensure = (parts) => {
    let node = root
    for (const part of parts) {
      if (!node.folders.has(part)) node.folders.set(part, { name: part, sounds: [], folders: new Map() })
      node = node.folders.get(part)
    }
    return node
  }
  for (const path of extraFolders) if (path) ensure(path.split('/'))
  for (const s of rows) {
    const node = ensure(s.folder ? s.folder.split('/') : [])
    node.sounds.push({
      id: s.id, file: String(s.id), label: s.label,
      owner: s.owner_name || null, visibility: s.visibility,
      alias: s.alias || null, hidden: s.hidden ? 1 : 0,
    })
  }
  const toJSON = n => ({
    name: n.name,
    sounds: n.sounds.sort((a, b) => a.label.localeCompare(b.label, 'es')),
    folders: [...n.folders.values()].sort((a, b) => a.name.localeCompare(b.name, 'es')).map(toJSON),
  })
  return toJSON(root)
}
