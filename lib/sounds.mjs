// Biblioteca de sonidos. Política: TODOS los sonidos viven siempre en disco
// local (espejo en data/sounds/); el object-store es solo respaldo durable y
// destino de los uploads. La reproducción nunca toca la red → latencia mínima.
import { existsSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, now } from './db.mjs'
import { getStore } from './storage/index.mjs'
import { paths } from './config.mjs'
import { canSeeSound } from './rbac.mjs'
import * as folders from './folders.mjs'
import { analyzeFile } from './loudness.mjs'

export function localPath(sound) {
  return join(paths.sounds, `${sound.id}.${sound.ext}`)
}

function objectKey(id, ext) { return `sounds/${id}.${ext}` }

// Sube un sonido: object-store (respaldo) + espejo local (listo para sonar ya).
export async function upload({ ownerUserId = null, label, folder = '', ext, buffer, durationMs = null, visibility = 'global', guildId = null }) {
  const db = getDb()
  const ts = now()
  const info = db.prepare(
    `INSERT INTO sounds (owner_user_id, label, folder, object_key, ext, size_bytes, duration_ms, visibility, guild_id, created_at)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?)`
  ).run(ownerUserId, label, folder, ext, buffer.length, durationMs, visibility, guildId, ts)
  const id = Number(info.lastInsertRowid)
  const key = objectKey(id, ext)
  db.prepare('UPDATE sounds SET object_key = ? WHERE id = ?').run(key, id)

  await getStore().put(key, buffer)          // respaldo durable
  writeFileSync(localPath({ id, ext }), buffer) // espejo local inmediato
  // Mide su sonoridad para igualar el volumen con el resto (no bloquea si falla).
  try { await analyzeAndStore(id) } catch { /* se reintenta luego */ }
  return getById(id)
}

export function getById(id) {
  return getDb().prepare('SELECT * FROM sounds WHERE id = ?').get(id)
}

// Reemplaza el AUDIO de un sonido existente (p. ej. tras recortarlo en el
// navegador): re-sube al object-store, refresca el espejo local, resetea
// duración/ganancia y vuelve a medir el loudness. Mantiene id/label/carpeta.
export async function replaceAudio(soundId, ext, buffer) {
  const s = getById(soundId)
  if (!s) throw new Error('Sonido no encontrado')
  const store = getStore()
  const newKey = objectKey(soundId, ext)
  if (s.object_key && s.object_key !== newKey) { try { await store.delete(s.object_key) } catch { /* puede no existir */ } }
  if (s.ext !== ext) { try { rmSync(localPath(s), { force: true }) } catch { /* idem */ } }
  await store.put(newKey, buffer)
  writeFileSync(localPath({ id: soundId, ext }), buffer)
  getDb().prepare('UPDATE sounds SET object_key = ?, ext = ?, size_bytes = ?, duration_ms = NULL, gain_db = NULL WHERE id = ?')
    .run(newKey, ext, buffer.length, soundId)
  try { await analyzeAndStore(soundId) } catch { /* se reintenta en el barrido */ }
  return getById(soundId)
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
// `guildId`: servidor activo. Se ven los TRANSVERSALES (guild_id NULL) + los de
// ESE servidor. Con `includeOther`, además los públicos (global) de otros servidores.
export function listForUser(userId, guildId = null, includeOther = false) {
  const db = getDb()
  const candidates = db.prepare(
    `SELECT s.*, COALESCE(u.display_name, u.username) AS owner_name,
            p.alias AS alias, COALESCE(p.hidden, 0) AS hidden, p.folder AS pref_folder
       FROM sounds s
       LEFT JOIN users u ON u.id = s.owner_user_id
       LEFT JOIN user_sound_prefs p ON p.sound_id = s.id AND p.user_id = ?
      WHERE s.hidden = 0
        AND (s.visibility = 'global' OR (s.visibility = 'private' AND s.owner_user_id = ?))
        AND (s.guild_id IS NULL OR s.guild_id = ?
             OR (? = 1 AND s.guild_id IS NOT NULL AND s.visibility = 'global'))`
  ).all(userId ?? -1, userId ?? -1, guildId, includeOther ? 1 : 0)
  // Gate de carpeta privada incluido en canSeeSound (usa la carpeta REAL del
  // sonido). Cargamos el meta una sola vez para todo el filtro.
  const fmeta = folders.meta()
  const visible = candidates.filter(s => canSeeSound(userId, s, fmeta))
  // Override de carpeta PERSONAL (mover solo para mí): no afecta permisos, solo
  // dónde lo ve este usuario en el árbol. Se aplica DESPUÉS del filtro.
  for (const s of visible) if (s.pref_folder != null) s.folder = s.pref_folder
  return visible
}

// Mueve un sonido de carpeta de forma GLOBAL (admin): cambia su folder real.
export function moveSoundGlobal(soundId, folder) {
  getDb().prepare('UPDATE sounds SET folder = ? WHERE id = ?').run(folder || '', soundId)
}

// Mueve un sonido SOLO para un usuario (overlay): guarda su carpeta personal.
// folder vacío/NULL = quita el override (vuelve a su carpeta real).
export function setSoundFolder(userId, soundId, folder) {
  const f = (folder || '').trim() || null
  getDb().prepare(
    `INSERT INTO user_sound_prefs (user_id, sound_id, folder, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, sound_id) DO UPDATE SET folder = excluded.folder, updated_at = excluded.updated_at`
  ).run(userId, soundId, f, now())
}

// Listado para el panel de Gestión (admin): sonidos a administrar, incluidos los
// ocultos globalmente. El campo `hidden` es el ocultar GLOBAL (sounds.hidden),
// para pintarlos en gris. `guildId`: servidor activo → transversales (guild_id
// NULL) + los de ESE servidor; con `includeOther` (super admin), TODOS los
// servidores. Así un admin por-servidor solo gestiona lo suyo.
export function listAllForAdmin(guildId = null, includeOther = false) {
  return getDb().prepare(
    `SELECT s.*, COALESCE(u.display_name, u.username) AS owner_name, NULL AS alias
       FROM sounds s
       LEFT JOIN users u ON u.id = s.owner_user_id
      WHERE (? = 1 OR s.guild_id IS NULL OR s.guild_id = ?)
      ORDER BY s.label COLLATE NOCASE`
  ).all(includeOther ? 1 : 0, guildId)
}

// Renombra el label real de un sonido (afecta a todos). Devuelve el sonido.
export function renameSound(soundId, label) {
  const clean = (label || '').trim()
  if (!clean) throw new Error('Nombre vacío')
  getDb().prepare('UPDATE sounds SET label = ? WHERE id = ?').run(clean, soundId)
  return getById(soundId)
}

// Oculta/restaura un sonido para TODOS (soft delete global).
export function setGlobalHidden(soundId, hidden) {
  getDb().prepare('UPDATE sounds SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, soundId)
}

// Elimina un sonido de forma permanente: object-store + espejo local + DB
// (las prefs y políticas por rol caen por ON DELETE CASCADE).
export async function deleteSound(soundId) {
  const s = getById(soundId)
  if (!s) return false
  try { await getStore().delete(s.object_key) } catch { /* respaldo puede no existir */ }
  try { rmSync(localPath(s), { force: true }) } catch { /* idem */ }
  getDb().prepare('DELETE FROM sounds WHERE id = ?').run(soundId)
  return true
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
// y de quién es el sonido. Filtrado por servidor activo igual que listAllForAdmin.
export function allAliases(guildId = null, includeOther = false) {
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
        AND (? = 1 OR s.guild_id IS NULL OR s.guild_id = ?)
      ORDER BY p.updated_at DESC`
  ).all(includeOther ? 1 : 0, guildId)
}

// Registro de sonidos subidos por usuarios (los que tienen dueño), para auditoría.
// Filtrado por servidor activo igual que listAllForAdmin.
export function allUploads(guildId = null, includeOther = false) {
  return getDb().prepare(
    `SELECT s.id, s.label, s.folder, s.visibility, s.hidden, s.created_at,
            COALESCE(u.display_name, u.username) AS owner_name
       FROM sounds s
       JOIN users u ON u.id = s.owner_user_id
      WHERE (? = 1 OR s.guild_id IS NULL OR s.guild_id = ?)
      ORDER BY s.created_at DESC`
  ).all(includeOther ? 1 : 0, guildId)
}

// Cambia la visibilidad de un sonido (admin): 'global' (público) | 'private'.
export function setVisibility(soundId, visibility) {
  const v = visibility === 'private' ? 'private' : 'global'
  getDb().prepare('UPDATE sounds SET visibility = ? WHERE id = ?').run(v, soundId)
}

// Asigna el servidor de un sonido. guildId NULL = TRANSVERSAL (visible en todos).
// Solo lo usan super admin / admin multiservidor.
export function setGuild(soundId, guildId) {
  getDb().prepare('UPDATE sounds SET guild_id = ? WHERE id = ?').run(guildId || null, soundId)
}

// ── Normalización de volumen ─────────────────────────────────────────────────
// Guarda la ganancia medida (loudness). NULL → marca como "no medido".
export function setGain(soundId, gainDb) {
  getDb().prepare('UPDATE sounds SET gain_db = ? WHERE id = ?').run(gainDb == null ? null : Number(gainDb), soundId)
}

// Ajuste manual del admin (se suma a la ganancia medida al reproducir).
export function setGainOffset(soundId, offsetDb) {
  const v = Number(offsetDb)
  getDb().prepare('UPDATE sounds SET gain_offset_db = ? WHERE id = ?').run(Number.isFinite(v) ? v : 0, soundId)
}

// Analiza un sonido por su archivo local y guarda la ganancia. Devuelve la ganancia
// o null si no se pudo medir.
export async function analyzeAndStore(soundId) {
  const s = getById(soundId)
  if (!s) return null
  const lp = localPath(s)
  if (!existsSync(lp)) return null
  const r = await analyzeFile(lp)
  if (!r) return null
  setGain(soundId, r.gainDb)
  return r.gainDb
}

// Revisa todos los sonidos y mide su volumen. `force`: re-mide también los ya
// medidos; si no, solo los que falten. `onProgress(hechos, total)` opcional.
// Secuencial a propósito (un ffmpeg a la vez) para no saturar la VM.
export async function normalizeAll({ force = false, onProgress } = {}) {
  const rows = getDb().prepare(
    `SELECT id FROM sounds${force ? '' : ' WHERE gain_db IS NULL'} ORDER BY id`
  ).all()
  let done = 0
  for (const { id } of rows) {
    try { await analyzeAndStore(id) } catch { /* sigue con el resto */ }
    done++
    if (onProgress) onProgress(done, rows.length)
  }
  return { analyzed: done, total: rows.length }
}

// Árbol de carpetas compatible con el panel: { name, sounds:[{id,file,label}], folders:[...] }
// `extraFolders` (rutas "a/b/c") siembra carpetas aunque no tengan sonidos, para
// que aparezcan las carpetas vacías creadas explícitamente.
// `folderAliases` { ruta: nombre } aplica renombres PERSONALES: cambia solo el
// nombre mostrado (`display`); la ruta real (`name`/`path`) no cambia.
// `folderMeta` { ruta: {owner,color,visibility} } y `viewerId` añaden a cada
// carpeta: color, visibility y mine (¿la creó este usuario?), para la UI.
export function tree(rows, extraFolders = [], folderAliases = {}, folderMeta = {}, viewerId = null) {
  const root = { name: '', path: '', sounds: [], folders: new Map() }
  const ensure = (parts) => {
    let node = root, acc = ''
    for (const part of parts) {
      acc = acc ? acc + '/' + part : part
      if (!node.folders.has(part)) node.folders.set(part, { name: part, path: acc, sounds: [], folders: new Map() })
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
      guildId: s.guild_id ?? null, // NULL = transversal
      alias: s.alias || null, hidden: s.hidden ? 1 : 0,
      gainDb: s.gain_db == null ? null : Number(s.gain_db),
      gainOffset: s.gain_offset_db == null ? 0 : Number(s.gain_offset_db),
    })
  }
  const toJSON = n => {
    const fm = folderMeta[n.path] || null
    return {
      name: n.name,
      path: n.path,
      display: folderAliases[n.path] || n.name,
      color: fm ? fm.color : null,
      visibility: fm ? fm.visibility : 'public',
      mine: !!(fm && viewerId != null && fm.owner === viewerId),
      sounds: n.sounds.sort((a, b) => a.label.localeCompare(b.label, 'es')),
      folders: [...n.folders.values()].sort((a, b) => a.name.localeCompare(b.name, 'es')).map(toJSON),
    }
  }
  return toJSON(root)
}
