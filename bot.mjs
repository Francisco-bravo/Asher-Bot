// Bot de música — versión para Oracle Cloud Always Free (VM ARM Ampere A1)
// Recursos: hasta 4 núcleos ARM64 + 24 GB RAM, así que se restaura el
// mezclador de sonidos completo (que en Wispbyte free se había quitado por
// los 512 MB). Diferencias con la versión local de Windows:
//  - Corre con Node.js; el servidor del panel usa node:http
//  - Rutas relativas al proyecto y puerto desde variables de entorno
//  - yt-dlp se descarga solo según la arquitectura (aarch64 / x86_64)
//  - Panel web protegido con contraseña (PANEL_PASSWORD) vía HTTP Basic
//  - Si existe cookies.txt se pasa a yt-dlp (mitiga el bloqueo de YouTube
//    a IPs de datacenter)
import {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType
} from 'discord.js'
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, StreamType
} from '@discordjs/voice'
import { spawn } from 'node:child_process'
import {
  readdirSync, existsSync, mkdirSync, readFileSync, writeFileSync,
  createWriteStream, chmodSync, renameSync, rmSync
} from 'node:fs'
import { join, extname, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import http from 'node:http'
import ffmpegStatic from 'ffmpeg-static'
import { getDb } from './lib/db.mjs'
import * as soundLib from './lib/sounds.mjs'
import * as playHistory from './lib/history.mjs'
import * as auth from './lib/auth.mjs'
import * as rbac from './lib/rbac.mjs'
import * as musicCache from './lib/music-cache.mjs'
import * as art from './lib/art.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const IS_WIN = process.platform === 'win32'
// En la VM se prefiere el ffmpeg del sistema (apt install ffmpeg), que en ARM
// es más fiable que el binario empaquetado; cae a ffmpeg-static si no está.
const FFMPEG = process.env.FFMPEG_PATH ||
  (existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : ffmpegStatic)

// yt-dlp: binario standalone según arquitectura (no necesita python3)
const YTDLP_ASSET = IS_WIN ? null
  : process.arch === 'arm64' ? 'yt-dlp_linux_aarch64'
  : process.arch === 'x64' ? 'yt-dlp_linux'
  : 'yt-dlp'
const YTDLP = process.env.YTDLP_PATH || join(ROOT, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp')
const YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}`
const COOKIES = join(ROOT, 'cookies.txt')
const SOUNDS_DIR = join(ROOT, 'sounds')
const PANEL_HTML = join(ROOT, 'panel.html')
const SETTINGS_FILE = join(ROOT, 'settings.json')
const PORT = Number(process.env.PANEL_PORT || process.env.PORT || 8765)
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || ''
// Login compartido con la capa web (web.mjs). El panel valida la cookie de
// sesión `sid` contra la misma DB; si no hay sesión, redirige al login OAuth
// de la web y ésta vuelve al panel. WEB_URL es la web vista desde el navegador
// y PANEL_URL es a dónde debe volver la web tras el login.
const WEB_URL = (process.env.WEB_URL || 'http://localhost:8770').replace(/\/$/, '')
const PANEL_URL = (process.env.PANEL_URL || `http://localhost:${PORT}`).replace(/\/$/, '')
// Orígenes del navegador autorizados a llamar a esta API con credenciales (CORS).
// En Pages el panel vive en otro subdominio (panel-test.aronne.dev). Lista por
// coma en PANEL_ORIGIN; en dev cualquier localhost se permite automáticamente.
const PANEL_ORIGINS = new Set((process.env.PANEL_ORIGIN || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean))
const SOUND_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.webm'])
const MUSIC_DUCK = 0.35 // volumen de la música mientras suena un efecto
const MAX_QUEUE = 100
const MAX_HISTORY = 100

// Volumen de los efectos del soundboard, regulable desde el panel y persistido
let soundVolume = 0.9
try { soundVolume = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')).soundVolume ?? 0.9 } catch {}
function saveSettings() {
  try { writeFileSync(SETTINGS_FILE, JSON.stringify({ soundVolume })) } catch {}
}

if (!existsSync(SOUNDS_DIR)) mkdirSync(SOUNDS_DIR, { recursive: true })

// ── yt-dlp: descarga automática en Linux ──────────────────────────────────
async function ensureYtDlp() {
  if (existsSync(YTDLP)) return
  if (IS_WIN) throw new Error(`No se encontró ${YTDLP}`)
  console.log(`Descargando yt-dlp (${YTDLP_ASSET})...`)
  const res = await fetch(YTDLP_URL, { redirect: 'follow' })
  if (!res.ok) throw new Error(`No se pudo descargar yt-dlp: HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(YTDLP))
  chmodSync(YTDLP, 0o755)
  console.log('yt-dlp listo.')
}

function ytdlpArgs(extra) {
  // Runtimes JS para el desafío de YouTube: Bun (primario) y Node (respaldo).
  // Se quitó Deno de la VM porque, si está presente, yt-dlp lo prefiere siempre.
  // Sin --no-cache-dir para que yt-dlp cachee el solve y repetir un tema sea rápido.
  const args = ['--no-playlist', '--quiet',
    '--js-runtimes', 'bun:/usr/local/bin/bun',
    '--js-runtimes', 'node:/usr/bin/node']
  if (existsSync(COOKIES)) args.push('--cookies', COOKIES)
  return args.concat(extra)
}

// ── Estado ────────────────────────────────────────────────────────────────
// item: { url, title, duration, voiceChannelId, guildId, textChannelId }
const queue = []
const history = []
let current = null
let currentResource = null
// Trabajo de fondo (metadata/carátula/pre-cacheo): corre SOLO cuando no hay un
// stream de reproducción descargando → JAMÁS dos yt-dlp a la vez (regla estricta).
// Cuando arranca una reproducción se mata el yt-dlp de fondo en curso.
// Gapless: al cerrar el yt-dlp de la canción actual (descarga terminada) se
// dispara el pre-cacheo a DISCO de la siguiente; cuando la actual termina de
// sonar, la siguiente ya está en disco y arranca sin la extracción de ~10s.
let prefetching = false        // el trabajo de fondo está activo
let streamDownloading = false  // hay un yt-dlp de reproducción descargando (incluye la
                               // extracción inicial)
let currentPlaying = false     // la canción actual YA está sonando (pasó la extracción
                               // inicial) → se permite enriquecer en paralelo al stream
const metaBackfillTried = new Set() // ids de canciones ya intentadas en el backfill de metadata
let bgProc = null              // proceso yt-dlp de fondo en curso (para poder matarlo)
let bgSongId = null            // id de la canción que el fondo está pre-cacheando
let bgPromise = null           // promesa del pre-cacheo en curso (para esperarlo si toca)
const BG_WORK_INTERVAL = 10000 // cada 10s intenta enriquecer/cachear de fondo
let seekOffset = 0      // segundos ya descartados por seek en el stream actual
let seekTarget = 0      // desde dónde arrancar el próximo stream
let transition = 'next' // qué hacer cuando el player quede idle: next | previous | seek | stop
let playing = false
let connection = null
let currentChannelId = null
let currentChannelName = null
let soundActive = 0
let activeProcs = []
let soundIdSeq = 0
const activeSounds = new Map() // id -> { file, proc, ov?, mixer?, direct? }

const musicPlayer = createAudioPlayer()
const soundPlayer = createAudioPlayer()

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ]
})

// ── Mixer de audio ────────────────────────────────────────────────────────
// Mezcla PCM s16le 48kHz estéreo: la música es la base y los sonidos del
// soundboard se suman encima con la música atenuada a MUSIC_DUCK.
const SILENCE = Buffer.alloc(19200) // 50ms de silencio
const BYTES_PER_MS = 192 // PCM s16le 48kHz estéreo
const LEAD_BYTES = 96000 // ~500ms de adelanto máximo sobre lo reproducido

class MixerStream extends Readable {
  // getPlayedMs: cuántos ms lleva reproducidos el player. El mixer solo avanza
  // LEAD_BYTES por delante de eso; sin este freno, el encoder opus consume la
  // canción entera en segundos, el mixer "termina" y los sonidos del soundboard
  // ya no tienen dónde mezclarse.
  constructor(base, getPlayedMs = () => Infinity) {
    super()
    this.base = base
    this.getPlayedMs = getPlayedMs
    this.baseEnded = false
    this.ended = false
    this.pushedBytes = 0
    this.leftover = null
    this.silenceTimer = null
    this.paceTimer = null
    this.overlays = new Set()
    base.on('end', () => { this.baseEnded = true; this._pump() })
    base.on('error', () => { this.baseEnded = true; this._pump() })
    base.on('readable', () => this._pump())
  }

  addOverlay(stream) {
    // Buffer propio alimentado en modo flowing por los 'data' del proceso de
    // ffmpeg del efecto; se va consumiendo al ritmo de la base.
    const ov = { chunks: [], length: 0, ended: false }
    stream.on('data', d => { ov.chunks.push(d); ov.length += d.length; this._pump() })
    stream.on('end', () => { ov.ended = true; this._pump() })
    stream.on('error', () => { ov.ended = true; this._pump() })
    this.overlays.add(ov)
    this._pump()
    return ov
  }

  _takeFrom(ov, n) {
    const parts = []
    let need = n
    while (need > 0 && ov.chunks.length > 0) {
      const head = ov.chunks[0]
      if (head.length <= need) { parts.push(head); ov.chunks.shift(); need -= head.length }
      else { parts.push(head.subarray(0, need)); ov.chunks[0] = head.subarray(need); need = 0 }
    }
    ov.length -= n - need
    return parts.length === 1 ? parts[0] : Buffer.concat(parts)
  }

  _read() { this._pump() }

  _pump() {
    if (this.destroyed || this.ended) return
    while (true) {
      // Freno de tiempo real: no adelantarse más de LEAD_BYTES a lo reproducido
      if (this.pushedBytes >= this.getPlayedMs() * BYTES_PER_MS + LEAD_BYTES) {
        if (!this.paceTimer) {
          this.paceTimer = setTimeout(() => { this.paceTimer = null; this._pump() }, 50)
        }
        return
      }
      let chunk
      if (this.leftover) { chunk = this.leftover; this.leftover = null }
      else chunk = this.base.read()
      if (chunk === null) {
        if (!this.baseEnded) return // esperar más datos de la música
        if (this.overlays.size === 0) { this.ended = true; this.push(null); return }
        // La música terminó pero hay un sonido en curso: seguir con silencio,
        // a ritmo de timer (no de la demanda del consumidor, que puede ser
        // sincrónica e infinita).
        this._scheduleSilence()
        return
      }
      // Trocear chunks grandes: read() puede devolver mucho de golpe y el freno
      // de pacing solo actúa entre chunks.
      if (chunk.length > SILENCE.length) {
        this.leftover = chunk.subarray(SILENCE.length)
        chunk = chunk.subarray(0, SILENCE.length)
      }
      const out = this.overlays.size > 0 ? this._mix(chunk) : chunk
      this.pushedBytes += out.length
      if (!this.push(out)) return
    }
  }

  _scheduleSilence() {
    if (this.silenceTimer) return
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null
      if (this.destroyed || this.ended) return
      if (this.overlays.size === 0) { this.ended = true; this.push(null); return }
      const out = this._mix(SILENCE)
      this.pushedBytes += out.length
      this.push(out)
      this._scheduleSilence()
    }, 45)
  }

  _mix(chunk) {
    const out = Buffer.from(chunk)
    for (let i = 0; i + 1 < out.length; i += 2) {
      out.writeInt16LE((out.readInt16LE(i) * MUSIC_DUCK) | 0, i)
    }
    for (const ov of [...this.overlays]) {
      if (ov.ended && ov.length === 0) { this.overlays.delete(ov); continue }
      const avail = Math.min(out.length, ov.length) & ~1
      if (avail === 0) continue
      const data = this._takeFrom(ov, avail)
      for (let i = 0; i + 1 < data.length && i + 1 < out.length; i += 2) {
        let v = out.readInt16LE(i) + ((data.readInt16LE(i) * soundVolume) | 0)
        if (v > 32767) v = 32767
        else if (v < -32768) v = -32768
        out.writeInt16LE(v, i)
      }
    }
    return out
  }
}

// Mixer del soundboard SIN música: base de SILENCIO sobre la que se mezclan N
// sonidos a la vez (sin límite, sin "uno a la vez"). Paceado a tiempo real. Se
// auto-cierra tras unos segundos sin sonidos y devuelve la conexión al player de
// música. El volumen (soundVolume) se aplica al mezclar, en vivo.
class SoundMixer extends Readable {
  constructor() {
    super()
    this.overlays = new Set()
    this.pushedBytes = 0
    this.startMs = Date.now()
    this.lastActive = Date.now()
    this._closed = false
    this.timer = null
    this._schedule()
  }
  addOverlay(stream) {
    const ov = { chunks: [], length: 0, ended: false }
    stream.on('data', d => { ov.chunks.push(d); ov.length += d.length })
    stream.on('end', () => { ov.ended = true })
    stream.on('error', () => { ov.ended = true })
    this.overlays.add(ov)
    this.lastActive = Date.now()
    return ov
  }
  _takeFrom(ov, n) {
    const parts = []
    let need = n
    while (need > 0 && ov.chunks.length > 0) {
      const head = ov.chunks[0]
      if (head.length <= need) { parts.push(head); ov.chunks.shift(); need -= head.length }
      else { parts.push(head.subarray(0, need)); ov.chunks[0] = head.subarray(need); need = 0 }
    }
    ov.length -= n - need
    return parts.length === 1 ? parts[0] : Buffer.concat(parts)
  }
  _read() {}
  _mix() {
    const out = Buffer.alloc(SILENCE.length) // base de silencio
    for (const ov of [...this.overlays]) {
      if (ov.ended && ov.length === 0) { this.overlays.delete(ov); continue }
      const avail = Math.min(out.length, ov.length) & ~1
      if (avail === 0) continue
      const data = this._takeFrom(ov, avail)
      for (let i = 0; i + 1 < data.length; i += 2) {
        let v = out.readInt16LE(i) + ((data.readInt16LE(i) * soundVolume) | 0)
        if (v > 32767) v = 32767
        else if (v < -32768) v = -32768
        out.writeInt16LE(v, i)
      }
    }
    return out
  }
  _schedule() {
    this.timer = setTimeout(() => {
      if (this._closed) return
      const now = Date.now()
      const target = (now - this.startMs) * BYTES_PER_MS // realtime: nunca adelantarse
      while (this.pushedBytes < target) {
        const out = this._mix()
        this.pushedBytes += out.length
        this.push(out)
      }
      if (this.overlays.size > 0) this.lastActive = now
      if (now - this.lastActive > 2000) { this.close(); return } // sin sonidos: cerrar
      this._schedule()
    }, 20)
  }
  close() {
    if (this._closed) return
    this._closed = true
    if (this.timer) clearTimeout(this.timer)
    try { this.push(null) } catch {}
    if (soundMixer === this) soundMixer = null
    if (connection) { try { connection.subscribe(musicPlayer) } catch {} }
  }
}
let soundMixer = null

let currentMixer = null

// ── Streaming ─────────────────────────────────────────────────────────────
// Prioridad: cuando hay un stream de reproducción, marca streamDownloading para
// que el cacheador/carátula/metadata NO lancen otro yt-dlp en paralelo (la VM
// tiene 2 vCPU y el solve de YouTube se starva si compiten).
function startStream(item, seekSec) {
  killBgYtdlp() // prioridad a la reproducción: jamás dos yt-dlp a la vez
  const yt = spawn(YTDLP, ytdlpArgs(['-f', 'bestaudio/best', '-o', '-', item.url]))
  const args = ['-loglevel', 'error', '-i', 'pipe:0']
  if (seekSec > 0) args.push('-ss', String(seekSec))
  args.push('-vn', '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1')
  const ff = spawn(FFMPEG, args)
  streamDownloading = true
  yt.stdout.pipe(ff.stdin)
  yt.stdout.on('error', () => {})
  ff.stdin.on('error', () => {})
  yt.on('error', err => console.error('yt-dlp:', err.message))
  ff.on('error', err => console.error('ffmpeg:', err.message))
  ff.stderr.on('data', d => process.stderr.write(d))
  // Al cerrar (descarga terminada) ya hay CPU libre: pre-cachea la siguiente.
  yt.on('close', () => { streamDownloading = false; backgroundWork() })
  activeProcs = [yt, ff]
  return ff.stdout
}

// Stream-first: reproduce mientras descarga (arranque rápido) y, con la MISMA
// descarga de yt-dlp, guarda el archivo en la caché para la próxima vez (sin
// doblar la carga de la VM). El archivo cacheado solo se valida si yt-dlp
// termina limpio (código 0 y no se saltó/cortó la canción).
function startStreamAndCache(item, seekSec, song) {
  killBgYtdlp() // prioridad a la reproducción: jamás dos yt-dlp a la vez
  const yt = spawn(YTDLP, ytdlpArgs(['-f', 'bestaudio/best', '-o', '-', item.url]))
  const args = ['-loglevel', 'error', '-i', 'pipe:0']
  if (seekSec > 0) args.push('-ss', String(seekSec))
  args.push('-vn', '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1')
  const ff = spawn(FFMPEG, args)

  const cp = musicCache.cachePath(song)
  const partPath = `${cp}.${process.pid}.${Date.now()}.part`
  let cacheFile = null
  try { cacheFile = createWriteStream(partPath) } catch { cacheFile = null }
  streamDownloading = true // ocupa el yt-dlp: el trabajo de fondo cede hasta que termine

  yt.stdout.pipe(ff.stdin)
  if (cacheFile) { yt.stdout.pipe(cacheFile); cacheFile.on('error', () => { cacheFile = null }) }
  yt.stdout.on('error', () => {})
  ff.stdin.on('error', () => {})
  yt.on('error', err => console.error('yt-dlp:', err.message))
  ff.on('error', err => console.error('ffmpeg:', err.message))
  ff.stderr.on('data', d => process.stderr.write(d))
  yt.on('close', async code => {
    streamDownloading = false
    if (cacheFile) { try { cacheFile.end() } catch {} }
    const ok = code === 0 && cacheFile && existsSync(partPath)
    if (ok) {
      try {
        renameSync(partPath, cp)
        await musicCache.registerPlay(song, cp) // contabiliza + persiste al cruzar umbral
        console.log(`Cacheado en segundo plano: canción ${song.id}`)
      } catch (e) {
        console.warn('Cacheo en segundo plano falló:', e.message)
        try { rmSync(partPath, { force: true }) } catch {}
      }
    } else {
      try { rmSync(partPath, { force: true }) } catch {}
    }
    backgroundWork() // descarga terminada → pre-cachea la siguiente (gapless)
  })
  activeProcs = [yt, ff]
  return ff.stdout
}

function killStreamProcs() {
  for (const p of activeProcs) { try { p.kill() } catch {} }
  activeProcs = []
}

function fetchMeta(item) {
  return new Promise(resolve => {
    const proc = spawn(YTDLP, ytdlpArgs([
      '--skip-download', '--print', '%(title)s\n%(duration)s', item.url
    ]))
    bgProc = proc
    let out = ''
    proc.stdout.on('data', d => out += d)
    proc.on('error', () => { if (bgProc === proc) bgProc = null; resolve() })
    proc.on('close', () => {
      if (bgProc === proc) bgProc = null
      const [title, dur] = out.trim().split('\n')
      if (title) item.title = title
      const d = parseFloat(dur)
      if (!isNaN(d)) item.duration = d
      updatePanel()
      resolve()
    })
  })
}

function elapsed() {
  if (!currentResource) return 0
  return seekOffset + currentResource.playbackDuration / 1000
}

function waitIdle(player) {
  return new Promise(resolve => {
    const onIdle = () => { player.off('error', onErr); resolve(null) }
    const onErr = (err) => { player.off(AudioPlayerStatus.Idle, onIdle); resolve(err) }
    player.once(AudioPlayerStatus.Idle, onIdle)
    player.once('error', onErr)
  })
}

// ── Caché de música (lib/music-cache) ──────────────────────────────────────
// Lee un único campo de metadatos con yt-dlp (resuelve búsquedas a URL real).
function ytdlpPrint(url, field) {
  return new Promise(resolve => {
    const proc = spawn(YTDLP, ytdlpArgs(['--skip-download', '--print', `%(${field})s`, url]))
    bgProc = proc
    let out = ''
    proc.stdout.on('data', d => out += d)
    proc.on('error', () => { if (bgProc === proc) bgProc = null; resolve(null) })
    proc.on('close', () => { if (bgProc === proc) bgProc = null; resolve(out.trim() || null) })
  })
}

// Mata el yt-dlp de fondo en curso (si lo hay). Se llama al arrancar una
// reproducción para garantizar que nunca corran dos yt-dlp a la vez.
function killBgYtdlp() {
  if (bgProc) { try { bgProc.kill() } catch {} bgProc = null }
}

// URL canónica para indexar la caché: las URLs directas se usan tal cual; las
// búsquedas (ytsearch1: de nombre/Spotify/Apple) se resuelven al video real.
// Si ya es una clave conocida (p.ej. una canción subida), se usa directo.
async function resolveSource(item) {
  if (/^https?:\/\//i.test(item.url)) return item.url
  if (musicCache.findByUrl(item.url)) return item.url
  return (await ytdlpPrint(item.url, 'webpage_url')) || item.url
}

// Descarga el audio a un archivo exacto (destPath). yt-dlp escribe con su propia
// extensión, así que bajamos a destPath.<ext> y renombramos a destPath.
function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP, ytdlpArgs(['-f', 'bestaudio/best', '-o', `${destPath}.%(ext)s`, url]))
    bgProc = proc
    let err = ''
    proc.stderr.on('data', d => err += d)
    proc.on('error', e => { if (bgProc === proc) bgProc = null; reject(e) })
    proc.on('close', code => {
      if (bgProc === proc) bgProc = null
      if (code !== 0) return reject(new Error(`yt-dlp salió con código ${code}: ${err.trim()}`))
      const dir = dirname(destPath)
      const prefix = basename(destPath) + '.'
      const produced = readdirSync(dir).find(f => f.startsWith(prefix))
      if (!produced) return reject(new Error('yt-dlp no produjo ningún archivo'))
      renameSync(join(dir, produced), destPath)
      resolve()
    })
  })
}

// Obtiene la carátula con yt-dlp y la guarda con la misma lógica del caché:
// se baja una sola vez y queda persistida en el object-store (art_key). Si ya
// está guardada, no hace nada. Best-effort: nunca rompe la reproducción.
async function ensureSongArt(song, sourceUrl) {
  if (!song || song.art_key) return
  try {
    const thumb = await ytdlpPrint(sourceUrl, 'thumbnail')
    if (!thumb || !/^https?:\/\//i.test(thumb)) return
    const res = await fetch(thumb)
    if (!res.ok) return
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) return
    let ext = (thumb.split(/[?#]/)[0].split('.').pop() || '').toLowerCase()
    if (!/^(jpg|jpeg|png|webp|gif)$/.test(ext)) ext = 'jpg'
    await art.store(song.id, buf, ext)
    song.art_key = `art/${song.id}.${ext}`
  } catch { /* sin carátula: no pasa nada */ }
}

// Descarga a la caché SIN reproducir ni contar reproducción ("forzar caché").
async function forceCacheAudio(item) {
  const sourceUrl = await resolveSource(item)
  const song = musicCache.findByUrl(sourceUrl)
    || musicCache.upsertSong({ sourceUrl, title: item.title })
  await musicCache.ensureCached(song, destPath => downloadToFile(sourceUrl, destPath))
  await ensureSongArt(song, sourceUrl) // al forzar caché, también traemos la carátula
  return song
}

// Resuelve la canción de un item SIN gastar yt-dlp si ya se conoce (songId o URL
// directa ya registrada). Solo resuelve (yt-dlp) términos de búsqueda nuevos.
function songForItem(item) {
  if (item.songId) { const s = musicCache.getById(item.songId); if (s) return s }
  if (/^https?:\/\//i.test(item.url)) { const s = musicCache.findByUrl(item.url); if (s) return s }
  return null
}

// ¿El título guardado es "pobre"? (vacío o es la propia URL/un enlace)
function isPoorTitle(t, sourceUrl) {
  return !t || t === sourceUrl || /^https?:\/\//i.test(t)
}

// Enriquece un item (metadata + carátula). Devuelve true si hizo una tarea yt-dlp.
// Importante: persiste el título/duración en la FILA de la canción (Biblioteca y
// Caché leen de ahí); antes solo se actualizaba el item en memoria y quedaban
// guardadas con la URL como título.
async function enrich(item) {
  if (!item || !item.url) return false
  // Resolver/crear la canción primero, para poder actualizar su fila.
  let song = songForItem(item)
  const sourceUrl = song ? song.source_url : await resolveSource(item)
  if (!song) song = musicCache.findByUrl(sourceUrl) || musicCache.upsertSong({ sourceUrl, title: item.title })
  if (item.songId !== song.id) { item.songId = song.id; updatePanel() }
  // 1) Metadata (una sola vez por item): obtiene título/duración reales y los
  //    GUARDA en la canción. Se hace si falta la duración o el título es pobre.
  if (!item.metaTried && (!item.duration || isPoorTitle(song.title, song.source_url))) {
    item.metaTried = true
    await fetchMeta(item) // setea item.title/duration reales (si los hay)
    const goodTitle = !isPoorTitle(item.title, sourceUrl) ? item.title : null
    const durationMs = (item.duration && !isNaN(item.duration)) ? item.duration * 1000 : null
    song = musicCache.setMeta(song.id, { title: goodTitle, durationMs })
    updatePanel()
    return true
  }
  // 2) Carátula.
  if (!song.art_key) { await ensureSongArt(song, sourceUrl); updatePanel(); return true }
  return false
}

// Pre-cachea un item a DISCO si no está ya. Devuelve true si descargó algo.
// Rastrea la canción/promesa en curso para que la reproducción pueda esperarla
// (si va a sonar justo esa) en vez de re-extraerla.
async function cacheToDisk(item) {
  if (!item || !item.url) return false
  let song = songForItem(item)
  const sourceUrl = song ? song.source_url : await resolveSource(item)
  if (!song) song = musicCache.findByUrl(sourceUrl) || musicCache.upsertSong({ sourceUrl, title: item.title })
  item.songId = song.id
  if (musicCache.hasLocal(song) || song.persisted) return false // ya lista
  // bgPromise = SOLO la descarga del audio (lo que la reproducción necesita
  // esperar para arrancar gapless); la carátula va después, sin bloquear el play.
  bgSongId = song.id
  bgPromise = musicCache.ensureCached(song, dest => downloadToFile(sourceUrl, dest))
  try {
    await bgPromise
    console.log(`Pre-cacheada a disco (gapless): canción ${song.id}`)
  } finally {
    if (bgSongId === song.id) { bgSongId = null; bgPromise = null }
  }
  await ensureSongArt(song, sourceUrl) // carátula serial (dentro del candado), ya no la espera el play
  return true
}

// Trabajo de fondo. UNA tarea por llamada, en este orden de prioridad:
//   PRIORIDAD 0: la descarga del stream que va a sonar — no se toca; el enriquecido
//      NO corre durante la extracción inicial (currentPlaying=false) para no frenar
//      el arranque, y al arrancar una reproducción se mata el yt-dlp de fondo.
//   1) METADATA + CARÁTULA de la actual y de la cola — corre mientras la canción
//      SUENA, aunque el stream siga descargando (se acepta un 2º yt-dlp: el audio
//      ya está buffereado y no se interrumpe). Tiene MÁS prioridad que el pre-cacheo.
//   2) PRE-CACHEO a disco (la siguiente primero) — solo cuando NO hay un stream
//      descargando (para no correr dos descargas sostenidas a la vez).
// Se encadena cada 1.5s mientras haya trabajo.
async function backgroundWork() {
  if (prefetching) return
  prefetching = true
  let didWork = false
  try {
    // 1) Enriquecer (metadata + carátula) mientras la canción ya suena.
    if (currentPlaying) {
      if (await enrich(current)) didWork = true
      else for (const item of queue) { if (await enrich(item)) { didWork = true; break } }
    }
    // 2) Pre-cachear a disco la cola (la siguiente primero), solo sin stream activo.
    if (!didWork && !streamDownloading) for (const item of queue) {
      if (streamDownloading) break
      if (await cacheToDisk(item)) { didWork = true; break }
    }
    // 3) Backfill (lo más bajo): arregla metadata de UNA canción ya guardada con
    //    título pobre (Biblioteca/Caché viejas). Una por ciclo, sin reintentos.
    if (!didWork) {
      const broken = musicCache.listAll().find(s => isPoorTitle(s.title, s.source_url) && !metaBackfillTried.has(s.id))
      if (broken) {
        metaBackfillTried.add(broken.id)
        if (await enrich({ url: broken.source_url, songId: broken.id })) didWork = true
      }
    }
  } catch { /* reintenta en el próximo tick */ } finally {
    prefetching = false
  }
  if (didWork) setTimeout(() => backgroundWork(), 1500)
}
setInterval(() => { backgroundWork() }, BG_WORK_INTERVAL)
setInterval(() => { backgroundWork() }, BG_WORK_INTERVAL)

// Reproduce desde un archivo local ya descargado (el seek es seek de archivo).
function startFileStream(filePath, seekSec) {
  const args = ['-loglevel', 'error']
  if (seekSec > 0) args.push('-ss', String(seekSec))
  args.push('-i', filePath, '-vn', '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1')
  const ff = spawn(FFMPEG, args)
  ff.on('error', err => console.error('ffmpeg:', err.message))
  ff.stderr.on('data', d => process.stderr.write(d))
  activeProcs = [ff]
  return ff.stdout
}

// ── Conexión de voz ───────────────────────────────────────────────────────
async function ensureConnection(voiceChannelId, guildId) {
  if (connection && currentChannelId === voiceChannelId) return
  if (connection) {
    connection.destroy()
    connection = null
    await new Promise(r => setTimeout(r, 500))
  }
  const vc = await client.channels.fetch(voiceChannelId)
  connection = joinVoiceChannel({
    channelId: voiceChannelId,
    guildId,
    adapterCreator: vc.guild.voiceAdapterCreator,
  })
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout conectando al canal de voz')), 20000)
    const onReady = () => { clearTimeout(timeout); connection.off('error', onErr); resolve() }
    const onErr = (err) => { clearTimeout(timeout); connection.off(VoiceConnectionStatus.Ready, onReady); reject(err) }
    connection.once(VoiceConnectionStatus.Ready, onReady)
    connection.once('error', onErr)
  })
  connection.subscribe(musicPlayer)
  currentChannelId = voiceChannelId
  currentChannelName = vc.name
}

function destroyConnection() {
  if (connection) {
    try { connection.destroy() } catch {}
    connection = null
    currentChannelId = null
    currentChannelName = null
  }
}

// ── Motor de reproducción ─────────────────────────────────────────────────
async function ensurePlaying() {
  if (playing) return
  playing = true
  try {
    while (true) {
      if (!current) {
        if (queue.length === 0) break
        current = queue.shift()
      }
      try {
        await ensureConnection(current.voiceChannelId, current.guildId)
      } catch (err) {
        console.error('Error de conexión:', err.message)
        await notifyError(current, err)
        current = null
        continue
      }

      seekOffset = seekTarget
      seekTarget = 0
      currentPlaying = false // aún en extracción/carga: no enriquecer hasta que suene
      console.log(`Reproduciendo: ${current.title || current.url}${seekOffset ? ` (desde ${seekOffset}s)` : ''}`)
      // PRIORIDAD: arrancar la reproducción cuanto antes, con UN solo yt-dlp.
      // No se resuelve ni se baja carátula/metadata aquí (eso lo hace el proceso
      // de inactividad). Solo se usa el archivo si ya está COMPLETO en caché.
      let stream
      try {
        const raw = current.url
        const isUrl = /^https?:\/\//i.test(raw)
        let song = isUrl ? musicCache.findByUrl(raw) : null
        // Si el fondo está pre-cacheando JUSTO esta canción, espera a que termine
        // (segundos de descarga) en vez de matarla y re-extraer (~10s). Gapless.
        if (song && bgSongId === song.id && bgPromise) {
          try { await bgPromise } catch {}
          song = musicCache.findByUrl(raw) // refresca el estado tras el pre-cacheo
        }
        if (song && (musicCache.hasLocal(song) || song.persisted)) {
          // Cacheada completa → archivo (instantáneo, con seek). Sin yt-dlp.
          const filePath = await musicCache.getLocalAudio(song, dest => downloadToFile(raw, dest))
          stream = startFileStream(filePath, seekOffset)
        } else if (isUrl) {
          // URL no cacheada: stream + tee a caché en la MISMA descarga (1 yt-dlp).
          const s = song || musicCache.upsertSong({ sourceUrl: raw, title: current.title })
          current.songId = s.id
          stream = startStreamAndCache({ ...current, url: raw }, seekOffset, s)
        } else {
          // Término de búsqueda: stream directo (yt-dlp resuelve y reproduce en una
          // sola pasada). El cacheo/resolución lo hará el proceso de inactividad.
          stream = startStream(current, seekOffset)
        }
      } catch (err) {
        console.warn('Reproducción: fallback a streaming directo:', err.message)
        stream = startStream(current, seekOffset)
      }
      currentMixer = new MixerStream(stream, () => currentResource ? currentResource.playbackDuration : 0)
      currentResource = createAudioResource(currentMixer, { inputType: StreamType.Raw })
      musicPlayer.play(currentResource)
      updatePanel()
      // Cuando el audio EMPIEZA a sonar (pasó la extracción inicial), se habilita el
      // enriquecido en paralelo (metadata + carátula) aunque el stream siga bajando.
      musicPlayer.once(AudioPlayerStatus.Playing, () => { currentPlaying = true; backgroundWork() })

      const err = await waitIdle(musicPlayer)
      currentPlaying = false // terminó: no enriquecer esta canción ya
      killStreamProcs()
      currentResource = null
      currentMixer = null
      if (err) {
        console.error('Error reproduciendo:', err.message)
        await notifyError(current, err)
      }

      const t = transition
      transition = 'next'
      if (t === 'next') {
        history.push(current)
        if (history.length > MAX_HISTORY) history.shift()
        current = null
      } else if (t === 'previous') {
        queue.unshift(current)
        current = history.pop() ?? queue.shift()
      } else if (t === 'seek') {
        // current se mantiene, seekTarget ya viene seteado
      } else if (t === 'stop') {
        // Stop: la canción se trata como terminada (pasa a reproducidas), pero
        // NO se avanza a la siguiente. El bot queda detenido sin desconectarse.
        history.push(current)
        if (history.length > MAX_HISTORY) history.shift()
        current = null
        break
      }
    }
  } finally {
    playing = false
    currentResource = null
    currentMixer = null
    // El bot NO se desconecta solo al quedar inactivo: permanece en el canal
    // hasta que alguien use el botón Desconectar.
    updatePanel()
  }
}

async function notifyError(item, err) {
  if (!item.textChannelId) return
  try {
    const ch = await client.channels.fetch(item.textChannelId)
    await ch.send(`Error reproduciendo \`${item.title || item.url}\`: ${err.message}`)
  } catch {}
}

// ── Resolución de links de otras plataformas ─────────────────────────────
// Spotify y Apple Music usan DRM: no se pueden streamear sin cuenta. Se leen
// los metadatos públicos del link (sin cuenta) y se busca la canción en
// YouTube con ytsearch1:. SoundCloud/Bandcamp/etc. los soporta yt-dlp directo.
async function spotifyMeta(url) {
  // El HTML público trae "<title>Canción - song and lyrics by Artista | Spotify</title>"
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    const html = await res.text()
    const m = html.match(/<title>([^<]+)<\/title>/)
    if (m && !/^Spotify/.test(m[1])) {
      return m[1]
        .replace(/\s*\|\s*Spotify\s*$/, '')
        .replace(/ - (song( and lyrics)?|canción( y letra)?) (by|de) /, ' ')
        .trim()
    }
  } catch {}
  const res = await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(url))
  if (!res.ok) throw new Error('No se pudo leer el link de Spotify')
  const d = await res.json()
  if (!d.title) throw new Error('No se pudo leer el link de Spotify')
  return d.title
}

async function resolveInput(url) {
  url = url.trim()
  // No es un link: tratarlo como búsqueda en YouTube
  if (!/^https?:\/\/\S+$/i.test(url)) {
    if (!url) throw new Error('Escribe una URL o el nombre de una canción')
    return { url: `ytsearch1:${url}`, title: `🔎 ${url}` }
  }
  if (/^https?:\/\/open\.spotify\.com\//.test(url)) {
    if (!/\/track\//.test(url))
      throw new Error('De Spotify solo se soportan links de canciones (track), no playlists ni álbumes')
    const q = await spotifyMeta(url)
    return { url: `ytsearch1:${q}`, title: `${q} (vía YouTube)` }
  }
  if (/^https?:\/\/music\.apple\.com\//.test(url)) {
    const id = (url.match(/[?&]i=(\d+)/) || url.match(/\/song\/[^/]+\/(\d+)/) || [])[1]
    if (!id) throw new Error('De Apple Music solo se soportan links de canciones, no playlists ni álbumes')
    const res = await fetch(`https://itunes.apple.com/lookup?id=${id}`)
    const data = await res.json().catch(() => null)
    const t = data && data.results && data.results[0]
    if (!t || !t.trackName) throw new Error('No se pudo leer el link de Apple Music')
    return { url: `ytsearch1:${t.artistName} ${t.trackName}`, title: `${t.artistName} - ${t.trackName} (vía YouTube)` }
  }
  return { url }
}

// ── Comandos del motor ────────────────────────────────────────────────────
function addToQueue(url, voiceChannelId, guildId, textChannelId, title) {
  if (queue.length >= MAX_QUEUE) throw new Error(`La cola está llena (máximo ${MAX_QUEUE})`)
  const item = { url, title: title || url, duration: null, voiceChannelId, guildId, textChannelId }
  // La metadata (título/duración) NO se pide aquí para no lanzar otro yt-dlp que
  // compita con el arranque del stream; la rellena backgroundWork cuando ya suena.
  queue.push(item)
  const startsNow = !current && queue.length === 1
  ensurePlaying()
  updatePanel()
  // No se dispara backgroundWork aquí: si esta canción arranca ahora, su stream
  // marcará streamDownloading y backgroundWork se gatea solo. El intervalo, el
  // cierre del yt-dlp y el evento Playing ya cubren el enriquecido/pre-cacheo.
  return { startsNow, position: queue.length }
}

function cmdSkip() {
  if (!current) return false
  transition = 'next'
  musicPlayer.stop()
  return true
}

function cmdPrevious() {
  if (current) {
    transition = 'previous'
    musicPlayer.stop()
    return true
  }
  if (history.length > 0) {
    current = history.pop()
    ensurePlaying()
    return true
  }
  return false
}

function cmdSeek(toSeconds) {
  if (!current) return false
  seekTarget = Math.max(0, toSeconds)
  transition = 'seek'
  musicPlayer.stop()
  return true
}

function cmdPause() {
  if (musicPlayer.state.status !== AudioPlayerStatus.Playing) return false
  musicPlayer.pause()
  updatePanel()
  return true
}

function cmdResume() {
  if (musicPlayer.state.status !== AudioPlayerStatus.Paused) return false
  musicPlayer.unpause()
  updatePanel()
  return true
}

function cmdStop() {
  // Detiene la canción actual como si hubiera terminado (pasa a reproducidas);
  // NO inicia la siguiente, NO borra la cola y NO se desconecta. El bot queda
  // detenido en el canal hasta que alguien reproduzca o agregue una canción.
  if (!current) return false
  transition = 'stop'
  musicPlayer.stop()
  return true
}

// ── Panel de control en el chat de Discord ────────────────────────────────
let panelMsg = null

const fmtDur = s => { s = Math.floor(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

function seekStep(total) {
  for (const s of [15, 30, 60, 120, 300, 600]) if (total / s <= 24) return s
  return Math.ceil(total / 24)
}

// "2:35" → 155, "1:02:05" → 3725, "95" → 95; null si es inválido
function parseTime(str) {
  const parts = String(str).trim().split(':')
  if (parts.length === 0 || parts.length > 3) return null
  let s = 0
  for (const p of parts) {
    if (p.trim() === '' || isNaN(p)) return null
    s = s * 60 + parseFloat(p)
  }
  return s
}

function progressBar() {
  if (!current || !current.duration) return null
  const pos = Math.min(elapsed(), current.duration)
  const n = 14
  const idx = Math.min(n - 1, Math.floor(pos / current.duration * n))
  return '▬'.repeat(idx) + '🔘' + '▬'.repeat(n - 1 - idx) + `  ${fmtDur(pos)} / ${fmtDur(current.duration)}`
}

function panelPayload() {
  const paused = musicPlayer.state.status === AudioPlayerStatus.Paused
  const lines = []
  if (current) {
    lines.push(`${paused ? '⏸' : '▶'} **${current.title}**`)
    const bar = progressBar()
    if (bar) lines.push(bar)
  } else {
    lines.push('Nada reproduciéndose')
  }
  if (queue.length > 0) {
    lines.push('', '**Cola:**')
    queue.slice(0, 5).forEach((it, i) => lines.push(`${i + 1}. ${it.title}${it.duration ? ` (${fmtDur(it.duration)})` : ''}`))
    if (queue.length > 5) lines.push(`… y ${queue.length - 5} más`)
  }
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(PANEL_TITLE)
    .setDescription(lines.join('\n'))
  if (currentChannelName) embed.setFooter({ text: `🔊 ${currentChannelName}` })
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mp_prev').setEmoji('⏮').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mp_back10').setLabel('-10s').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mp_toggle').setEmoji(paused ? '▶' : '⏸').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('mp_fwd10').setLabel('+10s').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mp_skip').setEmoji('⏭').setStyle(ButtonStyle.Secondary),
  )
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mp_goto').setEmoji('🕐').setLabel('Ir a...').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mp_stop').setEmoji('⏹').setLabel('Detener').setStyle(ButtonStyle.Danger),
  )
  const rows = [row1, row2]
  // Menú "Saltar a...": posiciones espaciadas según la duración (máx 25 opciones)
  if (current && current.duration) {
    const step = seekStep(current.duration)
    const opts = []
    for (let t = 0; t < current.duration && opts.length < 25; t += step) {
      opts.push({ label: fmtDur(t), value: String(t) })
    }
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('mp_seekto').setPlaceholder('⏩ Saltar a...').addOptions(opts)
    ))
  }
  return { embeds: [embed], components: rows }
}

const PANEL_TITLE = '🎵 Panel de música'

async function sendPanel(textChannelId) {
  try {
    const ch = await client.channels.fetch(textChannelId)
    if (panelMsg) { try { await panelMsg.delete() } catch {} ; panelMsg = null }
    // Borrar también paneles de sesiones anteriores del bot (la referencia en
    // memoria se pierde al reiniciar): buscar en los últimos mensajes del canal
    try {
      const msgs = await ch.messages.fetch({ limit: 50 })
      for (const m of msgs.values()) {
        if (m.author.id === client.user.id && m.embeds[0]?.title === PANEL_TITLE) {
          try { await m.delete() } catch {}
        }
      }
    } catch {}
    panelMsg = await ch.send({ ...panelPayload(), flags: 4096 }) // 4096 = @silent, sin notificación
  } catch (err) { console.error('panel:', err.message) }
}

let panelUpdateQueued = false
function updatePanel() {
  if (!panelMsg || panelUpdateQueued) return
  // Agrupar actualizaciones seguidas en una sola edición (evita rate limits)
  panelUpdateQueued = true
  setTimeout(async () => {
    panelUpdateQueued = false
    if (!panelMsg) return
    try { await panelMsg.edit(panelPayload()) } catch {}
  }, 300)
}

// Refrescar la barra de progreso mientras suena algo (10s mantiene las
// ediciones muy por debajo del rate limit de Discord)
setInterval(() => {
  if (panelMsg && current && musicPlayer.state.status === AudioPlayerStatus.Playing) updatePanel()
}, 10000)

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === 'p') {
    const query = interaction.options.getString('cancion', true)
    const member = await interaction.guild.members.fetch(interaction.user.id)
    if (!member.voice.channel) {
      await interaction.reply({ content: 'Necesitas estar en un canal de voz para usar `/p`.', flags: 64 }) // 64 = efímero
      return
    }
    await interaction.deferReply({ flags: 64 })
    let resolved
    try {
      resolved = await resolveInput(query)
    } catch (err) {
      await interaction.editReply(err.message)
      return
    }
    let r
    try {
      r = addToQueue(resolved.url, member.voice.channel.id, interaction.guildId, interaction.channelId, resolved.title)
    } catch (err) {
      await interaction.editReply(err.message)
      return
    }
    await interaction.editReply(r.startsNow
      ? `Reproduciendo en **${member.voice.channel.name}** 🎵`
      : `Agregado a la cola (posición ${r.position})`)
    await sendPanel(interaction.channelId)
    return
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'mp_seekto') {
    cmdSeek(Number(interaction.values[0]))
    try { await interaction.deferUpdate() } catch {}
    updatePanel()
    return
  }

  if (interaction.isModalSubmit() && interaction.customId === 'mp_goto_modal') {
    const t = parseTime(interaction.fields.getTextInputValue('mp_goto_time'))
    if (t === null) {
      await interaction.reply({ content: 'Tiempo inválido. Usa por ejemplo `2:35` o `95` (segundos).', flags: 64 }).catch(() => {})
      return
    }
    if (!cmdSeek(t)) {
      await interaction.reply({ content: 'No hay nada reproduciéndose.', flags: 64 }).catch(() => {})
      return
    }
    try { await interaction.deferUpdate() } catch {}
    updatePanel()
    return
  }

  if (!interaction.isButton()) return
  const id = interaction.customId

  if (id === 'mp_goto') {
    if (!current) {
      await interaction.reply({ content: 'No hay nada reproduciéndose.', flags: 64 }).catch(() => {})
      return
    }
    const modal = new ModalBuilder().setCustomId('mp_goto_modal').setTitle('Ir a un tiempo de la canción')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('mp_goto_time')
          .setLabel('Tiempo (ej: 2:35, o en segundos: 95)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(10)
      ))
    await interaction.showModal(modal).catch(() => {})
    return
  }

  if (id === 'mp_prev') cmdPrevious()
  else if (id === 'mp_back10') cmdSeek(elapsed() - 10)
  else if (id === 'mp_toggle') { if (!cmdPause()) cmdResume() }
  else if (id === 'mp_fwd10') cmdSeek(elapsed() + 10)
  else if (id === 'mp_skip') cmdSkip()
  else if (id === 'mp_stop') cmdStop()
  else return
  try { await interaction.deferUpdate() } catch {}
  updatePanel()
})

// ── Soundboard ────────────────────────────────────────────────────────────
function listSounds() {
  const result = [] // rutas relativas a SOUNDS_DIR, con '/'
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(dir, entry.name), r)
      else if (SOUND_EXTS.has(extname(entry.name).toLowerCase())) result.push(r)
    }
  }
  walk(SOUNDS_DIR, '')
  return result.sort((a, b) => a.localeCompare(b, 'es'))
}

function soundTree() {
  // Árbol de carpetas anidadas: { name, sounds: [{file,label}], folders: [...] }
  const root = { name: '', sounds: [], folders: new Map() }
  for (const file of listSounds()) {
    const parts = file.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.folders.has(parts[i])) node.folders.set(parts[i], { name: parts[i], sounds: [], folders: new Map() })
      node = node.folders.get(parts[i])
    }
    node.sounds.push({ file, label: parts[parts.length - 1].replace(/\.[^.]+$/, '') })
  }
  const toJSON = n => ({
    name: n.name,
    sounds: n.sounds,
    folders: [...n.folders.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'es'))
      .map(toJSON),
  })
  return toJSON(root)
}

// Sonido "directo" (sin música): solo puede haber uno a la vez porque comparten
// el soundPlayer. play() reemplaza al anterior SIN emitir Idle, así que la
// limpieza se hace aquí y se invoca tanto desde el listener persistente de Idle
// como al reemplazar un sonido por otro.
let currentDirectId = null
let directResource = null

function finishDirectSound() {
  if (currentDirectId === null) return
  const e = activeSounds.get(currentDirectId)
  activeSounds.delete(currentDirectId)
  currentDirectId = null
  directResource = null
  if (e) { try { e.proc.kill() } catch {} }
  soundActive = 0
  if (connection) connection.subscribe(musicPlayer)
}

soundPlayer.on(AudioPlayerStatus.Idle, finishDirectSound)
soundPlayer.on('error', err => { console.error('sound:', err.message); finishDirectSound() })

function spawnSoundFfmpeg(filePath) {
  // Sin filtro de volumen: el volumen se aplica al mezclar (overlays) o con
  // inlineVolume (directo), para que el slider del panel actúe en vivo.
  const ff = spawn(FFMPEG, [
    '-loglevel', 'error', '-i', filePath,
    '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1'
  ])
  ff.on('error', err => console.error('ffmpeg sonido:', err.message))
  ff.stderr.on('data', d => process.stderr.write(d))
  return ff
}

async function playSound(soundId) {
  const sound = soundLib.getById(Number(soundId))
  if (!sound) throw new Error('Sonido no encontrado')
  const filePath = soundLib.localPath(sound)
  if (!existsSync(filePath)) throw new Error('Archivo del sonido no disponible')
  const key = String(sound.id) // identificador estable que usa el panel
  const id = ++soundIdSeq
  playHistory.record({ kind: 'sound', refId: sound.id })

  // Con música sonando: mezclar el sonido encima, música atenuada
  if (currentMixer && musicPlayer.state.status === AudioPlayerStatus.Playing) {
    const ff = spawnSoundFfmpeg(filePath)
    activeProcs.push(ff)
    const ov = currentMixer.addOverlay(ff.stdout)
    activeSounds.set(id, { file: key, proc: ff, ov, mixer: currentMixer })
    return id
  }

  // Sin música: mezclar sobre un SoundMixer dedicado para que suenen VARIOS a la
  // vez (sin límite). Requiere que el bot YA esté en un canal; no se conecta solo.
  if (!connection) throw new Error('El bot no está en un canal de voz')

  if (!soundMixer) {
    soundMixer = new SoundMixer()
    const res = createAudioResource(soundMixer, { inputType: StreamType.Raw })
    connection.subscribe(soundPlayer)
    soundPlayer.play(res)
  }
  const ff = spawnSoundFfmpeg(filePath)
  const ov = soundMixer.addOverlay(ff.stdout)
  activeSounds.set(id, { file: key, proc: ff, ov, mixer: soundMixer })
  return id
}

function cmdSoundVolume(v) {
  if (typeof v !== 'number' || isNaN(v)) return false
  soundVolume = Math.min(2, Math.max(0, v))
  if (directResource) directResource.volume.setVolume(soundVolume)
  saveSettings()
  return true
}

// Sonidos que siguen reproduciéndose; limpia de paso las entradas terminadas
function playingSounds() {
  const out = []
  for (const [id, e] of activeSounds) {
    if (e.ov && e.mixer && (e.mixer === currentMixer || e.mixer === soundMixer) && e.mixer.overlays.has(e.ov)) {
      out.push({ id, file: e.file })
    } else {
      activeSounds.delete(id)
    }
  }
  return out
}

function cmdStopSound(id) {
  if (id === undefined) {
    let stopped = false
    for (const sid of [...activeSounds.keys()]) stopped = cmdStopSound(sid) || stopped
    return stopped
  }
  const e = activeSounds.get(id)
  if (!e) return false
  try { e.proc.kill() } catch {}
  if (e.ov) {
    e.ov.ended = true; e.ov.chunks = []; e.ov.length = 0
    if (e.mixer) e.mixer.overlays.delete(e.ov)
    activeSounds.delete(id)
  }
  if (e.direct) soundPlayer.stop() // el listener de Idle (finishDirectSound) limpia la entrada
  return true
}

// ── Comandos de texto en Discord ──────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return
  const content = message.content.trim()

  if (content.startsWith('!p ')) {
    const url = content.slice(3).trim()
    if (!url) { await message.reply('Uso: `!p <url o nombre de canción>`'); return }

    const member = await message.guild.members.fetch(message.author.id)
    if (!member.voice.channel) {
      await message.reply('Necesitas estar en un canal de voz para usar `!p`.')
      return
    }

    let resolved
    try {
      resolved = await resolveInput(url)
    } catch (err) {
      await message.reply(err.message)
      return
    }
    let r
    try {
      r = addToQueue(resolved.url, member.voice.channel.id, message.guildId, message.channelId, resolved.title)
    } catch (err) {
      await message.reply(err.message)
      return
    }
    if (!r.startsNow) {
      await message.reply({ content: `Agregado a la cola (posición ${r.position}) en **${member.voice.channel.name}**`, flags: 4096 })
    }
    await sendPanel(message.channelId)
    return
  }

  if (content === '!skip') {
    await message.reply(cmdSkip() ? 'Saltando canción...' : 'No hay nada reproduciéndose.')
    return
  }

  if (content === '!prev') {
    await message.reply(cmdPrevious() ? 'Volviendo a la canción anterior...' : 'No hay canción anterior.')
    return
  }

  if (content === '!pause') {
    await message.reply(cmdPause() ? 'Pausado.' : 'No hay nada reproduciéndose.')
    return
  }

  if (content === '!resume') {
    await message.reply(cmdResume() ? 'Reanudando...' : 'No hay nada pausado.')
    return
  }

  if (content === '!stop') {
    cmdStop()
    await message.reply('Reproducción detenida. Reproduce o agrega una canción para continuar.')
    return
  }

  if (content === '!queue') {
    if (!current && queue.length === 0) {
      await message.reply('La cola está vacía.')
      return
    }
    const lines = []
    if (current) lines.push(`**Ahora:** ${current.title}`)
    queue.forEach((item, i) => lines.push(`${i + 1}. ${item.title}`))
    await message.reply(lines.join('\n'))
    return
  }
})

// ── Servidor HTTP del panel ───────────────────────────────────────────────
function getState() {
  return {
    current: current ? { url: current.url, title: current.title, duration: current.duration, songId: current.songId ?? null } : null,
    elapsed: elapsed(),
    paused: musicPlayer.state.status === AudioPlayerStatus.Paused,
    queue: queue.map(i => ({ url: i.url, title: i.title, duration: i.duration })),
    // Reproducidas recientes (en memoria), de más antigua a más reciente,
    // para mostrarlas en gris en la cola sin que desaparezcan.
    played: history.slice(-20).map(i => ({ url: i.url, title: i.title, duration: i.duration })),
    historyCount: history.length,
    connected: !!connection,
    voiceChannel: currentChannelName,
    playingSounds: playingSounds(),
    soundVolume,
  }
}

function parseCookies(req) {
  const out = {}
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

// Usuario del panel a partir de la cookie de sesión compartida con la web.
function panelUser(req) {
  const token = parseCookies(req).sid
  return token ? auth.getSession(token) : null
}

// ¿El usuario del panel es administrador? (controles de canal de voz solo-admin)
function isPanelAdmin(req) {
  const u = panelUser(req)
  return !!(u && rbac.isAdmin(u.id))
}

// Fallback legado: HTTP Basic con PANEL_PASSWORD (solo si está configurada).
function authorizedByPassword(req) {
  if (!PANEL_PASSWORD) return false
  const h = req.headers.authorization || ''
  if (!h.startsWith('Basic ')) return false
  const decoded = Buffer.from(h.slice(6), 'base64').toString()
  const pass = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded
  return pass === PANEL_PASSWORD
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = []
    let size = 0
    req.on('data', c => { size += c.length; if (size < 65536) chunks.push(c) })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())) }
      catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

// Canal de voz objetivo SOLO si el bot ya está en un canal. No se mete solo a
// ningún canal: las acciones del panel exigen que el bot ya esté conectado.
function currentVoiceTarget() {
  if (current) return { vcId: current.voiceChannelId, gId: current.guildId }
  if (connection) return { vcId: currentChannelId, gId: connection.joinConfig.guildId }
  return null
}

// Lista los canales de voz de cada servidor con los usuarios que hay dentro,
// para que el panel deje elegir a cuál entrar.
function listVoiceChannels() {
  const out = []
  for (const guild of client.guilds.cache.values()) {
    const channels = []
    for (const ch of guild.channels.cache.values()) {
      if (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice) continue
      const members = []
      for (const vs of guild.voiceStates.cache.values()) {
        if (vs.channelId !== ch.id) continue
        const m = vs.member
        members.push({
          id: vs.id,
          name: m?.displayName || m?.user?.username || 'usuario',
          bot: !!m?.user?.bot,
          avatar: m?.user?.displayAvatarURL?.({ size: 32, extension: 'png' }) || null,
        })
      }
      channels.push({
        id: ch.id, name: ch.name, position: ch.rawPosition ?? 0,
        members, botHere: currentChannelId === ch.id,
      })
    }
    channels.sort((a, b) => a.position - b.position)
    out.push({ guildId: guild.id, guildName: guild.name, channels })
  }
  return out
}

http.createServer(async (req, res) => {
  const sendJson = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  // CORS: el panel en Pages (otro subdominio) llama con credenciales. Se permite
  // el origen exacto configurado (o cualquier localhost en dev). setHeader persiste
  // en todas las respuestas (incluido sendJson).
  const origin = req.headers.origin
  if (origin && (PANEL_ORIGINS.has(origin.replace(/\/$/, '')) || /^https?:\/\/localhost:\d+$/.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  const path = new URL(req.url, 'http://x').pathname
  // Autenticación: sesión compartida con la web; contraseña como respaldo.
  if (!panelUser(req) && !authorizedByPassword(req)) {
    // Si piden la página del panel sin sesión, mándalos al login de la web,
    // que tras autenticar OAuth vuelve a este panel.
    if (req.method === 'GET' && path === '/') {
      const ret = encodeURIComponent(PANEL_URL + '/')
      res.writeHead(302, { Location: `${WEB_URL}/auth/login?return=${ret}` })
      res.end()
      return
    }
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'No autenticado' }))
    return
  }
  try {
    if (req.method === 'GET') {
      if (path === '/') {
        // Inyecta la URL de web.mjs para que el panel sepa a dónde mandar el
        // login/uploads y los endpoints de música sin hardcodearla en el HTML.
        const html = readFileSync(PANEL_HTML, 'utf8')
          .replace('</head>', `<script>window.WEB_BASE=${JSON.stringify(WEB_URL)}</script>\n</head>`)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
        return
      }
      if (path === '/api/state') return sendJson(getState())
      if (path === '/api/sounds') return sendJson(soundLib.tree(soundLib.listForUser(null)))
      if (path === '/api/voice-channels') {
        if (!isPanelAdmin(req)) return sendJson({ error: 'Solo un administrador' }, 403)
        return sendJson(listVoiceChannels())
      }
    }
    if (req.method === 'POST') {
      const body = await readBody(req)
      switch (path) {
        case '/api/play': {
          if (!body.url) return sendJson({ error: 'Falta la URL' }, 400)
          const resolved = await resolveInput(body.url)
          const t = currentVoiceTarget()
          if (!t) return sendJson({ error: 'El bot no está en un canal de voz' }, 400)
          const r = addToQueue(resolved.url, t.vcId, t.gId, null, resolved.title)
          return sendJson({ ok: true, ...r })
        }
        case '/api/music/cache': {
          if (!body.url) return sendJson({ error: 'Falta la URL' }, 400)
          const resolved = await resolveInput(body.url)
          const song = await forceCacheAudio({ url: resolved.url, title: resolved.title })
          return sendJson({ ok: true, id: song.id, title: song.title })
        }
        case '/api/music/play': {
          const song = musicCache.getById(body.id)
          if (!song) return sendJson({ error: 'Canción no encontrada' }, 404)
          const t = currentVoiceTarget()
          if (!t) return sendJson({ error: 'El bot no está en un canal de voz' }, 400)
          const r = addToQueue(song.source_url, t.vcId, t.gId, null, song.title || song.source_url)
          return sendJson({ ok: true, ...r })
        }
        case '/api/skip': return sendJson({ ok: cmdSkip() })
        case '/api/previous': return sendJson({ ok: cmdPrevious() })
        case '/api/pause': return sendJson({ ok: cmdPause() })
        case '/api/resume': return sendJson({ ok: cmdResume() })
        case '/api/stop': cmdStop(); return sendJson({ ok: true })
        case '/api/seek': {
          const to = body.to !== undefined ? body.to : elapsed() + (body.delta || 0)
          return sendJson({ ok: cmdSeek(to) })
        }
        case '/api/queue/remove': {
          const i = body.index
          if (i === undefined || i < 0 || i >= queue.length) return sendJson({ error: 'Índice inválido' }, 400)
          queue.splice(i, 1)
          updatePanel()
          return sendJson({ ok: true })
        }
        case '/api/queue/reorder': {
          const { from, to } = body
          if (from === undefined || to === undefined ||
              from < 0 || from >= queue.length || to < 0 || to >= queue.length)
            return sendJson({ error: 'Movimiento inválido' }, 400)
          const [it] = queue.splice(from, 1)
          queue.splice(to, 0, it)
          updatePanel()
          return sendJson({ ok: true })
        }
        case '/api/queue/move': {
          const { index, dir } = body
          const j = index + dir
          if (index === undefined || j < 0 || j >= queue.length || index < 0 || index >= queue.length)
            return sendJson({ error: 'Movimiento inválido' }, 400)
          ;[queue[index], queue[j]] = [queue[j], queue[index]]
          updatePanel()
          return sendJson({ ok: true })
        }
        case '/api/sound': {
          const id = await playSound(body.name)
          return sendJson({ ok: true, id })
        }
        case '/api/sound/stop': return sendJson({ ok: cmdStopSound(body.id) })
        case '/api/sound/volume': return sendJson({ ok: cmdSoundVolume(body.volume) })
        case '/api/disconnect': {
          if (!isPanelAdmin(req)) return sendJson({ error: 'Solo un administrador' }, 403)
          cmdStop()
          queue.length = 0   // al desconectar sí se vacía la cola (reset completo)
          destroyConnection()
          return sendJson({ ok: true })
        }
        case '/api/voice/join': {
          if (!isPanelAdmin(req)) return sendJson({ error: 'Solo un administrador puede mover el bot de canal' }, 403)
          if (!body.channelId) return sendJson({ error: 'Falta el canal' }, 400)
          const ch = await client.channels.fetch(body.channelId).catch(() => null)
          if (!ch || (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice))
            return sendJson({ error: 'Canal de voz no válido' }, 400)
          try {
            await ensureConnection(ch.id, ch.guild.id)
            updatePanel()
            return sendJson({ ok: true, channel: ch.name })
          } catch (err) {
            return sendJson({ error: err.message }, 500)
          }
        }
      }
    }
    res.writeHead(404)
    res.end('Not found')
  } catch (err) {
    sendJson({ error: err.message }, 500)
  }
}).listen(PORT, () => console.log(`Panel de control en el puerto ${PORT}`))

client.once('clientReady', async () => {
  console.log(`Bot listo: ${client.user.tag}`)
  // Registrar /p en cada servidor (a nivel de guild aparece al instante)
  const commands = [{
    name: 'p',
    description: 'Reproducir música: nombre de canción o URL (YouTube, SoundCloud, Spotify, Apple Music)',
    options: [{
      type: 3, // string
      name: 'cancion',
      description: 'Nombre de la canción o URL',
      required: true,
    }],
  }]
  for (const guild of client.guilds.cache.values()) {
    try { await guild.commands.set(commands) }
    catch (err) { console.error(`No se pudo registrar /p en ${guild.name}:`, err.message) }
  }
  console.log('Comandos: !p <url o nombre> | !skip | !prev | !pause | !resume | !stop | !queue')
  console.log(`Sonidos del soundboard: ${SOUNDS_DIR}`)
})

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error('Falta la variable de entorno DISCORD_BOT_TOKEN')
  process.exit(1)
}

await ensureYtDlp().catch(err => {
  console.error('yt-dlp:', err.message)
  console.error('Sube el binario de yt-dlp manualmente a la carpeta del bot.')
})

// Inicializar la capa de almacenamiento y asegurar el espejo local de sonidos
getDb()
await soundLib.syncFromStore()
  .then(r => console.log(`Soundboard: ${r.total} sonidos en DB (${r.restored} restaurados del respaldo)`))
  .catch(err => console.error('sync sonidos:', err.message))

client.login(process.env.DISCORD_BOT_TOKEN)
