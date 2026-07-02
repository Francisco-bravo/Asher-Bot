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
//   GET    /songs                    → catálogo completo (Biblioteca compartida)
//   GET    /songs/one?id=|url=       → una canción
//   POST   /songs?sourceUrl=&title=… → crea/upsert por source_url
//   POST   /songs/update?id=&…       → actualización parcial (título/artista/permanente/…)
//   POST   /songs/play?id=           → suma una reproducción
//   DELETE /songs?id=                → borra la fila + sus archivos en disco
//   POST   /songs/art?id=            → guarda una carátula elegida a mano (bytes crudos)
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  existsSync, mkdirSync, createReadStream, createWriteStream, statSync,
  renameSync, rmSync, readFileSync, writeFileSync, copyFileSync,
} from 'node:fs'
import { join } from 'node:path'

const PORT = +(process.env.PORT || 8080)
const TOKEN = process.env.WORKER_TOKEN || ''

// Ring buffer de logs para el endpoint /stream-logs
const LOG_RING = []
const LOG_RING_MAX = 500
const logListeners = new Set()
function pushLog(line) {
  LOG_RING.push(line)
  if (LOG_RING.length > LOG_RING_MAX) LOG_RING.shift()
  for (const fn of logListeners) fn(line)
}
;['log', 'warn', 'error', 'info'].forEach(m => {
  const orig = console[m].bind(console)
  console[m] = (...args) => { orig(...args); pushLog(args.map(String).join(' ')) }
})
const COOKIES = process.env.COOKIES_FILE || '/cookies.txt'
const YTDLP = process.env.YTDLP || '/usr/local/bin/yt-dlp'
const FFMPEG = process.env.FFMPEG || 'ffmpeg'
const NODE = process.execPath
const DATA_DIR = process.env.DATA_DIR || '/data'
// Tope de la caché de audio en disco (default 70 GB; deja holgura en el disco de 80 GB).
// Ajustable en caliente desde "Variables Generales" del panel (POST /config?maxGb=).
let MAX_BYTES = +(process.env.CACHE_MAX_BYTES || 70 * 1024 ** 3)

const AUDIO_DIR = join(DATA_DIR, 'audio')
const ART_DIR = join(DATA_DIR, 'art')
const META_DIR = join(DATA_DIR, 'meta')
const ART_OVERRIDE_DIR = join(DATA_DIR, 'art-override') // carátula elegida a mano (admin), prioridad sobre la de YouTube
const INDEX_FILE = join(DATA_DIR, 'index.json')
for (const d of [DATA_DIR, AUDIO_DIR, ART_DIR, META_DIR, ART_OVERRIDE_DIR]) { try { mkdirSync(d, { recursive: true }) } catch {} }

// Catálogo de canciones (Biblioteca): único compartido por todos los entornos
// (antes vivía en la DB local de cada bot). El audio/carátula/metadata siguen
// siendo archivos en disco keyeados por sha1(url); esta tabla solo guarda los
// datos de catálogo (título, autor, duración, contador de reproducciones).
const songsDb = new DatabaseSync(join(DATA_DIR, 'songs.db'))
songsDb.exec('PRAGMA journal_mode = WAL')
songsDb.exec(`CREATE TABLE IF NOT EXISTS songs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_url     TEXT UNIQUE NOT NULL,
  title          TEXT,
  artist         TEXT,
  album          TEXT,
  duration_ms    INTEGER,
  ext            TEXT,
  play_count     INTEGER NOT NULL DEFAULT 0,
  permanent      INTEGER NOT NULL DEFAULT 0,
  last_played_at INTEGER,
  created_at     INTEGER NOT NULL
)`)

function dbGetById(id) { return songsDb.prepare('SELECT * FROM songs WHERE id = ?').get(Number(id)) }
function dbFindByUrl(url) { return songsDb.prepare('SELECT * FROM songs WHERE source_url = ?').get(url) }
function dbList() { return songsDb.prepare('SELECT * FROM songs ORDER BY COALESCE(last_played_at, 0) DESC, created_at DESC').all() }
function dbUpsert({ sourceUrl, title = null, artist = null, album = null, durationMs = null, ext = null }) {
  const existing = dbFindByUrl(sourceUrl)
  if (existing) return existing
  const info = songsDb.prepare(
    `INSERT INTO songs (source_url, title, artist, album, duration_ms, ext, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(sourceUrl, title, artist, album, durationMs, ext, Date.now())
  return dbGetById(info.lastInsertRowid)
}
function dbUpdate(id, { title, artist, album, durationMs, permanent } = {}) {
  const sets = [], vals = []
  if (title !== undefined) { sets.push('title = ?'); vals.push(title) }
  if (artist !== undefined) { sets.push('artist = ?'); vals.push(artist) }
  if (album !== undefined) { sets.push('album = ?'); vals.push(album) }
  if (durationMs !== undefined) { sets.push('duration_ms = ?'); vals.push(durationMs) }
  if (permanent !== undefined) { sets.push('permanent = ?'); vals.push(permanent ? 1 : 0) }
  if (sets.length) { vals.push(Number(id)); songsDb.prepare(`UPDATE songs SET ${sets.join(', ')} WHERE id = ?`).run(...vals) }
  return dbGetById(id)
}
function dbBumpPlay(id) {
  songsDb.prepare('UPDATE songs SET play_count = play_count + 1, last_played_at = ? WHERE id = ?').run(Date.now(), Number(id))
  return dbGetById(id)
}
function dbDelete(id) {
  const song = dbGetById(id)
  if (!song) return false
  songsDb.prepare('DELETE FROM songs WHERE id = ?').run(Number(id))
  return song
}

// ¿Tiene carátula en disco (auto-descargada o elegida a mano)? Reemplaza a la
// vieja columna `art_key`: acá la verdad es el archivo, no una fila — el bot
// usa este flag para no volver a buscar carátula si ya hay una.
function hasArt(song) {
  const key = keyOf(song.source_url)
  return existsSync(join(ART_DIR, key)) || existsSync(join(ART_OVERRIDE_DIR, key))
}
function annotateArt(song) { return song && { ...song, has_art: hasArt(song) } }

// Cookies persistentes: se guardan en el volumen de datos (sobreviven reinicios).
// Preferimos /data/cookies.txt (subido vía panel) sobre la variable COOKIES_FILE.
const COOKIES_DATA = join(DATA_DIR, 'cookies.txt')
// yt-dlp reescribe el cookie jar al salir; si el archivo está montado read-only
// falla con OSError y sale con código != 0 (aunque la descarga sea correcta).
// Copiamos las cookies a una ruta escribible. Si hay cookies en /data (subidas vía
// panel) las usamos directamente (ya son escribibles); si no, copiamos las del montaje.
let COOKIES_RW = ''
function reloadCookies() {
  if (existsSync(COOKIES_DATA)) {
    COOKIES_RW = COOKIES_DATA  // en /data → ya escribible, yt-dlp puede refrescarlas
  } else if (existsSync(COOKIES)) {
    try { COOKIES_RW = '/tmp/cookies.txt'; copyFileSync(COOKIES, COOKIES_RW) }
    catch { COOKIES_RW = COOKIES }
  } else {
    COOKIES_RW = ''
  }
}
reloadCookies()

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
// ¿Hay un slot de concurrencia libre AHORA? Lo usa serveArt para no encolar la
// resolución de una carátula detrás de extracciones de audio: si no hay slot,
// devuelve vacío y el bot tira de sus fuentes alternativas (iTunes/Deezer/…).
function slotFree() { return active < MAX_CONC }

// Bitrate del Opus de música (kbps). Ajustable en caliente (POST /config?bitrate=).
// Solo afecta descargas NUEVAS; lo ya cacheado conserva su bitrate.
let MUSIC_BITRATE = Math.min(256, Math.max(64, +(process.env.MUSIC_BITRATE || 160)))

// Proxy SOCKS5 en Santiago (VM de test/prod, ver microsocks) para reintentar videos
// geo-restringidos a Chile que este worker (Alemania) no puede extraer. Formato
// completo aceptado por yt-dlp: socks5://usuario:password@ip:puerto. Vacío = sin
// proxy configurado (el reintento simplemente no ocurre, se comporta como antes).
const SANTIAGO_PROXY = process.env.SANTIAGO_PROXY || ''

// Deduplicación de operaciones en vuelo: si llega la misma clave mientras se
// procesa, se comparte la misma promesa en vez de lanzar otro yt-dlp.
const inflight = new Map()
function dedup(key, fn) {
  if (inflight.has(key)) return inflight.get(key)
  const p = (async () => { try { return await fn() } finally { inflight.delete(key) } })()
  inflight.set(key, p)
  return p
}

function ytdlpArgs(extra, proxy = false) {
  // Node resuelve el desafío de firma de YouTube (mismo runtime que el bot).
  const a = ['--no-warnings', '--js-runtimes', `node:${NODE}`]
  if (existsSync(COOKIES_RW)) a.push('--cookies', COOKIES_RW)
  if (proxy && SANTIAGO_PROXY) a.push('--proxy', SANTIAGO_PROXY)
  return a.concat(extra)
}

// Ejecuta yt-dlp juntando stdout (para --print / --flat-playlist). Rechaza si falla.
function ytdlpText(extra, proxy = false) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, ytdlpArgs(extra, proxy))
    let out = '', err = ''
    p.stdout.on('data', d => out += d)
    p.stderr.on('data', d => { if (err.length < 2000) err += d })
    p.on('error', reject)
    p.on('close', code => code === 0 || out.trim() ? resolve(out) : reject(new Error(`yt-dlp ${code}: ${err.slice(0, 300)}`)))
  })
}

// Reintenta vía el proxy de Santiago (IP chilena) si el intento directo (IP alemana)
// falla — cubre videos geo-restringidos a Chile. Sin SANTIAGO_PROXY configurado, se
// comporta exactamente igual que antes (un solo intento, directo).
async function ytdlpTextWithFallback(extra) {
  try {
    return await ytdlpText(extra, false)
  } catch (e) {
    if (!SANTIAGO_PROXY) throw e
    console.warn('yt-dlp directo falló, reintentando vía proxy Santiago:', e.message)
    return await ytdlpText(extra, true)
  }
}

// Resuelve metadata + URL canónica de una fuente (URL directa o ytsearch1:).
async function resolveMeta(src) {
  const line = (await ytdlpTextWithFallback(['--no-playlist', '--skip-download', '--print',
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

// Borra todo lo cacheado en disco para una clave: audio, carátula (auto y override), meta.
function deleteCachedFiles(key) {
  try { rmSync(audioPath(key), { force: true }) } catch {}
  try { rmSync(join(ART_DIR, key), { force: true }) } catch {}
  try { rmSync(join(ART_OVERRIDE_DIR, key), { force: true }) } catch {}
  try { rmSync(metaPath(key), { force: true }) } catch {}
  delete index[key]; saveIndex()
}

// Argumentos ffmpeg para producir Ogg/Opus @48k estéreo (con seek opcional). El
// bitrate es configurable en caliente (MUSIC_BITRATE, kbps).
function opusArgs(input, seek) {
  const a = ['-loglevel', 'error']
  if (seek > 0) a.push('-ss', String(seek))
  a.push('-i', input, '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'libopus', '-b:a', `${MUSIC_BITRATE}k`, '-f', 'ogg', 'pipe:1')
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

// Un intento de extracción (directo o vía proxy). Resuelve {ok, aborted} — nunca
// escribe la respuesta final (502/fin de stream): eso lo decide extractAndStream
// una vez que sabe si hace falta o no un segundo intento vía proxy.
function runExtraction(res, src, seek, key, doCache, proxy) {
  return new Promise(resolveAttempt => {
    const yt = spawn(YTDLP, ytdlpArgs(['--no-playlist', '-f', 'bestaudio/best', '-o', '-', src], proxy))
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
    // (video no disponible, etc.) el llamador decide 502 en vez de un 200 vacío
    // (que el bot interpretaba como "Invalid data" y hacía desaparecer la canción).
    ff.stdout.on('data', chunk => {
      if (!headerSent) { headerSent = true; res.writeHead(200, { 'Content-Type': 'audio/ogg', 'Cache-Control': 'no-store', 'X-Cache': 'miss' }) }
      const ok = res.write(chunk)
      if (ws) ws.write(chunk)
      if (!ok) { ff.stdout.pause(); res.once('drain', () => ff.stdout.resume()) }
    })

    const kill = () => { aborted = true; try { yt.kill('SIGKILL') } catch {} try { ff.kill('SIGKILL') } catch {} }
    res.on('close', kill)

    yt.on('error', e => { console.error('yt-dlp:', e.message); try { res.destroy() } catch {} })
    ff.on('error', e => { console.error('ffmpeg:', e.message); try { res.destroy() } catch {} })
    yt.on('close', code => { ytCode = code; if (code && !aborted) console.error('yt-dlp exit', code, ytErr.slice(0, 300)) })

    ff.on('close', () => {
      ended = true
      res.off('close', kill)
      const finish = () => resolveAttempt({ ok: headerSent, aborted })
      if (!ws) return finish()
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
        finish()
      })
    })
  })
}

// Extrae con yt-dlp→ffmpeg y transmite Opus. Si el intento directo (IP alemana) no
// produce audio (geo-restricción a Chile, típicamente), reintenta UNA vez vía el
// proxy de Santiago antes de rendirse — así el bot ya no necesita un fallback local
// para esos casos (ver SANTIAGO_PROXY). Si doCache y seek==0, el intento que sí
// funcionó hace tee a disco y lo deja en audio/<key>.opus.
async function extractAndStream(res, src, seek, key, doCache) {
  await acquire() // la extracción cuenta para el límite de concurrencia (ambos intentos comparten el slot)
  try {
    let result = await runExtraction(res, src, seek, key, doCache, false)
    if (!result.ok && !result.aborted && SANTIAGO_PROXY) {
      console.warn('extracción directa falló, reintentando vía proxy Santiago:', src)
      result = await runExtraction(res, src, seek, key, doCache, true)
    }
    if (!result.ok && !result.aborted) {
      try { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('extraction failed') } catch {}
    } else if (!result.aborted) {
      try { res.end() } catch {}
    }
  } finally {
    release()
  }
}

// Descarga a disco SIN transmitir (para /ensure: forzar caché / prefetch).
// Dedup por clave + slot de concurrencia (no satura ante varios /ensure juntos).
// Mismo reintento vía proxy Santiago que extractAndStream si el intento directo falla.
function downloadToCache(src, key) {
  return dedup('ensure:' + key, () => withSlot(async () => {
    try {
      await downloadToCacheRaw(src, key, false)
    } catch (e) {
      if (!SANTIAGO_PROXY) throw e
      console.warn('ensure directo falló, reintentando vía proxy Santiago:', e.message)
      await downloadToCacheRaw(src, key, true)
    }
  }))
}
function downloadToCacheRaw(src, key, proxy = false) {
  return new Promise((resolve, reject) => {
    const yt = spawn(YTDLP, ytdlpArgs(['--no-playlist', '-f', 'bestaudio/best', '-o', '-', src], proxy))
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

// Clave CANÓNICA: los términos de búsqueda (no-URL) se resuelven al link real del
// video para que "despacito" y el link del mismo video compartan la MISMA clave (no
// se duplica el audio en disco y el badge de la biblioteca queda exacto). Las URLs
// http ya vienen canónicas del bot (cleanYouTubeUrl) → se usan tal cual, SIN costo
// extra (no se llama a yt-dlp). Devuelve también la meta si tuvo que resolverla.
async function resolveKeyAndUrl(src) {
  if (/^https?:\/\//i.test(src)) return { key: keyOf(src), url: src, meta: null }
  // Claves sintéticas de subidas manuales (sin URL real de la que extraer nada):
  // ya son canónicas, no hay que resolverlas por yt-dlp.
  if (/^upload:/.test(src)) return { key: keyOf(src), url: src, meta: null }
  const meta = await getMeta(src)            // resuelve + cachea (yt-dlp solo la 1ª vez)
  const url = meta.url || src
  return { key: keyOf(url), url, meta }
}

// Baja la carátula (si no está) y la sirve. Guarda art/<key> + el mime en el índice.
async function serveArt(res, src) {
  let key, url, pre
  try { pre = await resolveKeyAndUrl(src); key = pre.key; url = pre.url } catch (e) { res.writeHead(404); return res.end('sin meta: ' + e.message) }
  const file = join(ART_DIR, key)
  const overrideFile = join(ART_OVERRIDE_DIR, key)
  const mimeOf = u => {
    const e = (u.split(/[?#]/)[0].split('.').pop() || '').toLowerCase()
    return e === 'png' ? 'image/png' : e === 'webp' ? 'image/webp' : e === 'gif' ? 'image/gif' : 'image/jpeg'
  }
  // Carátula elegida a mano (admin): prioridad sobre la miniatura auto-descargada.
  if (existsSync(overrideFile) && index[key]?.artOverrideMime) {
    res.writeHead(200, { 'Content-Type': index[key].artOverrideMime, 'Cache-Control': 'no-store' })
    return createReadStream(overrideFile).pipe(res)
  }
  if (existsSync(file) && index[key]?.artMime) {
    res.writeHead(200, { 'Content-Type': index[key].artMime, 'Cache-Control': 'public, max-age=86400' })
    return createReadStream(file).pipe(res)
  }
  let meta = pre.meta
  if (!meta) {
    // Si la meta no está en disco y NO hay slot libre, la carátula exigiría un
    // yt-dlp que quedaría encolado tras las extracciones de audio. En vez de
    // bloquear, devolvemos vacío (404): el bot usa sus fuentes alternativas.
    if (!existsSync(metaPath(key)) && !slotFree()) { res.writeHead(404); return res.end('worker ocupado (sin slot)') }
    try { meta = await getMeta(url) } catch (e) { res.writeHead(404); return res.end('sin meta: ' + e.message) }
  }
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
// Traduce un error de yt-dlp de playlist a un mensaje claro para el usuario.
function classifyPlaylistError(text) {
  const t = (text || '').toLowerCase()
  if (/private|privada/.test(t)) return 'La playlist es PRIVADA. Cámbiala a "Pública" o "No listada" en YouTube y reintenta.'
  if (/does not exist|unavailable|deleted|removed|not found|no longer|404/.test(t)) return 'La playlist no existe o fue eliminada. Verifica que el enlace sea correcto.'
  if (/sign in|log in|confirm you|members-only|cookies|age/.test(t)) return 'La playlist requiere iniciar sesión (es privada o solo para miembros).'
  return 'No se pudo acceder a la playlist. Asegúrate de que el enlace sea correcto y de que la playlist sea pública o "no listada".'
}

async function getPlaylist(src) {
  let out
  try {
    out = await withSlot(() => ytdlpTextWithFallback(['--flat-playlist', '--print',
      '%(url)s\t%(title)s\t%(duration)s\t%(playlist_title)s\t%(thumbnail)s', src]))
  } catch (e) {
    const err = new Error(classifyPlaylistError(e.message))
    err.playlistError = true
    throw err
  }
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
      const { key, url } = await resolveKeyAndUrl(src)
      const file = audioPath(key)
      if (existsSync(file)) return streamCached(res, file, seek, key)
      return await extractAndStream(res, url, seek, key, true)
    }

    if (p === '/art' && req.method === 'GET') {
      if (!needSrc()) return
      return await serveArt(res, src)
    }

    if (p === '/ensure' && req.method === 'POST') {
      if (!needSrc()) return
      const { key, url } = await resolveKeyAndUrl(src)
      if (existsSync(audioPath(key))) { touch(key); return sendJson(res, 200, { cached: true }) }
      try {
        await downloadToCache(url, key)
        return sendJson(res, 200, { cached: true })
      } catch (e) {
        return sendJson(res, 500, { error: e.message })
      }
    }

    if (p === '/keep' && req.method === 'POST') {
      if (!needSrc()) return
      const keep = u.searchParams.get('keep') !== '0'
      const { key } = await resolveKeyAndUrl(src)
      touch(key, { keep })
      return sendJson(res, 200, { keep })
    }

    if (p === '/cache' && req.method === 'DELETE') {
      if (!needSrc()) return
      const { key } = await resolveKeyAndUrl(src)
      deleteCachedFiles(key)
      return sendJson(res, 200, { deleted: true })
    }

    if (p === '/playlist' && req.method === 'GET') {
      if (!needSrc()) return
      try { return sendJson(res, 200, await getPlaylist(src)) }
      catch (e) { return sendJson(res, e.playlistError ? 422 : 500, { error: e.message }) }
    }

    // Catálogo de canciones (Biblioteca), compartido por todos los entornos.
    if (p === '/songs' && req.method === 'GET') {
      return sendJson(res, 200, dbList().map(annotateArt))
    }
    if (p === '/songs/one' && req.method === 'GET') {
      const id = u.searchParams.get('id')
      const url = u.searchParams.get('url')
      const song = id ? dbGetById(id) : url ? dbFindByUrl(url) : null
      if (!song) { res.writeHead(404); return res.end('not found') }
      return sendJson(res, 200, annotateArt(song))
    }
    if (p === '/songs' && req.method === 'POST') {
      const sourceUrl = u.searchParams.get('sourceUrl')
      if (!sourceUrl) { res.writeHead(400); return res.end('missing sourceUrl') }
      const num = v => (v == null || v === '') ? null : Number(v)
      return sendJson(res, 200, annotateArt(dbUpsert({
        sourceUrl,
        title: u.searchParams.get('title'),
        artist: u.searchParams.get('artist'),
        album: u.searchParams.get('album'),
        durationMs: num(u.searchParams.get('durationMs')),
        ext: u.searchParams.get('ext'),
      })))
    }
    if (p === '/songs/update' && req.method === 'POST') {
      const id = u.searchParams.get('id')
      if (!id) { res.writeHead(400); return res.end('missing id') }
      const patch = {}
      if (u.searchParams.has('title')) patch.title = u.searchParams.get('title')
      if (u.searchParams.has('artist')) patch.artist = u.searchParams.get('artist')
      if (u.searchParams.has('album')) patch.album = u.searchParams.get('album')
      if (u.searchParams.has('durationMs')) patch.durationMs = Number(u.searchParams.get('durationMs'))
      if (u.searchParams.has('permanent')) patch.permanent = u.searchParams.get('permanent') === '1'
      const song = dbUpdate(id, patch)
      if (!song) { res.writeHead(404); return res.end('not found') }
      return sendJson(res, 200, annotateArt(song))
    }
    if (p === '/songs/play' && req.method === 'POST') {
      const id = u.searchParams.get('id')
      if (!id) { res.writeHead(400); return res.end('missing id') }
      const song = dbBumpPlay(id)
      if (!song) { res.writeHead(404); return res.end('not found') }
      return sendJson(res, 200, annotateArt(song))
    }
    if (p === '/songs' && req.method === 'DELETE') {
      const id = u.searchParams.get('id')
      if (!id) { res.writeHead(400); return res.end('missing id') }
      const song = dbDelete(id)
      if (!song) { res.writeHead(404); return res.end('not found') }
      deleteCachedFiles(keyOf(song.source_url))
      return sendJson(res, 200, { deleted: true })
    }
    if (p === '/songs/art' && req.method === 'POST') {
      const id = u.searchParams.get('id')
      if (!id) { res.writeHead(400); return res.end('missing id') }
      const song = dbGetById(id)
      if (!song) { res.writeHead(404); return res.end('not found') }
      const key = keyOf(song.source_url)
      const chunks = []; let size = 0
      for await (const c of req) { size += c.length; if (size > 8 * 1024 * 1024) break; chunks.push(c) }
      if (size > 8 * 1024 * 1024) { res.writeHead(413); return res.end('too large') }
      const buf = Buffer.concat(chunks)
      if (!buf.length) { return sendJson(res, 400, { error: 'sin datos' }) }
      writeFileSync(join(ART_OVERRIDE_DIR, key), buf)
      const mime = (req.headers['content-type'] || 'image/jpeg').split(';')[0].trim()
      touch(key, { artOverrideMime: mime })
      return sendJson(res, 200, { ok: true })
    }

    // Importar un audio YA descargado (lo sube el bot desde su disco local): se
    // transcodifica a Opus y se guarda con la clave canónica. Sirve para subir al
    // worker canciones que solo un nodo podía bajar (geo-restringidas) y que queden
    // accesibles desde todos los ambientes. Cuerpo = bytes de audio crudo.
    if (p === '/import' && req.method === 'POST') {
      if (!needSrc()) return
      const { key } = await resolveKeyAndUrl(src)
      const ff = spawn(FFMPEG, ['-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'libopus', '-b:a', `${MUSIC_BITRATE}k`, '-f', 'ogg', 'pipe:1'])
      const tmp = `${audioPath(key)}.${process.pid}.${Date.now()}.part`
      const ws = createWriteStream(tmp)
      let ffErr = '', failed = false
      const fail = (code, msg) => { if (failed) return; failed = true; try { rmSync(tmp, { force: true }) } catch {}; try { ff.kill('SIGKILL') } catch {}; if (!res.headersSent) { res.writeHead(code); res.end(msg) } }
      req.on('error', () => fail(400, 'error de subida'))
      req.pipe(ff.stdin)
      ff.stdout.pipe(ws)
      ff.stdin.on('error', () => {})
      ff.stderr.on('data', d => { if (ffErr.length < 2000) ffErr += d })
      ff.on('error', e => fail(500, 'ffmpeg: ' + e.message))
      ws.on('finish', () => {
        if (failed) return
        try {
          if (statSync(tmp).size < 1000) return fail(422, 'audio inválido/vacío: ' + ffErr.slice(0, 200))
          renameSync(tmp, audioPath(key))
          touch(key, { size: statSync(audioPath(key)).size })
          evictIfNeeded()
          sendJson(res, 200, { imported: true, key, size: statSync(audioPath(key)).size })
        } catch (e) { fail(500, e.message) }
      })
      return
    }

    // Claves (sha1 de la URL) que el worker tiene cacheadas en disco. La web lo cruza
    // con la biblioteca para indicar dónde está cada canción (local vs worker).
    if (p === '/cached-keys' && req.method === 'GET') {
      const keys = Object.keys(index).filter(k => existsSync(audioPath(k)))
      return sendJson(res, 200, { keys })
    }

    // Ajustes en caliente desde "Variables Generales": concurrencia, tope de caché
    // en disco (GB) y bitrate de música (kbps). El bot los empuja al arrancar y al
    // cambiarlos en el panel.
    if (p === '/config') {
      if (req.method === 'POST') {
        const c = parseInt(u.searchParams.get('concurrency') || '', 10)
        if (!isNaN(c)) setMaxConc(c)
        const gb = parseFloat(u.searchParams.get('maxGb') || '')
        if (!isNaN(gb) && gb > 0) { MAX_BYTES = Math.round(gb * 1024 ** 3); evictIfNeeded() }
        const br = parseInt(u.searchParams.get('bitrate') || '', 10)
        if (!isNaN(br) && br > 0) MUSIC_BITRATE = Math.min(256, Math.max(64, br))
      }
      return sendJson(res, 200, {
        concurrency: MAX_CONC, active, queued: waiters.length,
        maxGb: +(MAX_BYTES / 1024 ** 3).toFixed(1), bitrate: MUSIC_BITRATE,
      })
    }

    // Cookies de YouTube: subir/consultar. Persisten en /data/cookies.txt.
    if (p === '/cookies/status' && req.method === 'GET') {
      const path = existsSync(COOKIES_DATA) ? COOKIES_DATA : (existsSync(COOKIES) ? COOKIES : null)
      if (!path) return sendJson(res, 200, { exists: false })
      const st = statSync(path)
      return sendJson(res, 200, { exists: true, size: st.size, mtime: st.mtimeMs, path })
    }
    if (p === '/cookies' && req.method === 'POST') {
      const chunks = []; let size = 0
      for await (const c of req) { size += c.length; if (size > 2 * 1024 * 1024) break; chunks.push(c) }
      if (size > 2 * 1024 * 1024) { res.writeHead(413); return res.end('too large') }
      const content = Buffer.concat(chunks).toString('utf8').trim()
      if (!content) { return sendJson(res, 400, { error: 'Contenido vacío' }) }
      writeFileSync(COOKIES_DATA, content + '\n', 'utf8')
      reloadCookies()
      console.log(`cookies actualizadas (${content.length} bytes) → ${COOKIES_RW}`)
      const st = statSync(COOKIES_DATA)
      return sendJson(res, 200, { ok: true, size: st.size })
    }

    if (p === '/stream-logs' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      // Enviar el historial acumulado
      for (const line of LOG_RING) res.write('data: ' + line + '\n\n')
      // Seguir enviando nuevos logs en tiempo real
      const listener = line => { try { res.write('data: ' + line + '\n\n') } catch {} }
      logListeners.add(listener)
      req.on('close', () => logListeners.delete(listener))
      return
    }

    res.writeHead(404); res.end('not found')
  } catch (e) {
    console.error('handler:', e.message)
    if (!res.headersSent) res.writeHead(500)
    res.end('error: ' + e.message)
  }
})

server.listen(PORT, () => console.log(`music-worker escuchando en :${PORT} (data=${DATA_DIR}, max=${(MAX_BYTES / 1024 ** 3).toFixed(0)}GB)`))
