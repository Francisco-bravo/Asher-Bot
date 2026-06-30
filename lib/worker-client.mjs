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
  if (!res.ok) {
    let detail = ''
    try {
      const ct = res.headers.get('content-type') || ''
      if (ct.includes('json')) { const j = await res.json(); detail = j.error ? ': ' + j.error : '' }
      else { detail = ': ' + (await res.text()).replace(/^error:\s*/i, '').trim().slice(0, 200) }
    } catch {}
    throw new Error(`worker ${path} HTTP ${res.status}${detail}`)
  }
  return res
}

// Devuelve { url, title, duration(seg), uploader, thumbnail, ext } o lanza.
export async function workerMeta(src) { return (await workerReq('GET', '/meta', src)).json() }
// Conjunto de claves (sha1 de la fuente) que el worker tiene cacheadas, para
// cruzar la biblioteca con su caché. Cachea la respuesta unos segundos; si el
// worker está caído devuelve lo último conocido.
let _cachedKeys = { at: 0, set: new Set() }
export async function workerCachedKeys() {
  if (!USE_WORKER) return new Set()
  if (Date.now() - _cachedKeys.at < 8000) return _cachedKeys.set
  try {
    const j = await (await workerReq('GET', '/cached-keys')).json()
    _cachedKeys = { at: Date.now(), set: new Set(j.keys || []) }
  } catch { /* worker caído: se devuelve lo último conocido */ }
  return _cachedKeys.set
}
// Pre-descarga al disco del worker (forzar caché / gapless). No trae bytes a Santiago.
export async function workerEnsure(src) { await workerReq('POST', '/ensure', src) }
// Marca/desmarca una canción como no-evictable en el worker (permanente).
export async function workerKeep(src, keep) { try { await workerReq('POST', '/keep', src, { keep: keep ? '1' : '0' }) } catch {} }
// Borra audio+carátula+meta del disco del worker.
export async function workerDelete(src) { try { await workerReq('DELETE', '/cache', src) } catch {} }

// Sube las cookies de YouTube al worker (texto plano del cookies.txt).
export async function workerUploadCookies(content) {
  const u = new URL(MUSIC_WORKER_URL + '/cookies')
  const res = await fetch(u, { method: 'POST', headers: { ...workerHeaders(), 'Content-Type': 'text/plain; charset=utf-8' }, body: content })
  if (!res.ok) {
    let detail = ''; try { const j = await res.json(); detail = j.error ? ': ' + j.error : '' } catch {}
    throw new Error(`worker /cookies HTTP ${res.status}${detail}`)
  }
  return res.json()
}
// Estado de las cookies en el worker (¿existen? tamaño, fecha).
export async function workerCookiesStatus() {
  if (!USE_WORKER) return null
  try { return await (await workerReq('GET', '/cookies/status')).json() } catch { return null }
}

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
