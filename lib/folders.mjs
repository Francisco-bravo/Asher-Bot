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
export function list() {
  const db = getDb()
  const fromFolders = db.prepare('SELECT path FROM folders').all().map(r => r.path)
  const fromSounds = db.prepare("SELECT DISTINCT folder FROM sounds WHERE folder <> ''").all().map(r => r.folder)
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
export function create(path) {
  const clean = normalizePath(path)
  if (!clean) throw new Error('Ruta de carpeta vacía')
  const db = getDb()
  for (const p of withAncestors(clean)) {
    db.prepare('INSERT OR IGNORE INTO folders (path, created_at) VALUES (?, ?)').run(p, now())
  }
  return clean
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
