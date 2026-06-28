// Cliente del worker de música (CX33). El worker hace lo pesado de YouTube
// (yt-dlp + ffmpeg), GUARDA audio/carátula/meta en su disco y los sirve por HTTP.
// Santiago no usa yt-dlp salvo que estas llamadas fallen (fallback local).
// Las credenciales vienen del entorno (igual que en bot.mjs), no de un .env aquí.
const MUSIC_WORKER_URL = (process.env.MUSIC_WORKER_URL || '').replace(/\/$/, '')
const MUSIC_WORKER_TOKEN = process.env.MUSIC_WORKER_TOKEN || ''
export const USE_WORKER = !!MUSIC_WORKER_URL

export function workerHeaders() { return { Authorization: `Bearer ${MUSIC_WORKER_TOKEN}` } }

export function workerAudioUrl(src, seekSec) {
  const u = new URL(MUSIC_WORKER_URL + '/audio')
  u.searchParams.set('url', src)
  if (seekSec > 0) u.searchParams.set('seek', String(seekSec))
  return u
}

export async function workerReq(method, path, src, extra = {}) {
  const u = new URL(MUSIC_WORKER_URL + path)
  if (src) u.searchParams.set('url', src)
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v)
  const res = await fetch(u, { method, headers: workerHeaders() })
  if (!res.ok) throw new Error(`worker ${path} HTTP ${res.status}`)
  return res
}

// Devuelve { url, title, duration(seg), uploader, thumbnail, ext } o lanza.
export async function workerMeta(src) { return (await workerReq('GET', '/meta', src)).json() }
// Pre-descarga al disco del worker (forzar caché / gapless). No trae bytes a Santiago.
export async function workerEnsure(src) { await workerReq('POST', '/ensure', src) }
// Marca/desmarca una canción como no-evictable en el worker (permanente).
export async function workerKeep(src, keep) { try { await workerReq('POST', '/keep', src, { keep: keep ? '1' : '0' }) } catch {} }
// Borra audio+carátula+meta del disco del worker.
export async function workerDelete(src) { try { await workerReq('DELETE', '/cache', src) } catch {} }

// Empuja al worker los ajustes que aplica en caliente (concurrencia, tope de
// caché en disco, bitrate). Best-effort. Los valores los pasa el llamador (viven
// en Variables Generales, en bot.mjs).
export async function pushWorkerConfig({ concurrency, maxGb, bitrate }) {
  if (!USE_WORKER) return
  try {
    await workerReq('POST', '/config', null, {
      concurrency: String(concurrency),
      maxGb: String(maxGb),
      bitrate: String(bitrate),
    })
  } catch {}
}

// Expande una playlist por link en el worker. Un 422 = error REAL de la playlist
// (privada/eliminada): se propaga con mensaje claro y SIN fallback local (que
// daría el mismo error). Otros fallos (worker caído) sí permiten fallback.
export async function workerPlaylist(src) {
  const u = new URL(MUSIC_WORKER_URL + '/playlist')
  u.searchParams.set('url', src)
  const res = await fetch(u, { headers: workerHeaders() })
  if (res.status === 422) {
    let msg = 'No se pudo acceder a la playlist'
    try { msg = (await res.json()).error || msg } catch {}
    const err = new Error(msg); err.playlistError = true; throw err
  }
  if (!res.ok) throw new Error(`worker /playlist HTTP ${res.status}`)
  return res.json()
}
