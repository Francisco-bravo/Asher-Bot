// Control de acceso por rol: visibilidad y límites de uso de los sonidos.
import { getDb } from './db.mjs'
import * as folders from './folders.mjs'

export function getUserRoleIds(userId) {
  if (!userId) return []
  return getDb().prepare('SELECT role_id FROM user_roles WHERE user_id = ?').all(userId).map(r => r.role_id)
}

export function getUserRoleNames(userId) {
  if (!userId) return []
  return getDb().prepare(
    'SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?'
  ).all(userId).map(r => r.name)
}

export function isAdmin(userId) {
  return getUserRoleNames(userId).includes('admin')
}

function policiesFor(soundId, roleIds) {
  if (!roleIds.length) return []
  const placeholders = roleIds.map(() => '?').join(',')
  return getDb().prepare(
    `SELECT * FROM sound_role_policy WHERE sound_id = ? AND role_id IN (${placeholders})`
  ).all(soundId, ...roleIds)
}

// ¿Puede el usuario VER el botón del sonido?
// `fmeta` (mapa de metadatos de carpetas) opcional para no re-consultar en bucle.
export function canSeeSound(userId, sound, fmeta = null) {
  const admin = isAdmin(userId)
  // Carpeta privada: oculta su subárbol completo a quien no sea su dueño (ni admin).
  if (sound.folder && !admin) {
    const m = fmeta || folders.meta()
    if (!folders.accessibleTo(sound.folder, userId, false, m)) return false
  }
  if (sound.visibility === 'private') return sound.owner_user_id === userId
  if (admin) return true
  const roleIds = getUserRoleIds(userId)
  // Oculto si CUALQUIER rol del usuario lo marca como no visible.
  return !policiesFor(sound.id, roleIds).some(p => p.visible === 0)
}

// Política de límite más permisiva entre los roles del usuario (mayor tope gana).
function effectiveLimit(userId, soundId) {
  const roleIds = getUserRoleIds(userId)
  const pols = policiesFor(soundId, roleIds).filter(p => p.rate_limit != null)
  if (!pols.length) return null // sin límite
  return pols.reduce((best, p) => (p.rate_limit > best.rate_limit ? p : best))
}

// ¿Puede REPRODUCIR ahora? Cuenta el historial dentro de la ventana.
export function canPlaySound(userId, sound) {
  if (!canSeeSound(userId, sound)) return { ok: false, reason: 'hidden' }
  if (isAdmin(userId)) return { ok: true }
  const lim = effectiveLimit(userId, sound.id)
  if (!lim) return { ok: true }
  const since = Date.now() - lim.rate_window_s * 1000
  const used = getDb().prepare(
    `SELECT COUNT(*) AS c FROM play_history
     WHERE user_id = ? AND kind = 'sound' AND ref_id = ? AND played_at >= ?`
  ).get(userId, sound.id, since).c
  return used >= lim.rate_limit
    ? { ok: false, reason: 'rate_limit', limit: lim.rate_limit, windowS: lim.rate_window_s }
    : { ok: true, remaining: lim.rate_limit - used }
}
