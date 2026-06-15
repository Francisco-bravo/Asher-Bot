// Usuarios y sesiones. El handshake OAuth de Discord vive en la capa web;
// aquí solo el alta/actualización de usuarios y la gestión de sesiones.
import { randomBytes } from 'node:crypto'
import { getDb, now } from './db.mjs'

const DEFAULT_TTL = 30 * 24 * 60 * 60 * 1000 // 30 días

export function upsertUserByDiscord({ discordId, username, displayName = null, avatarUrl = null }) {
  const db = getDb()
  const existing = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId)
  if (existing) {
    db.prepare('UPDATE users SET username = ?, display_name = ?, avatar_url = ?, last_login_at = ? WHERE id = ?')
      .run(username, displayName, avatarUrl, now(), existing.id)
    return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id)
  }
  const info = db.prepare(
    'INSERT INTO users (discord_id, username, display_name, avatar_url, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(discordId, username, displayName, avatarUrl, now(), now())
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid))
}

export function assignRole(userId, roleName) {
  const db = getDb()
  const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName)
  if (!role) throw new Error(`Rol desconocido: ${roleName}`)
  db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(userId, role.id)
}

export function createSession(userId, ttlMs = DEFAULT_TTL) {
  const token = randomBytes(32).toString('hex')
  getDb().prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now(), now() + ttlMs)
  return token
}

export function getSession(token) {
  const row = getDb().prepare('SELECT * FROM sessions WHERE token = ?').get(token)
  if (!row) return null
  if (row.expires_at < now()) { deleteSession(token); return null }
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(row.user_id)
}

export function deleteSession(token) {
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token)
}
