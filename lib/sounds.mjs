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
export function listForUser(userId) {
  const db = getDb()
  const candidates = db.prepare(
    `SELECT * FROM sounds WHERE visibility = 'global' OR (visibility = 'private' AND owner_user_id = ?)`
  ).all(userId ?? -1)
  return candidates.filter(s => canSeeSound(userId, s))
}

// Árbol de carpetas compatible con el panel: { name, sounds:[{id,file,label}], folders:[...] }
export function tree(rows) {
  const root = { name: '', sounds: [], folders: new Map() }
  for (const s of rows) {
    const parts = s.folder ? s.folder.split('/') : []
    let node = root
    for (const part of parts) {
      if (!node.folders.has(part)) node.folders.set(part, { name: part, sounds: [], folders: new Map() })
      node = node.folders.get(part)
    }
    node.sounds.push({ id: s.id, file: String(s.id), label: s.label })
  }
  const toJSON = n => ({
    name: n.name,
    sounds: n.sounds.sort((a, b) => a.label.localeCompare(b.label, 'es')),
    folders: [...n.folders.values()].sort((a, b) => a.name.localeCompare(b.name, 'es')).map(toJSON),
  })
  return toJSON(root)
}
