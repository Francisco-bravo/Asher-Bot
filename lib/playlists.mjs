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

export function rename(id, name) {
  getDb().prepare('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), id)
  return get(id)
}

export function remove(id) {
  getDb().prepare('DELETE FROM playlists WHERE id = ?').run(id)
}

export function addItem(playlistId, songId) {
  const db = getDb()
  const pos = (db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM playlist_items WHERE playlist_id = ?').get(playlistId).m) + 1
  db.prepare('INSERT INTO playlist_items (playlist_id, song_id, position, added_at) VALUES (?, ?, ?, ?)')
    .run(playlistId, songId, pos, now())
  db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now(), playlistId)
}

export function items(playlistId) {
  return getDb().prepare(
    `SELECT pi.*, s.title, s.artist, s.duration_ms, s.source_url
     FROM playlist_items pi JOIN songs s ON s.id = pi.song_id
     WHERE pi.playlist_id = ? ORDER BY pi.position`
  ).all(playlistId)
}

export function removeItem(itemId) {
  getDb().prepare('DELETE FROM playlist_items WHERE id = ?').run(itemId)
}
