// Ingesta inicial: carga los sonidos existentes de dev/sounds/ a la capa nueva
// (DB + object-store + espejo local), conservando la estructura de carpetas.
// Idempotente: si un sonido (folder+label+ext) ya está, lo omite.
import { readdirSync, readFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE = process.argv[2] || join(ROOT, 'sounds')
const SOUND_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.webm'])

const { getDb } = await import('../lib/db.mjs')
const sounds = await import('../lib/sounds.mjs')

const db = getDb()
const exists = db.prepare('SELECT 1 FROM sounds WHERE folder = ? AND label = ? AND ext = ?')

// Recolectar archivos (ruta relativa con '/')
const files = []
const walk = (dir, rel) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) walk(join(dir, e.name), r)
    else if (SOUND_EXTS.has(extname(e.name).toLowerCase())) files.push(r)
  }
}
walk(SOURCE, '')
files.sort((a, b) => a.localeCompare(b, 'es'))

console.log(`\nOrigen: ${SOURCE}`)
console.log(`Encontrados: ${files.length} sonidos\n`)

let added = 0, skipped = 0
for (const rel of files) {
  const parts = rel.split('/')
  const filename = parts.pop()
  const folder = parts.join('/')
  const ext = extname(filename).slice(1).toLowerCase()
  const label = filename.replace(/\.[^.]+$/, '')

  if (exists.get(folder, label, ext)) { skipped++; continue }

  const buffer = readFileSync(join(SOURCE, rel))
  const s = await sounds.upload({ label, folder, ext, buffer, visibility: 'global' })
  added++
  if (added % 25 === 0) console.log(`  ... ${added} cargados`)
  void s
}

const total = db.prepare('SELECT COUNT(*) AS c FROM sounds').get().c
console.log(`\n${'='.repeat(40)}`)
console.log(`Nuevos: ${added}  ·  Omitidos (ya existían): ${skipped}`)
console.log(`Total en DB: ${total}`)
console.log(`Carpetas: ${[...new Set(files.map(f => f.split('/').slice(0, -1).join('/')).filter(Boolean))].length}`)
console.log(`${'='.repeat(40)}\n`)
