// Revisa TODOS los sonidos y mide su volumen (loudness EBU R128) para igualarlos.
// Guarda la ganancia por sonido (no toca los archivos); se aplica al reproducir.
// Uso:
//   node scripts/normalize-sounds.mjs          → solo los que faltan (sin medir)
//   node scripts/normalize-sounds.mjs --force   → re-mide TODOS
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
try { process.loadEnvFile(join(ROOT, '.env')) } catch { /* vars del entorno */ }

const { getDb } = await import('../lib/db.mjs')
const sounds = await import('../lib/sounds.mjs')

const force = process.argv.includes('--force')
getDb()

console.log(`Midiendo volumen de sonidos (${force ? 'todos' : 'solo los que falten'})…`)
const r = await sounds.normalizeAll({
  force,
  onProgress: (done, total) => process.stdout.write(`\r  ${done}/${total}`),
})
console.log(`\nListo: ${r.analyzed} sonidos medidos de ${r.total}.`)
process.exit(0)
