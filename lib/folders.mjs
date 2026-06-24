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
