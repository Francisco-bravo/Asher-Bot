// Listas de reproducción por usuario.
import { getDb, now } from './db.mjs'

export function create(ownerUserId, name, visibility = 'private') {
  const ts = now()
  const info = getDb().prepare(
    'INSERT INTO playlists (owner_user_id, name, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(ownerUserId, name, visibility, ts, ts)
  return get(Number(info.lastInsertRowid))
}

export function get(id) {
  return getDb().prepare('SELECT * FROM playlists WHERE id = ?').get(id)
}

export function listForUser(ownerUserId) {
  return getDb().prepare('SELECT * FROM playlists WHERE owner_user_id = ? ORDER BY updated_at DESC').all(ownerUserId)
}

// Todas las listas con el autor (nombre/avatar) y el número de canciones, para
// que la Biblioteca las muestre con su creador.
export function listAllWithOwner() {
  const db = getDb()
  const rows = db.prepare(
    `SELECT p.id, p.owner_user_id, p.name, p.visibility, p.created_at, p.updated_at,
            u.display_name AS owner_name, u.username AS owner_username, u.avatar_url AS owner_avatar,
            (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id) AS item_count
     FROM playlists p JOIN users u ON u.id = p.owner_user_id
     ORDER BY p.updated_at DESC`
  ).all()
  // Carátula tipo YouTube Music: las primeras 4 canciones (el front ya resuelve
  // /art/:id con placeholder si alguna no tiene carátula — song_id ahora es del
  // worker, no se puede filtrar "con arte" barato desde acá sin ida y vuelta).
  const coverStmt = db.prepare(
    `SELECT song_id AS id FROM playlist_items WHERE playlist_id = ? ORDER BY position LIMIT 4`
  )
  for (const r of rows) r.cover_ids = coverStmt.all(r.id).map(x => x.id)
  return rows
}

export function rename(id, name) {
  getDb().prepare('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), id)
  return get(id)
}

export function remove(id) {
  getDb().prepare('DELETE FROM playlists WHERE id = ?').run(id)
}

// `song` = la fila de la canción (del worker) para denormalizar título/artista/
// duración/url directo en el ítem — ya no depende de un JOIN a songs.
export function addItem(playlistId, songId, song = {}) {
  const db = getDb()
  const pos = (db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM playlist_items WHERE playlist_id = ?').get(playlistId).m) + 1
  db.prepare(
    `INSERT INTO playlist_items (playlist_id, song_id, title, artist, duration_ms, source_url, position, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(playlistId, songId, song.title ?? null, song.artist ?? null, song.duration_ms ?? null, song.source_url ?? null, pos, now())
  db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now(), playlistId)
}

export function items(playlistId) {
  return getDb().prepare(
    'SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position'
  ).all(playlistId)
}

export function removeItem(itemId) {
  getDb().prepare('DELETE FROM playlist_items WHERE id = ?').run(itemId)
}
