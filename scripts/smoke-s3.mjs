// Prueba el backend de object-store S3/R2 contra el bucket real.
// Lee las credenciales del entorno (S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET).
// Hace put/exists/getStream/getToFile/delete sobre una clave temporal y limpia al final.
//
// Uso (en la VM, con las vars exportadas o vía .env del servicio):
//   STORAGE_BACKEND=s3 S3_ENDPOINT=... S3_BUCKET=... S3_ACCESS_KEY=... S3_SECRET=... \
//   node scripts/smoke-s3.mjs
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.STORAGE_BACKEND = 's3'

const { config } = await import('../lib/config.mjs')
const { getStore } = await import('../lib/storage/index.mjs')

function need(name, val) { if (!val) { console.error(`Falta ${name}`); process.exit(1) } }
need('S3_ENDPOINT', config.s3.endpoint)
need('S3_BUCKET', config.s3.bucket)
need('S3_ACCESS_KEY', config.s3.accessKey)
need('S3_SECRET', config.s3.secret)

const store = getStore()
if (store.kind !== 's3') { console.error('El store no es s3 (¿STORAGE_BACKEND?)'); process.exit(1) }

const key = `__smoke__/test-${Date.now()}.txt`
const payload = `hola-r2 ${new Date().toISOString()}`
let ok = 0, fail = 0
const check = (cond, label) => { if (cond) { ok++; console.log(`✓ ${label}`) } else { fail++; console.error(`✗ ${label}`) } }

try {
  console.log(`Bucket: ${config.s3.bucket} @ ${config.s3.endpoint}`)
  check(!(await store.exists(key)), 'la clave no existe antes del put')

  await store.put(key, Buffer.from(payload))
  check(await store.exists(key), 'exists() true tras put')

  // getStream → leer todo el contenido
  const stream = await store.getStream(key)
  const chunks = []
  for await (const c of stream) chunks.push(c)
  check(Buffer.concat(chunks).toString() === payload, 'getStream() devuelve el contenido íntegro')

  // getToFile → descarga a disco
  const base = mkdtempSync(join(tmpdir(), 's3smoke-'))
  const dest = join(base, 'out.txt')
  await store.getToFile(key, dest)
  check(readFileSync(dest, 'utf8') === payload, 'getToFile() descarga el contenido')
  rmSync(base, { recursive: true, force: true })

  await store.delete(key)
  check(!(await store.exists(key)), 'exists() false tras delete')
} catch (e) {
  fail++
  console.error('✗ excepción:', e?.message || e)
} finally {
  try { await store.delete(key) } catch {}
}

console.log(`\n${ok} OK, ${fail} fallos`)
process.exit(fail ? 1 : 0)
