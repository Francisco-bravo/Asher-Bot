// Script puntual (correr una sola vez, a mano): migra la Biblioteca LOCAL de
// test (tabla `songs` de su SQLite) al catálogo compartido del worker. La
// Biblioteca de prod NO se migra (decisión del usuario) — prod arranca con
// el catálogo del worker desde cero, igual que un entorno nuevo.
//
// Uso: node scripts/migrate-songs-to-worker.mjs <ruta-al-bot.db-de-test>
//   MUSIC_WORKER_URL=https://music.aronne.dev MUSIC_WORKER_TOKEN=... node scripts/migrate-songs-to-worker.mjs bot.db
import { DatabaseSync } from 'node:sqlite'

const dbPath = process.argv[2]
if (!dbPath) { console.error('Uso: node migrate-songs-to-worker.mjs <ruta-al-bot.db>'); process.exit(1) }

const WORKER_URL = (process.env.MUSIC_WORKER_URL || '').replace(/\/$/, '')
const WORKER_TOKEN = process.env.MUSIC_WORKER_TOKEN || ''
if (!WORKER_URL || !WORKER_TOKEN) { console.error('Faltan MUSIC_WORKER_URL/MUSIC_WORKER_TOKEN'); process.exit(1) }

const headers = { Authorization: `Bearer ${WORKER_TOKEN}` }

async function workerReq(method, path, params = {}) {
  const u = new URL(WORKER_URL + path)
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
  const res = await fetch(u, { method, headers })
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

const db = new DatabaseSync(dbPath, { readOnly: true })
const songs = db.prepare('SELECT * FROM songs ORDER BY id').all()
console.log(`Leídas ${songs.length} canciones de ${dbPath}`)

let ok = 0, permanentOk = 0, ensureOk = 0, ensureFail = 0, failed = 0
for (const s of songs) {
  try {
    const created = await workerReq('POST', '/songs', {
      sourceUrl: s.source_url, title: s.title, artist: s.artist, album: s.album,
      durationMs: s.duration_ms, ext: s.ext,
    })
    ok++
    if (s.permanent) {
      await workerReq('POST', '/songs/update', { id: created.id, permanent: '1' })
      await workerReq('POST', '/keep', { url: s.source_url, keep: '1' })
      permanentOk++
    }
    // Best-effort: si ya se había bajado alguna vez, pre-cachear el audio en el
    // worker ahora (no bloquea la migración si falla o tarda).
    if (s.persisted || s.audio_key) {
      try { await workerReq('POST', '/ensure', { url: s.source_url }); ensureOk++ }
      catch (e) { ensureFail++; console.warn(`  ensure falló (${s.source_url}): ${e.message}`) }
    }
  } catch (e) {
    failed++
    console.warn(`  ✗ "${s.title || s.source_url}": ${e.message}`)
  }
}

console.log(`\nListo: ${ok}/${songs.length} migradas, ${permanentOk} permanentes, ${ensureOk} audio pre-cacheado (${ensureFail} fallidos, quedan para la 1ª reproducción), ${failed} con error.`)
