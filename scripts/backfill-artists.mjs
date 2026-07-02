// Backfill de artistas: recorre la biblioteca y completa el artista de las
// canciones que no lo tienen. Primero intenta derivarlo del TÍTULO ("Artista -
// Canción") sin tocar la red; si el título es solo el nombre de la canción, pide
// el canal (uploader) al worker /meta y lo usa. Va DE A UNA con pausas para no
// saturar el worker / YouTube. Idempotente: re-ejecutar solo toca las que falten.
//
//   node --env-file=.env scripts/backfill-artists.mjs
import * as musicCache from '../lib/music-cache.mjs'

const WORKER_URL = (process.env.MUSIC_WORKER_URL || '').replace(/\/$/, '')
const WORKER_TOKEN = process.env.MUSIC_WORKER_TOKEN || ''
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Misma lógica que bot.mjs (deriveArtist/cleanChannelName).
function cleanChannelName(u) {
  return String(u || '').trim()
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*VEVO$/i, '')
    .replace(/\s*[-–]?\s*(Official|Oficial)$/i, '')
    .trim()
}
function deriveArtist(title, uploader) {
  const parts = String(title || '').split(/\s+[-–—]\s+/)
  if (parts.length >= 2) {
    const cand = parts[0].trim()
    if (cand.length >= 2 && cand.length <= 40) return cand
  }
  return cleanChannelName(uploader) || null
}

async function workerUploader(url) {
  if (!WORKER_URL) return null
  try {
    const u = new URL(WORKER_URL + '/meta')
    u.searchParams.set('url', url)
    const r = await fetch(u, { headers: { Authorization: `Bearer ${WORKER_TOKEN}` }, signal: AbortSignal.timeout(30000) })
    if (!r.ok) return null
    const m = await r.json()
    return m.uploader || null
  } catch { return null }
}

const rows = (await musicCache.listAll())
  .filter(s => (!s.artist) && /^https?:\/\//i.test(s.source_url))

console.log(`Canciones sin artista: ${rows.length}`)
let done = 0, set = 0, fromTitle = 0, fromChannel = 0, failed = 0

for (const s of rows) {
  done++
  let artist = deriveArtist(s.title, null) // 1) del título, sin red
  let fetched = false
  if (artist) {
    fromTitle++
  } else {
    fetched = true
    const up = await workerUploader(s.source_url) // 2) del canal (worker /meta)
    artist = deriveArtist(s.title, up)
    if (artist) fromChannel++
  }
  if (artist) { await musicCache.setMeta(s.id, { artist }); set++ }
  else failed++

  if (done % 10 === 0 || done === rows.length) {
    console.log(`${done}/${rows.length} · fijados=${set} (título=${fromTitle}, canal=${fromChannel}) · sin dato=${failed}`)
  }
  // Pausa para no saturar: corta si fue solo del título, más larga si hubo fetch.
  await sleep(fetched ? 1200 : 25)
}

console.log(`\nListo. Artista fijado en ${set}/${rows.length} (del título: ${fromTitle}, del canal: ${fromChannel}). Sin dato: ${failed}.`)
process.exit(0)
