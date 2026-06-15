// Historial de reproducciones (música y sonidos).
import { getDb, now } from './db.mjs'

export function record({ userId = null, kind, refId, guildId = null }) {
  getDb().prepare(
    'INSERT INTO play_history (user_id, kind, ref_id, guild_id, played_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, kind, refId, guildId, now())
}

// Últimas reproducciones, enriquecidas con título/etiqueta.
export function recent({ userId = null, limit = 20 } = {}) {
  const db = getDb()
  const where = userId ? 'WHERE h.user_id = ?' : ''
  const args = userId ? [userId, limit] : [limit]
  return db.prepare(
    `SELECT h.*,
            CASE h.kind WHEN 'song' THEN s.title ELSE snd.label END AS title
     FROM play_history h
     LEFT JOIN songs  s   ON h.kind = 'song'  AND s.id   = h.ref_id
     LEFT JOIN sounds snd ON h.kind = 'sound' AND snd.id = h.ref_id
     ${where}
     ORDER BY h.played_at DESC
     LIMIT ?`
  ).all(...args)
}

export function countInWindow({ userId, kind, refId, windowS }) {
  const since = Date.now() - windowS * 1000
  return getDb().prepare(
    'SELECT COUNT(*) AS c FROM play_history WHERE user_id = ? AND kind = ? AND ref_id = ? AND played_at >= ?'
  ).get(userId, kind, refId, since).c
}
