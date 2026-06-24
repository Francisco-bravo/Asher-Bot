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

// Últimas reproducciones de TODOS los usuarios (panel de administración), con
// quién las disparó (nombre + avatar) y la etiqueta/título de lo reproducido.
export function recentDetailed({ limit = 20 } = {}) {
  return getDb().prepare(
    `SELECT h.id, h.kind, h.ref_id, h.played_at,
            COALESCE(u.display_name, u.username) AS user_name,
            u.avatar_url AS user_avatar,
            CASE h.kind WHEN 'song' THEN s.title ELSE snd.label END AS title
       FROM play_history h
       LEFT JOIN users  u   ON u.id   = h.user_id
       LEFT JOIN songs  s   ON h.kind = 'song'  AND s.id   = h.ref_id
       LEFT JOIN sounds snd ON h.kind = 'sound' AND snd.id = h.ref_id
      ORDER BY h.played_at DESC
      LIMIT ?`
  ).all(limit)
}

// Ranking de los sonidos más reproducidos: nº de reproducciones y nº de usuarios
// distintos que los dispararon. Alimenta el "top ajustable" (5/10/20) del panel.
export function topSounds({ limit = 10 } = {}) {
  return getDb().prepare(
    `SELECT snd.id AS ref_id, snd.label AS title,
            COUNT(*) AS plays,
            COUNT(DISTINCT h.user_id) AS users
       FROM play_history h
       JOIN sounds snd ON snd.id = h.ref_id
      WHERE h.kind = 'sound'
      GROUP BY h.ref_id
      ORDER BY plays DESC, title ASC
      LIMIT ?`
  ).all(limit)
}

export function countInWindow({ userId, kind, refId, windowS }) {
  const since = Date.now() - windowS * 1000
  return getDb().prepare(
    'SELECT COUNT(*) AS c FROM play_history WHERE user_id = ? AND kind = ? AND ref_id = ? AND played_at >= ?'
  ).get(userId, kind, refId, since).c
}
