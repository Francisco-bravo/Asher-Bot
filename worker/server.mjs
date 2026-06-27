// music-worker — extractor + ALMACÉN de música del plan de audio en dos nodos.
// Corre en el CX33 (Alemania) dentro de un contenedor con un volumen de ~80 GB.
// Hace TODO lo pesado de YouTube (yt-dlp resuelve el nsig con Node + ffmpeg) y
// GUARDA en disco el audio (Opus), las carátulas y la metadata, para servirlos
// sin volver a extraer. El bot de Santiago es un cliente delgado: pide metadata,
// carátula y audio por HTTP y enchufa el Opus a su mixer. NUNCA habla con Discord.
//
// Endpoints (todos con Authorization: Bearer <WORKER_TOKEN>):
//   GET    /healthz                  → "ok"
//   GET    /meta?url=<src>           → JSON {url,title,duration,uploader,thumbnail,ext}
//   GET    /audio?url=<src>&seek=<s> → Ogg/Opus (de disco si está cacheado, si no extrae y cachea)
//   GET    /art?url=<src>            → imagen de la carátula (la baja una vez y la guarda)
//   POST   /ensure?url=<src>         → pre-descarga a disco sin transmitir (200 al terminar)
//   POST   /keep?url=<src>&keep=1    → marca/desmarca la canción como no-evictable (permanente)
//   DELETE /cache?url=<src>          → borra audio+carátula+meta del disco
//   GET    /playlist?url=<src>       → JSON [{url,title,duration,playlistTitle,thumbnail}]
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, createReadStream, createWriteStream, statSync,
  renameSync, rmSync, readFileSync, writeFileSync, copyFileSync,
} from 'node:fs'
import { join } from 'node:path'

const PORT = +(process.env.PORT || 8080)
const TOKEN = process.env.WORKER_TOKEN || ''
const COOKIES = process.env.COOKIES_FILE || '/cookies.txt'
const YTDLP = process.env.YTDLP || '/usr/local/bin/yt-dlp'
const FFMPEG = process.env.FFMPEG || 'ffmpeg'
const NODE = process.execPath
const DATA_DIR = process.env.DATA_DIR || '/data'
// Tope de la caché de audio en disco (default 70 GB; deja holgura en el disco de 80 GB).
const MAX_BYTES = +(process.env.CACHE_MAX_BYTES || 70 * 1024 ** 3)

const AUDIO_DIR = join(DATA_DIR, 'audio')
const ART_DIR = join(DATA_DIR, 'art')
const META_DIR = join(DATA_DIR, 'meta')
const INDEX_FILE = join(DATA_DIR, 'index.json')
for (const d of [DATA_DIR, AUDIO_DIR, ART_DIR, META_DIR]) { try { mkdirSync(d, { recursive: true }) } catch {} }

// yt-dlp reescribe el cookie jar al salir; si el archivo está montado read-only
// falla con OSError y sale con código != 0 (aunque la descarga sea correcta).
// Copiamos las cookies a una ruta escribible y apuntamos yt-dlp ahí. El montaje
// original sigue :ro y seguro; las cookies refrescadas viven en /tmp (efímeras,
// se re-siembran del montaje en cada arranque).
let COOKIES_RW = COOKIES
if (existsSync(COOKIES)) {
  try { COOKIES_RW = '/tmp/cookies.txt'; copyFileSync(COOKIES, COOKIES_RW) }
  catch { COOKIES_RW = COOKIES }
}

// Clave estable por fuente: las URLs directas se hashean tal cual; el bot SIEMPRE
// pasa la URL canónica (resuelta antes con /meta), así audio/art/meta comparten clave.
// Red de seguridad: una petición con error (p.ej. video no disponible) NUNCA debe
// tumbar el worker. Logueamos y seguimos vivos.
process.on('unhandledRejection', e => console.error('unhandledRejection:', e?.message || e))
process.on('uncaughtException', e => console.error('uncaughtException:', e?.message || e))

const keyOf = src => createHash('sha1').update(src).digest('hex')
const audioPath = key => join(AUDIO_DIR, `${key}.opus`)
const metaPath = key => join(META_DIR, `${key}.json`)

// Índice LRU del audio cacheado: key -> { size, last, keep }
let index = {}
try { index = JSON.parse(readFileSync(INDEX_FILE, 'utf8')) } catch { index = {} }
let saveTimer = null
function saveIndex() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { try { writeFileSync(INDEX_FILE, JSON.stringify(index)) } catch {} }, 500)
}
function touch(key, patch = {}) { index[key] = { ...(index[key] || {}), ...patch, last: Date.now() }; saveIndex() }

// ── Límite de concurrencia de yt-dlp (ajustable en caliente vía POST /config) ──
// Protege la CPU del CX33 y evita el anti-bot de YouTube ante ráfagas (p.ej. la
// Biblioteca pidiendo muchas carátulas de golpe). El bot empuja el valor desde
// "Variables Generales". Lo que excede el tope hace cola hasta que se libera un slot.
let MAX_CONC = Math.max(1, +(process.env.MAX_CONCURRENCY || 3))
let active = 0
const waiters = []
function pump() { while (waiters.length && active < MAX_CONC) { active++; waiters.shift()() } }
function acquire() { if (active < MAX_CONC) { active++; return Promise.resolve() } return new Promise(r => waiters.push(r)) }
function release() { active = Math.max(0, active - 1); pump() }
async function withSlot(fn) { await acquire(); try { return await fn() } finally { release() } }
function setMaxConc(n) { MAX_CONC = Math.max(1, n | 0); pump() }

// Deduplicación de operaciones en vuelo: si llega la misma clave mientras se
// procesa, se comparte la misma promesa en vez de lanzar otro yt-dlp.
const inflight = new Map()
function dedup(key, fn) {
  if (inflight.has(key)) return inflight.get(key)
  const p = (async () => { try { return await fn() } finally { inflight.delete(key) } })()
  inflight.set(key, p)
  return p
}

function ytdlpArgs(extra) {
  // Node resuelve el desafío de firma de YouTube (mismo runtime que el bot).
  const a = ['--no-warnings', '--js-runtimes', `node:${NODE}`]
  if (existsSync(COOKIES_RW)) a.push('--cookies', COOKIES_RW)
  return a.concat(extra)
}

// Ejecuta yt-dlp juntando stdout (para --print / --flat-playlist). Rechaza si falla.
function ytdlpText(extra) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, ytdlpArgs(extra))
    let out = '', err = ''
    p.stdout.on('data', d => out += d)
    p.stderr.on('data', d => { if (err.length < 2000) err += d })
    p.on('error', reject)
    p.on('close', code => code === 0 || out.trim() ? resolve(out) : reject(new Error(`yt-dlp ${code}: ${err.slice(0, 300)}`)))
  })
}

// Resuelve metadata + URL canónica de una fuente (URL directa o ytsearch1:).
async function resolveMeta(src) {
  const line = (await ytdlpText(['--no-playlist', '--skip-download', '--print',
    '%(webpage_url)s\t%(title)s\t%(duration)s\t%(uploader)s\t%(thumbnail)s\t%(ext)s', src]))
    .trim().split('\n')[0] || ''
  const [url, title, duration, uploader, thumbnail, ext] = line.split('\t')
  const clean = v => (v && v !== 'NA') ? v : ''
  return {
    url: clean(url) || src,
    title: clean(title),
    duration: parseFloat(duration) || 0,
    uploader: clean(uploader),
    thumbnail: /^https?:\/\//i.test(thumbnail || '') ? thumbnail : '',
    ext: clean(ext) || 'webm',
  }
}

// Metadata cacheada en disco por clave de la fuente PEDIDA (incluye búsquedas).
async function getMeta(src) {
  const mp = metaPath(keyOf(src))
  if (existsSync(mp)) { try { return JSON.parse(readFileSync(mp, 'utf8')) } catch {} }
  return dedup('meta:' + keyOf(src), async () => {
    if (existsSync(mp)) { try { return JSON.parse(readFileSync(mp, 'utf8')) } catch {} }
    const meta = await withSlot(() => resolveMeta(src))
    try { writeFileSync(mp, JSON.stringify(meta)) } catch {}
    return meta
  })
}

// LRU: si el total supera el tope, expulsa los menos usados que no sean "keep".
function evictIfNeeded() {
  let total = 0
  for (const k in index) total += index[k].size || 0
  if (total <= MAX_BYTES) return
  const keys = Object.keys(index).filter(k => !index[k].keep)
    .sort((a, b) => (index[a].last || 0) - (index[b].last || 0))
  for (const k of keys) {
    if (total <= MAX_BYTES) break
    try { rmSync(audioPath(k), { force: true }) } catch {}
    total -= index[k].size || 0
    delete index[k]
  }
  saveIndex()
}

function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(b)
}

// Argumentos ffmpeg para producir Ogg/Opus 160k @48k estéreo (con seek opcional).
function opusArgs(input, seek) {
  const a = ['-loglevel', 'error']
  if (seek > 0) a.push('-ss', String(seek))
  a.push('-i', input, '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'libopus', '-b:a', '160k', '-f', 'ogg', 'pipe:1')
  return a
}

// Sirve un Opus ya guardado en disco. Con seek re-encodea desde ese punto.
function streamCached(res, file, seek, key) {
  touch(key)
  res.writeHead(200, { 'Content-Type': 'audio/ogg', 'Cache-Control': 'no-store', 'X-Cache': 'hit' })
  if (seek > 0) {
    const ff = spawn(FFMPEG, opusArgs(file, seek))
    ff.stdout.pipe(res); ff.stderr.on('data', () => {})
    res.on('close', () => { try { ff.kill('SIGKILL') } catch {} })
  } else {
    const rs = createReadStream(file)
    rs.on('error', () => { try { res.destroy() } catch {} })
    rs.pipe(res)
  }
}

// Extrae con yt-dlp→ffmpeg y transmite Opus. Si doCache y seek==0, hace tee a
// disco y al terminar (yt-dlp código 0, sin abortar) lo deja en audio/<key>.opus.
async function extractAndStream(res, src, seek, key, doCache) {
  await acquire() // la extracción cuenta para el límite de concurrencia
  let slotReleased = false
  const releaseSlot = () => { if (!slotReleased) { slotReleased = true; release() } }
  const yt = spawn(YTDLP, ytdlpArgs(['--no-playlist', '-f', 'bestaudio/best', '-o', '-', src]))
  const ff = spawn(FFMPEG, opusArgs('pipe:0', seek))

  yt.stdout.pipe(ff.stdin)
  yt.stdout.on('error', () => {})
  ff.stdin.on('error', () => {})

  let tmp = null, ws = null
  if (doCache && seek === 0) {
    tmp = `${audioPath(key)}.${process.pid}.${Date.now()}.part`
    ws = createWriteStream(tmp)
  }

  let ytCode = null, aborted = false, ended = false, headerSent = false
  let ytErr = ''
  yt.stderr.on('data', d => { if (ytErr.length < 2000) ytErr += d })
  ff.stderr.on('data', () => {})

  // El 200 NO se envía hasta el primer byte de audio: si la extracción falla
  // (video no disponible, etc.) se responde 502 en vez de un 200 vacío (que el
  // bot interpretaba como "Invalid data" y hacía desaparecer la canción).
  ff.stdout.on('data', chunk => {
    if (!headerSent) { headerSent = true; res.writeHead(200, { 'Content-Type': 'audio/ogg', 'Cache-Control': 'no-store', 'X-Cache': 'miss' }) }
    const ok = res.write(chunk)
    if (ws) ws.write(chunk)
    if (!ok) { ff.stdout.pause(); res.once('drain', () => ff.stdout.resume()) }
  })

  const kill = () => { aborted = true; try { yt.kill('SIGKILL') } catch {} try { ff.kill('SIGKILL') } catch {} }
  res.on('close', () => { if (!ended) kill() })

  yt.on('error', e => { console.error('yt-dlp:', e.message); releaseSlot(); try { res.destroy() } catch {} })
  ff.on('error', e => { console.error('ffmpeg:', e.message); releaseSlot(); try { res.destroy() } catch {} })
  yt.on('close', code => { ytCode = code; if (code && !aborted) console.error('yt-dlp exit', code, ytErr.slice(0, 300)) })

  ff.on('close', () => {
    ended = true
    releaseSlot()
    if (!headerSent && !aborted) { try { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('extraction failed') } catch {} }
    else { try { res.end() } catch {} }
    if (!ws) return
    ws.end(() => {
      // Solo cachea si hubo audio real, la extracción terminó bien y no se abortó.
      if (headerSent && ytCode === 0 && !aborted) {
        try {
          const dst = audioPath(key)
          renameSync(tmp, dst)
          touch(key, { size: statSync(dst).size })
          evictIfNeeded()
        } catch (e) { console.warn('cache:', e.message); try { rmSync(tmp, { force: true }) } catch {} }
      } else {
        try { rmSync(tmp, { force: true }) } catch {}
      }
    })
  })
}

// Descarga a disco SIN transmitir (para /ensure: forzar caché / prefetch).
// Dedup por clave + slot de concurrencia (no satura ante varios /ensure juntos).
function downloadToCache(src, key) {
  return dedup('ensure:' + key, () => withSlot(() => downloadToCacheRaw(src, key)))
}
function downloadToCacheRaw(src, key) {
  return new Promise((resolve, reject) => {
    const yt = spawn(YTDLP, ytdlpArgs(['--no-playlist', '-f', 'bestaudio/best', '-o', '-', src]))
    const ff = spawn(FFMPEG, opusArgs('pipe:0', 0))
    const tmp = `${audioPath(key)}.${process.pid}.${Date.now()}.part`
    const ws = createWriteStream(tmp)
    yt.stdout.pipe(ff.stdin); ff.stdout.pipe(ws)
    yt.stdout.on('error', () => {}); ff.stdin.on('error', () => {})
    let ytErr = ''; yt.stderr.on('data', d => { if (ytErr.length < 2000) ytErr += d }); ff.stderr.on('data', () => {})
    let ytCode = null
    yt.on('error', reject); ff.on('error', reject)
    yt.on('close', code => { ytCode = code })
    ff.on('close', () => {
      ws.end(() => {
        if (ytCode !== 0) { try { rmSync(tmp, { force: true }) } catch {}; return reject(new Error(`yt-dlp ${ytCode}: ${ytErr.slice(0, 200)}`)) }
        try {
          const dst = audioPath(key)
          renameSync(tmp, dst)
          touch(key, { size: statSync(dst).size })
          evictIfNeeded()
          resolve()
        } catch (e) { try { rmSync(tmp, { force: true }) } catch {}; reject(e) }
      })
    })
  })
}

// Baja la carátula (si no está) y la sirve. Guarda art/<key> + el mime en el índice.
async function serveArt(res, src) {
  const key = keyOf(src)
  const file = join(ART_DIR, key)
  const mimeOf = u => {
    const e = (u.split(/[?#]/)[0].split('.').pop() || '').toLowerCase()
    return e === 'png' ? 'image/png' : e === 'webp' ? 'image/webp' : e === 'gif' ? 'image/gif' : 'image/jpeg'
  }
  if (existsSync(file) && index[key]?.artMime) {
    res.writeHead(200, { 'Content-Type': index[key].artMime, 'Cache-Control': 'public, max-age=86400' })
    return createReadStream(file).pipe(res)
  }
  let meta
  try { meta = await getMeta(src) } catch (e) { res.writeHead(404); return res.end('sin meta: ' + e.message) }
  if (!meta.thumbnail) { res.writeHead(404); return res.end('sin caratula') }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 8000)
  try {
    const r = await fetch(meta.thumbnail, { signal: ctrl.signal })
    if (!r.ok) { res.writeHead(502); return res.end('thumb HTTP ' + r.status) }
    const buf = Buffer.from(await r.arrayBuffer())
    const mime = mimeOf(meta.thumbnail)
    writeFileSync(file, buf)
    touch(key, { artMime: mime })
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' })
    res.end(buf)
  } catch (e) { res.writeHead(502); res.end('thumb: ' + e.message) }
  finally { clearTimeout(t) }
}

// Expande una playlist (sin resolver cada video).
async function getPlaylist(src) {
  const out = await withSlot(() => ytdlpText(['--flat-playlist', '--print',
    '%(url)s\t%(title)s\t%(duration)s\t%(playlist_title)s\t%(thumbnail)s', src]))
  return out.trim().split('\n').filter(Boolean).map(line => {
    const [u, title, dur, plTitle, thumb] = line.split('\t')
    return {
      url: u,
      title: (title && title !== 'NA') ? title : u,
      duration: parseFloat(dur) || 0,
      playlistTitle: (plTitle && plTitle !== 'NA') ? plTitle : null,
      thumbnail: (thumb && thumb !== 'NA' && /^https?:\/\//i.test(thumb)) ? thumb : null,
    }
  }).filter(e => e.url && /^https?:\/\//i.test(e.url))
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x')
    const p = u.pathname

    if (p === '/healthz') { res.writeHead(200); return res.end('ok') }

    // Auth Bearer en todo lo demás.
    if (!TOKEN || (req.headers.authorization || '') !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end('unauthorized') }

    const src = u.searchParams.get('url')
    const needSrc = () => { if (!src) { res.writeHead(400); res.end('missing url'); return false } return true }

    if (p === '/meta' && req.method === 'GET') {
      if (!needSrc()) return
      return sendJson(res, 200, await getMeta(src))
    }

    if (p === '/audio' && req.method === 'GET') {
      if (!needSrc()) return
      const seek = Math.max(0, parseInt(u.searchParams.get('seek') || '0', 10) || 0)
      const key = keyOf(src)
      const file = audioPath(key)
      if (existsSync(file)) return streamCached(res, file, seek, key)
      return await extractAndStream(res, src, seek, key, true)
    }

    if (p === '/art' && req.method === 'GET') {
      if (!needSrc()) return
      return await serveArt(res, src)
    }

    if (p === '/ensure' && req.method === 'POST') {
      if (!needSrc()) return
      const key = keyOf(src)
      if (existsSync(audioPath(key))) { touch(key); return sendJson(res, 200, { cached: true }) }
      await downloadToCache(src, key)
      return sendJson(res, 200, { cached: true })
    }

    if (p === '/keep' && req.method === 'POST') {
      if (!needSrc()) return
      const keep = u.searchParams.get('keep') !== '0'
      touch(keyOf(src), { keep })
      return sendJson(res, 200, { keep })
    }

    if (p === '/cache' && req.method === 'DELETE') {
      if (!needSrc()) return
      const key = keyOf(src)
      try { rmSync(audioPath(key), { force: true }) } catch {}
      try { rmSync(join(ART_DIR, key), { force: true }) } catch {}
      try { rmSync(metaPath(key), { force: true }) } catch {}
      delete index[key]; saveIndex()
      return sendJson(res, 200, { deleted: true })
    }

    if (p === '/playlist' && req.method === 'GET') {
      if (!needSrc()) return
      return sendJson(res, 200, await getPlaylist(src))
    }

    // Límite de concurrencia (ajustable en caliente desde "Variables Generales").
    if (p === '/config') {
      if (req.method === 'POST') {
        const c = parseInt(u.searchParams.get('concurrency') || '', 10)
        if (!isNaN(c)) setMaxConc(c)
      }
      return sendJson(res, 200, { concurrency: MAX_CONC, active, queued: waiters.length })
    }

    res.writeHead(404); res.end('not found')
  } catch (e) {
    console.error('handler:', e.message)
    if (!res.headersSent) res.writeHead(500)
    res.end('error: ' + e.message)
  }
})

server.listen(PORT, () => console.log(`music-worker escuchando en :${PORT} (data=${DATA_DIR}, max=${(MAX_BYTES / 1024 ** 3).toFixed(0)}GB)`))
