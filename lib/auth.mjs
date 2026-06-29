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

// guildId NULL = rol GLOBAL (todos los servidores); '<id>' = solo ese servidor.
export function assignRole(userId, roleName, guildId = null) {
  const db = getDb()
  const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName)
  if (!role) throw new Error(`Rol desconocido: ${roleName}`)
  db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, guild_id) VALUES (?, ?, ?)').run(userId, role.id, guildId)
}

export function removeRole(userId, roleName, guildId = null) {
  const db = getDb()
  const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName)
  if (!role) throw new Error(`Rol desconocido: ${roleName}`)
  // Con guildId: quita solo ese ámbito. Sin él: quita TODAS las asignaciones del rol.
  if (guildId === undefined || guildId === '__all__') {
    db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?').run(userId, role.id)
  } else {
    db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ? AND IFNULL(guild_id, \'\') = IFNULL(?, \'\')')
      .run(userId, role.id, guildId)
  }
}

// Super administrador global (gestiona admins de todos los servidores).
export function isSuperUser(userId) {
  const r = getDb().prepare('SELECT is_super FROM users WHERE id = ?').get(userId)
  return !!(r && r.is_super)
}
export function setSuper(userId, isSuper) {
  getDb().prepare('UPDATE users SET is_super = ? WHERE id = ?').run(isSuper ? 1 : 0, userId)
}

// Usuario por su id de Discord (snowflake). Útil para mapear miembros de Discord
// (voz, comandos) a la fila interna y sus roles.
export function getUserByDiscordId(discordId) {
  if (!discordId) return null
  return getDb().prepare('SELECT * FROM users WHERE discord_id = ?').get(String(discordId))
}

// Todos los usuarios con sus roles, para la gestión administrativa.
export function listUsers() {
  const db = getDb()
  const users = db.prepare(
    `SELECT id, discord_id, username, display_name, avatar_url, created_at, last_login_at, is_super
     FROM users ORDER BY COALESCE(last_login_at, created_at) DESC`
  ).all()
  const roleRows = db.prepare(
    'SELECT ur.user_id, ur.guild_id, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id'
  ).all()
  const globals = new Map()  // user_id -> [role名 globales] (compat con la UI actual)
  const scopes = new Map()   // user_id -> [{name, guildId}]
  for (const r of roleRows) {
    if (!scopes.has(r.user_id)) scopes.set(r.user_id, [])
    scopes.get(r.user_id).push({ name: r.name, guildId: r.guild_id ?? null })
    if (r.guild_id == null) {
      if (!globals.has(r.user_id)) globals.set(r.user_id, [])
      globals.get(r.user_id).push(r.name)
    }
  }
  return users.map(u => ({
    ...u,
    isSuper: !!u.is_super,
    roles: globals.get(u.id) || [],       // roles GLOBALES (compatibilidad)
    roleScopes: scopes.get(u.id) || [],   // detalle por servidor (super admin UI)
  }))
}

// Cuántos "admins plenos" hay (super o admin global): para no quedarse sin ninguno.
export function countAdmins() {
  return getDb().prepare(
    `SELECT COUNT(*) AS c FROM users u
      WHERE u.is_super = 1
         OR u.id IN (SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                      WHERE r.name = 'admin' AND ur.guild_id IS NULL)`
  ).get().c
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
