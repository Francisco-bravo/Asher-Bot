// Carpetas del soundboard. Persistidas en la tabla `folders` para permitir
// carpetas vacías y crearlas explícitamente; la lista que se expone mezcla las
// carpetas guardadas con las derivadas de los sonidos (y todos sus ancestros),
// de modo que el árbol siempre sea consistente.
import { getDb, now } from './db.mjs'

// Normaliza una ruta: recorta cada segmento, quita caracteres problemáticos y
// descarta los vacíos. "  Memes / Risas/ " -> "Memes/Risas".
export function normalizePath(path) {
  return String(path || '')
    .split('/')
    .map(s => s.trim().replace(/[\\:*?"<>|]/g, '').trim())
    .filter(Boolean)
    .join('/')
}

// Devuelve cada ruta y todas sus rutas ancestro. "a/b/c" -> ["a","a/b","a/b/c"].
function withAncestors(path) {
  const out = []
  let acc = ''
  for (const part of path.split('/')) { acc = acc ? acc + '/' + part : part; out.push(acc) }
  return out
}

// Todas las rutas de carpeta conocidas (tabla + derivadas de sonidos), ordenadas.
// `guildId`: si se da, solo carpetas TRANSVERSALES (guild_id NULL) o de ese
// servidor — y solo las derivadas de sonidos transversales/de ese servidor. Así
// el árbol del soundboard no muestra carpetas de otros servidores.
export function list(guildId = undefined) {
  const db = getDb()
  const scoped = guildId !== undefined
  const fromFolders = (scoped
    ? db.prepare('SELECT path FROM folders WHERE guild_id IS NULL OR guild_id = ?').all(guildId)
    : db.prepare('SELECT path FROM folders').all()).map(r => r.path)
  const fromSounds = (scoped
    ? db.prepare("SELECT DISTINCT folder FROM sounds WHERE folder <> '' AND (guild_id IS NULL OR guild_id = ?)").all(guildId)
    : db.prepare("SELECT DISTINCT folder FROM sounds WHERE folder <> ''").all()).map(r => r.folder)
  const all = new Set()
  for (const p of [...fromFolders, ...fromSounds]) {
    if (p) for (const a of withAncestors(p)) all.add(a)
  }
  return [...all].sort((a, b) => a.localeCompare(b, 'es'))
}

// Renombra una carpeta (afecta a TODOS): cambia el último segmento de `oldPath`
// por `newName`, arrastrando su subárbol. Actualiza tanto `folders` como el
// `folder` de los sonidos que cuelgan de ella. Devuelve la nueva ruta.
export function rename(oldPath, newName) {
  const old = normalizePath(oldPath)
  if (!old) throw new Error('Carpeta inválida')
  const leaf = normalizePath(newName)
  if (!leaf || leaf.includes('/')) throw new Error('Nombre de carpeta inválido')
  const parts = old.split('/')
  parts[parts.length - 1] = leaf
  const next = parts.join('/')
  if (next === old) return old
  const db = getDb()
  const prefix = old + '/'
  // Subárbol: la carpeta exacta y todas sus descendientes. SUBSTR recorta el viejo
  // prefijo y antepone el nuevo, preservando la profundidad.
  db.prepare(
    `UPDATE folders SET path = ? || SUBSTR(path, ?) WHERE path = ? OR path LIKE ? ESCAPE '\\'`
  ).run(next, old.length + 1, old, prefix.replace(/[%_\\]/g, '\\$&') + '%')
  db.prepare(
    `UPDATE sounds SET folder = ? || SUBSTR(folder, ?) WHERE folder = ? OR folder LIKE ? ESCAPE '\\'`
  ).run(next, old.length + 1, old, prefix.replace(/[%_\\]/g, '\\$&') + '%')
  // Asegura que la carpeta renombrada exista en la tabla aunque estuviera vacía.
  for (const p of withAncestors(next)) {
    db.prepare('INSERT OR IGNORE INTO folders (path, created_at) VALUES (?, ?)').run(p, now())
  }
  return next
}

// Crea una carpeta y todos sus ancestros si faltan. Devuelve la ruta normalizada.
// opts.{ownerUserId,color,visibility} se aplican SOLO a la carpeta hoja recién
// creada (si ya existía, no se pisan sus propiedades).
export function create(path, opts = {}) {
  const clean = normalizePath(path)
  if (!clean) throw new Error('Ruta de carpeta vacía')
  const db = getDb()
  const existed = !!db.prepare('SELECT 1 FROM folders WHERE path = ?').get(clean)
  for (const p of withAncestors(clean)) {
    db.prepare('INSERT OR IGNORE INTO folders (path, created_at) VALUES (?, ?)').run(p, now())
  }
  if (!existed && (opts.ownerUserId != null || opts.color != null || opts.visibility || opts.guildId != null)) {
    const vis = opts.visibility === 'private' ? 'private' : 'public'
    db.prepare('UPDATE folders SET owner_user_id = ?, color = ?, visibility = ?, guild_id = ? WHERE path = ?')
      .run(opts.ownerUserId ?? null, opts.color ?? null, vis, opts.guildId ?? null, clean)
  }
  return clean
}

// ── Propiedades de carpeta: dueño, color, visibilidad (público/privado) ───────
// Mapa { ruta: { owner, color, visibility } } de todas las carpetas con fila.
export function meta() {
  const out = {}
  for (const r of getDb().prepare('SELECT path, owner_user_id, color, visibility FROM folders').all()) {
    out[r.path] = { owner: r.owner_user_id ?? null, color: r.color || null, visibility: r.visibility || 'public' }
  }
  return out
}

// Cambia color/visibilidad de una carpeta. Solo su dueño o un admin; las carpetas
// heredadas (sin dueño) solo las cambia un admin.
export function setProps(path, { color, visibility }, userId, isAdmin) {
  const clean = normalizePath(path)
  if (!clean) throw new Error('Carpeta inválida')
  const db = getDb()
  let f = db.prepare('SELECT owner_user_id FROM folders WHERE path = ?').get(clean)
  if (!f) {
    // Carpeta derivada de sonidos (sin fila propia aún): solo un admin puede
    // fijarle propiedades; se crea su fila (sin dueño) al vuelo.
    if (!isAdmin) throw new Error('No es tu carpeta')
    db.prepare('INSERT OR IGNORE INTO folders (path, created_at) VALUES (?, ?)').run(clean, now())
    f = { owner_user_id: null }
  }
  if (!isAdmin && (f.owner_user_id == null || f.owner_user_id !== userId)) throw new Error('No es tu carpeta')
  const sets = [], vals = []
  if (color !== undefined) { sets.push('color = ?'); vals.push(color || null) }
  if (visibility !== undefined) { sets.push('visibility = ?'); vals.push(visibility === 'private' ? 'private' : 'public') }
  if (!sets.length) return
  vals.push(clean)
  db.prepare(`UPDATE folders SET ${sets.join(', ')} WHERE path = ?`).run(...vals)
}

// ¿Algún ancestro (o la propia carpeta) es privado? → su subárbol es privado.
export function isPrivatePath(path, metaMap) {
  for (const a of withAncestors(normalizePath(path))) {
    const m = metaMap[a]
    if (m && m.visibility === 'private') return true
  }
  return false
}

// ¿El usuario puede ENTRAR a esta carpeta? Sí, salvo que algún ancestro (o ella
// misma) sea privado y NO le pertenezca. Un admin lo ve todo.
export function accessibleTo(path, userId, isAdmin, metaMap) {
  if (isAdmin) return true
  for (const a of withAncestors(normalizePath(path || ''))) {
    if (!a) continue
    const m = metaMap[a]
    if (m && m.visibility === 'private' && m.owner !== userId) return false
  }
  return true
}

// Rutas de carpeta visibles para un usuario (filtra subárboles privados ajenos).
// `guildId` (opcional): limita a carpetas transversales o del servidor activo.
export function listFor(userId, isAdmin, guildId = undefined) {
  const m = meta()
  return list(guildId).filter(p => accessibleTo(p, userId, isAdmin, m))
}

// Elimina una carpeta (y sus descendientes) si no tiene sonidos asociados.
export function deleteFolder(path) {
  const clean = normalizePath(path)
  if (!clean) throw new Error('Carpeta inválida')
  const db = getDb()
  const prefix = clean + '/'
  const escaped = prefix.replace(/[%_\\]/g, '\\$&') + '%'
  const hasSounds = db.prepare(
    "SELECT 1 FROM sounds WHERE folder = ? OR folder LIKE ? ESCAPE '\\'"
  ).get(clean, escaped)
  if (hasSounds) throw new Error('La carpeta contiene sonidos; vacíala primero')
  db.prepare("DELETE FROM folders WHERE path = ? OR path LIKE ? ESCAPE '\\'").run(clean, escaped)
}

// ── Renombre PERSONAL de carpeta (overlay por-usuario) ───────────────────────
// El usuario cambia el nombre mostrado de una carpeta SOLO para sí mismo. La ruta
// real no cambia (sigue siendo la clave). Alias vacío = se quita el override.
export function setUserAlias(userId, path, alias) {
  const clean = normalizePath(path)
  if (!clean) throw new Error('Carpeta inválida')
  const leaf = String(alias || '').trim().replace(/[\\/:*?"<>|]/g, '').trim()
  const db = getDb()
  if (!leaf) {
    db.prepare('DELETE FROM user_folder_prefs WHERE user_id = ? AND path = ?').run(userId, clean)
    return
  }
  db.prepare(
    `INSERT INTO user_folder_prefs (user_id, path, alias, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, path) DO UPDATE SET alias = excluded.alias, updated_at = excluded.updated_at`
  ).run(userId, clean, leaf, now())
}

// Mapa { ruta: alias } con los renombres personales del usuario (para mostrar).
export function aliasesForUser(userId) {
  const out = {}
  if (!userId) return out
  for (const r of getDb().prepare('SELECT path, alias FROM user_folder_prefs WHERE user_id = ?').all(userId)) {
    out[r.path] = r.alias
  }
  return out
}
