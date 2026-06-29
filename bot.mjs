
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
import { AsyncLocalStorage } from 'node:async_hooks'
import ffmpegStatic from 'ffmpeg-static'
import { getDb } from './lib/db.mjs'
import * as soundLib from './lib/sounds.mjs'
import { effectiveGain, setTargetI, TARGET_I } from './lib/loudness.mjs'
import * as folders from './lib/folders.mjs'
import * as playHistory from './lib/history.mjs'
import * as auth from './lib/auth.mjs'
import * as rbac from './lib/rbac.mjs'
import * as musicCache from './lib/music-cache.mjs'
import * as art from './lib/art.mjs'
import * as artsearch from './lib/artsearch.mjs'
import { MixerStream, SoundMixer } from './lib/audio/mixer.mjs'
import { defineGuildSession } from './lib/audio/guild-session.mjs'
import {
  USE_WORKER, workerHeaders, workerAudioUrl, workerMeta, workerEnsure,
  workerKeep, workerPlaylist, pushWorkerConfig as wcPushWorkerConfig,
} from './lib/worker-client.mjs'
import {
  initYtdlp, trackBg, untrackBg, killBgYtdlp, ytdlpArgs,
  ensureYtDlp, ytdlpPrint, ytdlpResolveMetaLocal, ytdlpFlatPlaylistLocal,
} from './lib/audio/ytdlp.mjs'

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
initYtdlp({ YTDLP, COOKIES, IS_WIN, YTDLP_ASSET, YTDLP_URL }) // inyecta rutas al módulo yt-dlp
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
// Nombre de la cookie de sesión: debe coincidir con web.mjs (COOKIE_PREFIX).
// Diferencia entornos que comparten Domain=.aronne.dev (test usa test_sid).
const SID_COOKIE = (process.env.COOKIE_PREFIX || '') + 'sid'
// Orígenes del navegador autorizados a llamar a esta API con credenciales (CORS).
// En Pages el panel vive en otro subdominio (panel-test.aronne.dev). Lista por
// coma en PANEL_ORIGIN; en dev cualquier localhost se permite automáticamente.
const PANEL_ORIGINS = new Set((process.env.PANEL_ORIGIN || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean))
const SOUND_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.webm'])
// Tope de la cola y retención del historial. Configurables en Variables Generales.
let MAX_QUEUE = 100
let MAX_HISTORY = 100

// ── Worker de música (audio en dos nodos, Opción A(ii)) ────────────────────
// Si MUSIC_WORKER_URL está definido, la EXTRACCIÓN/descarga pesada de YouTube se
// hace en el worker remoto (CX33, Alemania) que devuelve Opus por HTTP; aquí solo
// se decodifica ese Opus → PCM para el mixer (CPU trivial). Sin la env, el bot
// usa yt-dlp local exactamente como antes. Los sonidos SIEMPRE son locales.
// El cliente HTTP del worker vive en lib/worker-client.mjs (ver imports).

// Volumen BASE de los sonidos: multiplicador global (1 = normal, 2 = el doble),
// se aplica encima de la igualación por loudness, a todos por igual. Es el único
// volumen de sonidos: ya no hay slider por-usuario (todos suenan igual, normalizados).
let soundBaseVolume = 1
// Duración máxima (segundos) de un sonido al subirlo. Lo aplica web.mjs al subir
// (lee este valor de settings.json). Configurable en Variables Generales.
let maxSoundSeconds = 40
// Atenuación de la música mientras suena un efecto (ducking): factor 0..1 con el
// que se multiplica la música. 0.35 = la música baja al 35% (una bajada del 65%).
let musicDuck = 0.35
// Volumen de la música (multiplicador 0..2; 1 = original). Se aplica en vivo al
// mezclar. Es POR SERVIDOR (S.musicVolume); este global es solo el valor por
// defecto con que nace cada sesión (se carga/guarda en settings.json).
let musicVolume = 1
// Enfriamiento GLOBAL (ms) entre cambios de volumen de música (web + Discord), para
// que no se solapen ajustes de varias personas. Configurable en Variables Generales.
let musicVolumeCooldownMs = 2000
// Objetivo de sonoridad (LUFS) al que se igualan los sonidos. Sube/baja el
// volumen general SIN saturar (lo limita el techo de true-peak). Editable en el panel.
let soundTargetLufs = TARGET_I
// Tope de extracciones yt-dlp simultáneas en el worker (cola lo que exceda).
// Protege la CPU del CX33 y el anti-bot de YouTube. Configurable en Variables Generales.
let workerMaxConcurrency = 3
// Tope de la caché de audio del worker en disco (GB). Configurable en Variables Generales.
let workerCacheMaxGb = 70
// Bitrate del Opus que produce el worker (kbps). Solo afecta descargas NUEVAS;
// lo ya cacheado queda al bitrate viejo. Configurable en Variables Generales.
let musicBitrateKbps = 160
// Ventana (ms) sin soundboard tras la cual una canción vuelve a Opus-directo
// (passthrough, sin mixer). Mayor = prioriza el soundboard más tiempo; 0 = vuelve
// a directo de inmediato (sin ventana de prioridad). Configurable en Variables Generales.
let soundPcmWindowMs = 5 * 60 * 1000
// Tiempo (ms) que el bot espera en un canal SIN personas antes de desconectarse
// solo (detector de actividad). 0 = desactivado. Configurable en Variables Generales.
let idleDisconnectMs = 10 * 60 * 1000
// Servidores con "mantener conectado siempre" (ignoran el auto-desconectar). Es
// un switch solo-admin POR SERVIDOR; persiste entre reinicios. Advertencia en la
// UI: si muchos servidores lo activan, el bot se vuelve más lento a la larga.
const keepAliveGuilds = new Set()
try {
  const s = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
  soundBaseVolume = s.soundBaseVolume ?? 1
  if (s.maxSoundSeconds != null) maxSoundSeconds = s.maxSoundSeconds
  musicDuck = s.musicDuck ?? 0.35
  if (s.musicVolume != null) musicVolume = s.musicVolume
  if (s.musicVolumeCooldownMs != null) musicVolumeCooldownMs = s.musicVolumeCooldownMs
  if (s.soundTargetLufs != null) soundTargetLufs = s.soundTargetLufs
  if (s.workerMaxConcurrency != null) workerMaxConcurrency = s.workerMaxConcurrency
  if (s.workerCacheMaxGb != null) workerCacheMaxGb = s.workerCacheMaxGb
  if (s.musicBitrateKbps != null) musicBitrateKbps = s.musicBitrateKbps
  if (s.soundPcmWindowMs != null) soundPcmWindowMs = s.soundPcmWindowMs
  if (s.idleDisconnectMs != null) idleDisconnectMs = s.idleDisconnectMs
  if (Array.isArray(s.keepAliveGuilds)) for (const g of s.keepAliveGuilds) keepAliveGuilds.add(String(g))
  if (s.maxQueue != null) MAX_QUEUE = s.maxQueue
  if (s.maxHistory != null) MAX_HISTORY = s.maxHistory
} catch {}
soundTargetLufs = setTargetI(soundTargetLufs) // aplica el objetivo cargado
function saveSettings() {
  try { writeFileSync(SETTINGS_FILE, JSON.stringify({ soundBaseVolume, maxSoundSeconds, musicDuck, musicVolume, musicVolumeCooldownMs, soundTargetLufs, workerMaxConcurrency, workerCacheMaxGb, musicBitrateKbps, soundPcmWindowMs, idleDisconnectMs, keepAliveGuilds: [...keepAliveGuilds], maxQueue: MAX_QUEUE, maxHistory: MAX_HISTORY })) } catch {}
}
// Empuja al worker los ajustes de Variables Generales que aplica en caliente
// (concurrencia, tope de caché en disco, bitrate). El cliente está en
// lib/worker-client.mjs; aquí solo se le pasan los valores actuales.
const pushWorkerConfig = () => wcPushWorkerConfig({
  concurrency: workerMaxConcurrency,
  maxGb: workerCacheMaxGb,
  bitrate: musicBitrateKbps,
})
pushWorkerConfig() // al arrancar, sincroniza el worker con el ajuste guardado

if (!existsSync(SOUNDS_DIR)) mkdirSync(SOUNDS_DIR, { recursive: true })

// ── Estado por servidor (GuildSession) ──────────────────────────────────────
// item de la cola: { url, title, duration, voiceChannelId, guildId, textChannelId }
// TODO el estado de reproducción vive en una instancia por servidor de Discord.
// La clase está en lib/audio/guild-session.mjs (contenedor de estado puro); aquí
// se le inyectan sus dependencias (players de @discordjs/voice, el volumen por
// defecto y el callback de "sonido directo terminó" = finishDirectSound, que está
// hoisteado y se referencia perezosamente en el closure).
const GuildSession = defineGuildSession({
  createAudioPlayer,
  AudioPlayerStatus,
  getDefaultMusicVolume: () => musicVolume,
  onSoundIdle: (S) => finishDirectSound(S),
})

const metaBackfillTried = new Set() // ids de canciones ya intentadas en el backfill de metadata
const artBackfillTried = new Set()  // ids ya intentadas en el backfill de carátula
const BG_WORK_INTERVAL = 10000 // cada 10s intenta enriquecer/cachear de fondo

// ── Registro de sesiones por servidor ───────────────────────────────────────
// Una GuildSession por guild de Discord. La primera reutiliza la instancia `S`
// (compat: con un solo servidor, S === getSession(g) === activeSession()).
const S = new GuildSession()
const sessions = new Map()
function getSession(guildId) {
  if (!guildId) return S
  let s = sessions.get(guildId)
  if (!s) {
    if (sessions.size === 0) { S.guildId = guildId; s = S } // 1ª guild = instancia global
    else s = new GuildSession(guildId)
    sessions.set(guildId, s)
  }
  return s
}
// Contexto async: cada entry point (comando Discord / petición web) fija aquí la
// sesión del guild con sessionCtx.run(); así toda la cadena async (incluidos los
// `S = activeSession()` por defecto y las sub-llamadas) usa la sesión correcta
// SIN enhebrarla a mano. Los callbacks de eventos de player/stream disparan FUERA
// del contexto, así que ahí se pasa S explícito (cierre léxico).
const sessionCtx = new AsyncLocalStorage()
// Sesión "activa": la del contexto async si lo hay; si no (panel/web sin guildId
// aún), la que tiene conexión de voz; si ninguna, la primera; si no hay, la global S.
function activeSession() {
  const ctx = sessionCtx.getStore()
  if (ctx) return ctx
  for (const s of sessions.values()) if (s.connection) return s
  return sessions.values().next().value || S
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    // PRIVILEGIADO: hay que activar "Server Members Intent" en el Developer Portal
    // de CADA app o el bot no inicia ("Used disallowed intents"). Garantiza que los
    // miembros (nombres/avatars en voz) estén siempre cacheados.
    GatewayIntentBits.GuildMembers,
  ]
})

// ── Mixer de audio ────────────────────────────────────────────────────────
// MixerStream/SoundMixer viven en lib/audio/mixer.mjs (PCM s16le 48kHz estéreo:
// música de base + sonidos del soundboard encima con ducking). Los volúmenes se
// leen en vivo vía los getters que se pasan al instanciar.
// S.soundMixer y S.currentMixer son campos de S (GuildSession).

// ── Streaming ─────────────────────────────────────────────────────────────
// Prioridad: cuando hay un stream de reproducción, marca S.streamDownloading para
// que el cacheador/carátula/metadata NO lancen otro yt-dlp en paralelo (la VM
// tiene 2 vCPU y el solve de YouTube se starva si compiten).
function startStream(item, seekSec, S = activeSession()) {
  killBgYtdlp() // prioridad a la reproducción: jamás dos yt-dlp a la vez
  const yt = spawn(YTDLP, ytdlpArgs(['-f', 'bestaudio/best', '-o', '-', item.url]))
  const args = ['-loglevel', 'error', '-i', 'pipe:0']
  if (seekSec > 0) args.push('-ss', String(seekSec))
  args.push('-vn', '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1')
  const ff = spawn(FFMPEG, args)
  S.streamDownloading = true
  yt.stdout.pipe(ff.stdin)
  yt.stdout.on('error', () => {})
  ff.stdin.on('error', () => {})
  yt.on('error', err => console.error('yt-dlp:', err.message))
  ff.on('error', err => console.error('ffmpeg:', err.message))
  ff.stderr.on('data', d => process.stderr.write(d))
  // Al cerrar (descarga terminada) ya hay CPU libre: pre-cachea la siguiente.
  yt.on('close', () => { S.streamDownloading = false; backgroundWork(S) })
  S.activeProcs = [yt, ff]
  return ff.stdout
}

// Stream-first: reproduce mientras descarga (arranque rápido) y, con la MISMA
// descarga de yt-dlp, guarda el archivo en la caché para la próxima vez (sin
// doblar la carga de la VM). El archivo cacheado solo se valida si yt-dlp
// termina limpio (código 0 y no se saltó/cortó la canción).
function startStreamAndCache(item, seekSec, song, S = activeSession()) {
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
  S.streamDownloading = true // ocupa el yt-dlp: el trabajo de fondo cede hasta que termine

  yt.stdout.pipe(ff.stdin)
  if (cacheFile) { yt.stdout.pipe(cacheFile); cacheFile.on('error', () => { cacheFile = null }) }
  yt.stdout.on('error', () => {})
  ff.stdin.on('error', () => {})
  yt.on('error', err => console.error('yt-dlp:', err.message))
  ff.on('error', err => console.error('ffmpeg:', err.message))
  ff.stderr.on('data', d => process.stderr.write(d))
  yt.on('close', async code => {
    S.streamDownloading = false
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
    backgroundWork(S) // descarga terminada → pre-cachea la siguiente (gapless)
  })
  S.activeProcs = [yt, ff]
  return ff.stdout
}

// Passthrough: trae el Ogg/Opus del worker y lo entrega TAL CUAL a Discord, sin
// ffmpeg ni re-encode. Espera a confirmar que el worker pudo extraer (res.ok):
// si devuelve error (p.ej. video geo-restringido a la región de Santiago),
// lanza y el llamador cae al camino PCM (que tiene fallback local). Devuelve un
// AudioResource OggOpus listo para reproducir.
async function startRemoteOpusResource(item, seekSec, S = activeSession()) {
  killBgYtdlp() // por si había trabajo de fondo local
  const ac = new AbortController()
  S.remoteAbort = ac
  const res = await fetch(workerAudioUrl(item.url, seekSec), { headers: workerHeaders(), signal: ac.signal })
  if (!res.ok || !res.body) { try { ac.abort() } catch {}; throw new Error(`worker HTTP ${res.status}`) }
  const ogg = Readable.fromWeb(res.body)
  ogg.on('error', () => {})
  ogg.on('end', () => { S.remoteAbort = null })
  S.activeProcs = [] // sin ffmpeg en passthrough; el corte se hace abortando el fetch
  return createAudioResource(ogg, { inputType: StreamType.OggOpus })
}

// Opción A(ii): reproduce desde el worker remoto. El CX33 corre yt-dlp+ffmpeg y
// devuelve Opus por HTTP; aquí solo se decodifica a PCM s16le para el mixer (no
// hay yt-dlp local). Si song y no hay seek, se hace tee del Opus a la caché en la
// misma bajada. Devuelve la salida PCM de inmediato; el fetch se resuelve aparte.
function startRemoteStream(item, seekSec, song, S = activeSession()) {
  killBgYtdlp() // por si había trabajo de fondo local
  S.streamDownloading = true
  const args = ['-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1']
  const ff = spawn(FFMPEG, args)
  ff.on('error', err => console.error('ffmpeg(worker):', err.message))
  ff.stderr.on('data', d => process.stderr.write(d))
  ff.stdin.on('error', () => {})
  S.activeProcs = [ff]

  // El audio se almacena en el DISCO DEL WORKER (no se guarda copia local en
  // Santiago). Aquí solo se contabiliza la reproducción (play_count/historial).
  const ac = new AbortController()
  S.remoteAbort = ac
  ;(async () => {
    try {
      const res = await fetch(workerAudioUrl(item.url, seekSec), {
        headers: workerHeaders(),
        signal: ac.signal,
      })
      if (!res.ok || !res.body) throw new Error(`worker HTTP ${res.status}`)
      const web = Readable.fromWeb(res.body)
      web.on('error', () => {})
      web.pipe(ff.stdin)
      web.on('end', () => {
        S.streamDownloading = false
        if (song && seekSec === 0) { try { musicCache.recordPlay(song) } catch {} }
        backgroundWork(S)
      })
    } catch (e) {
      if (ac.signal.aborted) { S.streamDownloading = false; try { ff.stdin.end() } catch {}; return }
      // El worker (Alemania) no pudo extraer. Causa típica: video GEO-RESTRINGIDO a
      // la región de Santiago (disponible en Chile, no en Alemania). Fallback: se
      // extrae LOCALMENTE en Santiago y se alimenta el MISMO ffmpeg decodificador.
      console.warn('worker no pudo servir, fallback local en Santiago:', e.message)
      startLocalFallback(ff, item, song, seekSec)
    }
  })()
  return ff.stdout
}

// Fallback de reproducción: extrae con yt-dlp LOCAL (Santiago) y lo pipea al ffmpeg
// `ff` que ya decodifica a PCM (es agnóstico al formato de entrada). Resuelve los
// videos geo-restringidos a Chile que el worker alemán no puede bajar. Si también
// falla acá, se marca S.playFailReason para avisar. (El seek no se reaplica en el
// fallback: arranca desde 0; es un caso de borde poco frecuente.)
function startLocalFallback(ff, item, song, seekSec, S = activeSession()) {
  try {
    // Tee a la caché LOCAL en disco (Santiago) SOLO si hay canción y sin seek (audio
    // completo) → la próxima vez hasLocal(song) es true y se reproduce desde el
    // archivo, sin re-extraer. Tras el umbral de reproducciones queda persistida
    // localmente (sobrevive a la evicción LRU): clave para los geo-restringidos,
    // que solo Santiago puede bajar.
    let cacheFile = null, partPath = null, cp = null
    if (song && seekSec === 0) {
      cp = musicCache.cachePath(song)
      partPath = `${cp}.${process.pid}.${Date.now()}.part`
      try { cacheFile = createWriteStream(partPath) } catch { cacheFile = null }
    }
    const yt = spawn(YTDLP, ytdlpArgs(['--no-playlist', '-f', 'bestaudio/best', '-o', '-', item.url]))
    S.activeProcs.push(yt)
    yt.stdout.pipe(ff.stdin)
    if (cacheFile) { yt.stdout.pipe(cacheFile); cacheFile.on('error', () => { cacheFile = null }) }
    yt.stdout.on('error', () => {})
    let ytErr = ''
    yt.stderr.on('data', d => { if (ytErr.length < 2000) ytErr += d })
    yt.on('error', err => {
      S.streamDownloading = false
      console.error('fallback yt-dlp:', err.message)
      S.playFailReason = 'no se pudo obtener el audio'
      if (cacheFile) cacheFile.end(() => { try { rmSync(partPath, { force: true }) } catch {} })
      try { ff.stdin.end() } catch {}
    })
    yt.on('close', code => {
      S.streamDownloading = false
      if (code && code !== 0) {
        console.error('fallback yt-dlp exit', code, ytErr.slice(0, 300))
        S.playFailReason = 'no disponible'
        if (cacheFile) cacheFile.end(() => { try { rmSync(partPath, { force: true }) } catch {} })
      } else if (cacheFile) {
        cacheFile.end(() => {
          try {
            renameSync(partPath, cp)
            musicCache.registerPlay(song, cp).catch(e => console.warn('cacheo fallback:', e.message))
            console.log(`Cacheado local (fallback geo): canción ${song.id}`)
          } catch (e) { console.warn('cacheo fallback falló:', e.message); try { rmSync(partPath, { force: true }) } catch {} }
        })
      } else if (song && seekSec === 0) {
        try { musicCache.recordPlay(song) } catch {}
      }
      backgroundWork(S)
    })
  } catch (e) {
    S.streamDownloading = false
    S.playFailReason = 'no se pudo obtener el audio'
    try { ff.stdin.end() } catch {}
  }
}

function killStreamProcs(S = activeSession()) {
  if (S.remoteAbort) { try { S.remoteAbort.abort() } catch {} ; S.remoteAbort = null }
  for (const p of S.activeProcs) { try { p.kill() } catch {} }
  S.activeProcs = []
}

async function fetchMeta(item) {
  if (USE_WORKER) {
    try {
      const m = await workerMeta(item.url)
      if (m.title) item.title = m.title
      if (m.duration) item.duration = m.duration
      if (m.uploader) item.uploader = m.uploader
      updatePanel()
      return
    } catch { /* worker caído → fallback local */ }
  }
  return fetchMetaLocal(item)
}
// Deriva el artista: "Artista - Canción" → "Artista"; si el título es solo el
// nombre de la canción, usa el CANAL (uploader) limpiando sufijos típicos de
// YouTube ("- Topic", "VEVO", "Official"...).
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
function fetchMetaLocal(item) {
  return new Promise(resolve => {
    const proc = spawn(YTDLP, ytdlpArgs([
      '--skip-download', '--print', '%(title)s\n%(duration)s\n%(uploader)s', item.url
    ]))
    trackBg(proc)
    let out = ''
    proc.stdout.on('data', d => out += d)
    proc.on('error', () => { untrackBg(proc); resolve() })
    proc.on('close', () => {
      untrackBg(proc)
      const [title, dur, uploader] = out.trim().split('\n')
      if (title) item.title = title
      const d = parseFloat(dur)
      if (!isNaN(d)) item.duration = d
      if (uploader && uploader !== 'NA') item.uploader = uploader
      updatePanel()
      resolve()
    })
  })
}

function elapsed(S = activeSession()) {
  if (!S.currentResource) return 0
  return S.seekOffset + S.currentResource.playbackDuration / 1000
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
// Resuelve fuente real + título + duración en UNA sola llamada (resuelve también
// términos de búsqueda ytsearch1:). Worker si está, si no yt-dlp local.
async function ytdlpResolveMeta(url) {
  if (USE_WORKER) {
    try {
      const m = await workerMeta(url)
      if (m.url) return { sourceUrl: m.url, title: m.title || null, duration: m.duration }
    } catch { /* fallback local */ }
  }
  return ytdlpResolveMetaLocal(url)
}

// Lista las entradas (url + título) de una playlist sin resolver cada video.
// Devuelve [] si el link no es una playlist o no tiene entradas.
async function ytdlpFlatPlaylist(url) {
  if (USE_WORKER) {
    try { return await workerPlaylist(url) }
    catch (e) { if (e.playlistError) throw e /* error real → no enmascarar con fallback */ }
  }
  return ytdlpFlatPlaylistLocal(url)
}

// (ytdlpPrint, ytdlpResolveMetaLocal, ytdlpFlatPlaylistLocal, classifyPlaylistError
//  y killBgYtdlp viven en lib/audio/ytdlp.mjs.)

// URL canónica para indexar la caché: las URLs directas se usan tal cual; las
// búsquedas (ytsearch1: de nombre/Spotify/Apple) se resuelven al video real.
// Si ya es una clave conocida (p.ej. una canción subida), se usa directo.
async function resolveSource(item) {
  if (/^https?:\/\//i.test(item.url)) return item.url
  if (musicCache.findByUrl(item.url)) return item.url
  if (USE_WORKER) { try { return (await workerMeta(item.url)).url || item.url } catch {} }
  return (await ytdlpPrint(item.url, 'webpage_url')) || item.url
}

// Pre-cacheo vía worker remoto: baja el Opus por HTTP y lo guarda en destPath.
async function downloadViaWorker(url, destPath) {
  const res = await fetch(workerAudioUrl(url, 0), { headers: workerHeaders() })
  if (!res.ok || !res.body) throw new Error(`worker HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath))
}

// Descarga el audio a un archivo exacto (destPath). yt-dlp escribe con su propia
// extensión, así que bajamos a destPath.<ext> y renombramos a destPath.
function downloadToFile(url, destPath) {
  // Con worker remoto: el Opus llega por HTTP y se guarda tal cual (startFileStream
  // lo decodifica). Así el pre-cacheo de fondo tampoco corre yt-dlp en Santiago.
  if (USE_WORKER) return downloadViaWorker(url, destPath)
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP, ytdlpArgs(['-f', 'bestaudio/best', '-o', `${destPath}.%(ext)s`, url]))
    trackBg(proc)
    let err = ''
    proc.stderr.on('data', d => err += d)
    proc.on('error', e => { untrackBg(proc); reject(e) })
    proc.on('close', code => {
      untrackBg(proc)
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
// Baja una imagen (con timeout) desde su URL y la guarda como carátula del
// sonido. Devuelve true si la guardó. No requiere descargar el audio.
async function storeArtFromUrl(song, thumb) {
  if (!song || song.art_key) return false
  if (!thumb || !/^https?:\/\//i.test(thumb)) return false
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(thumb, { signal: ctrl.signal })
    if (!res.ok) return false
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) return false
    let ext = (thumb.split(/[?#]/)[0].split('.').pop() || '').toLowerCase()
    if (!/^(jpg|jpeg|png|webp|gif)$/.test(ext)) ext = 'jpg'
    await art.store(song.id, buf, ext)
    song.art_key = `art/${song.id}.${ext}`
    return true
  } catch { return false } finally { clearTimeout(t) }
}

async function ensureSongArt(song, sourceUrl) {
  if (!song || song.art_key) return
  // Carátula: iTunes → Deezer → miniatura "de siempre" (YouTube). La miniatura la
  // da el worker (workerMeta) en modo worker, o yt-dlp local si no.
  const localFile = (() => { try { return musicCache.hasLocal(song) ? musicCache.cachePath(song) : null } catch { return null } })()
  const thumbFallback = async () => {
    let thumb = null
    if (USE_WORKER) { try { thumb = (await workerMeta(sourceUrl)).thumbnail } catch {} }
    else { try { thumb = await ytdlpPrint(sourceUrl, 'thumbnail') } catch {} }
    return thumb ? artsearch.fetchImg(thumb) : null
  }
  try {
    const r = await artsearch.resolveArt(song, { localFile, thumbFallback })
    if (r) { await art.store(song.id, r.buf, r.ext); song.art_key = `art/${song.id}.${r.ext}` }
  } catch { /* sin carátula: no pasa nada */ }
}

// Baja las carátulas de un set de canciones (con poca concurrencia), usando la
// miniatura que ya trae la playlist. Solo la imagen, sin tocar el audio.
async function fetchArtForSongs(items) {
  const pending = items.filter(it => it.thumb && it.song && !it.song.art_key)
  let i = 0
  const worker = async () => {
    while (i < pending.length) { const it = pending[i++]; try { await storeArtFromUrl(it.song, it.thumb) } catch {} }
  }
  await Promise.all(Array.from({ length: Math.min(6, pending.length) }, worker))
}

// Descarga a la caché SIN reproducir ni contar reproducción ("forzar caché").
async function forceCacheAudio(item) {
  const sourceUrl = await resolveSource(item)
  const song = musicCache.findByUrl(sourceUrl)
    || musicCache.upsertSong({ sourceUrl, title: item.title })
  if (USE_WORKER) {
    // Se cachea en el disco del WORKER (no en Santiago). La carátula la baja el
    // worker bajo demanda; aquí solo aseguramos el audio.
    await workerEnsure(sourceUrl)
    if (song.permanent) workerKeep(sourceUrl, true)
    return song
  }
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
    // Artista: del título ("Artista - Canción") o, si no, del canal. No pisa uno ya bueno.
    const artist = song.artist ? null : deriveArtist(item.title, item.uploader)
    song = musicCache.setMeta(song.id, { title: goodTitle, durationMs, artist })
    updatePanel()
    return true
  }
  // 2) Carátula (iTunes-first; una sola vez por item para no entrar en bucle).
  if (!item.artTried && !song.art_key) { item.artTried = true; await ensureSongArt(song, sourceUrl); updatePanel(); return true }
  return false
}

// Pre-cachea un item a DISCO si no está ya. Devuelve true si descargó algo.
// Rastrea la canción/promesa en curso para que la reproducción pueda esperarla
// (si va a sonar justo esa) en vez de re-extraerla.
async function cacheToDisk(item, S = activeSession()) {
  if (!item || !item.url) return false
  let song = songForItem(item)
  const sourceUrl = song ? song.source_url : await resolveSource(item)
  if (!song) song = musicCache.findByUrl(sourceUrl) || musicCache.upsertSong({ sourceUrl, title: item.title })
  item.songId = song.id
  // Modo worker: pre-cachea en el disco del WORKER → su próxima /audio es HIT
  // (instantáneo, gapless). El play puede esperar S.bgPromise si va a sonar esta.
  if (USE_WORKER) {
    S.bgSongId = song.id
    S.bgPromise = workerEnsure(sourceUrl)
    try { await S.bgPromise; console.log(`Pre-cacheada en el worker (gapless): canción ${song.id}`); return true }
    catch { return false }
    finally { if (S.bgSongId === song.id) { S.bgSongId = null; S.bgPromise = null } }
  }
  if (musicCache.hasLocal(song) || song.persisted) return false // ya lista
  // S.bgPromise = SOLO la descarga del audio (lo que la reproducción necesita
  // esperar para arrancar gapless); la carátula va después, sin bloquear el play.
  S.bgSongId = song.id
  S.bgPromise = musicCache.ensureCached(song, dest => downloadToFile(sourceUrl, dest))
  try {
    await S.bgPromise
    console.log(`Pre-cacheada a disco (gapless): canción ${song.id}`)
  } finally {
    if (S.bgSongId === song.id) { S.bgSongId = null; S.bgPromise = null }
  }
  await ensureSongArt(song, sourceUrl) // carátula serial (dentro del candado), ya no la espera el play
  return true
}

// Trabajo de fondo. UNA tarea por llamada, en este orden de prioridad:
//   PRIORIDAD 0: la descarga del stream que va a sonar — no se toca; el enriquecido
//      NO corre durante la extracción inicial (S.currentPlaying=false) para no frenar
//      el arranque, y al arrancar una reproducción se mata el yt-dlp de fondo.
//   1) METADATA + CARÁTULA de la actual y de la cola — corre mientras la canción
//      SUENA, aunque el stream siga descargando (se acepta un 2º yt-dlp: el audio
//      ya está buffereado y no se interrumpe). Tiene MÁS prioridad que el pre-cacheo.
//   2) PRE-CACHEO a disco (la siguiente primero) — solo cuando NO hay un stream
//      descargando (para no correr dos descargas sostenidas a la vez).
// Se encadena cada 1.5s mientras haya trabajo.
async function backgroundWork(S = activeSession()) {
  if (S.prefetching) return
  S.prefetching = true
  let didWork = false
  try {
    // 1) Enriquecer (metadata + carátula) mientras la canción ya suena.
    if (S.currentPlaying) {
      if (await enrich(S.current)) didWork = true
      else for (const item of S.queue) { if (await enrich(item)) { didWork = true; break } }
    }
    // 2) Pre-cachear a disco la cola (la siguiente primero), solo sin stream activo.
    if (!didWork && !S.streamDownloading) for (const item of S.queue) {
      if (S.streamDownloading) break
      if (await cacheToDisk(item)) { didWork = true; break }
    }
    // 3) Backfill (lo más bajo): completa metadata y/o carátula de UNA canción de
    //    la Biblioteca por ciclo. Cubre títulos pobres (Biblioteca/Caché viejas) y
    //    canciones SIN carátula (p. ej. las importadas de una playlist, que nacen
    //    con título plano y sin arte). Una tarea por ciclo y sin reintentos.
    if (!didWork) {
      const pending = musicCache.listAll().find(s =>
        (isPoorTitle(s.title, s.source_url) && !metaBackfillTried.has(s.id)) ||
        (!s.art_key && !artBackfillTried.has(s.id)))
      if (pending) {
        // Marca solo la tarea que enrich() hará en esta llamada (metadata primero;
        // si el título ya es bueno, será la carátula). Así un caso con ambos
        // pendientes se completa en dos ciclos sin reintentar para siempre.
        const needsMeta = isPoorTitle(pending.title, pending.source_url) && !metaBackfillTried.has(pending.id)
        if (needsMeta) metaBackfillTried.add(pending.id)
        else artBackfillTried.add(pending.id)
        // Sembramos la duración conocida para que enrich() no gaste un yt-dlp de
        // metadata cuando lo único que falta es la carátula.
        const item = { url: pending.source_url, songId: pending.id, duration: pending.duration_ms ? pending.duration_ms / 1000 : null }
        if (await enrich(item)) didWork = true
      }
    }
  } catch { /* reintenta en el próximo tick */ } finally {
    S.prefetching = false
  }
  if (didWork) setTimeout(() => backgroundWork(S), 1500)
}
setInterval(() => { for (const s of sessions.values()) backgroundWork(s) }, BG_WORK_INTERVAL)
setInterval(() => { for (const s of sessions.values()) backgroundWork(s) }, BG_WORK_INTERVAL)

// Reproduce desde un archivo local ya descargado (el seek es seek de archivo).
function startFileStream(filePath, seekSec, S = activeSession()) {
  const args = ['-loglevel', 'error']
  if (seekSec > 0) args.push('-ss', String(seekSec))
  args.push('-i', filePath, '-vn', '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1')
  const ff = spawn(FFMPEG, args)
  ff.on('error', err => console.error('ffmpeg:', err.message))
  ff.stderr.on('data', d => process.stderr.write(d))
  S.activeProcs = [ff]
  return ff.stdout
}

// ── Conexión de voz ───────────────────────────────────────────────────────
async function ensureConnection(voiceChannelId, guildId, S = getSession(guildId)) {
  if (S.connection && S.currentChannelId === voiceChannelId) return
  if (S.connection) {
    S.connection.destroy()
    S.connection = null
    await new Promise(r => setTimeout(r, 500))
  }
  const vc = await client.channels.fetch(voiceChannelId)
  S.connection = joinVoiceChannel({
    channelId: voiceChannelId,
    guildId,
    adapterCreator: vc.guild.voiceAdapterCreator,
  })
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout conectando al canal de voz')), 20000)
    const onReady = () => { clearTimeout(timeout); S.connection.off('error', onErr); resolve() }
    const onErr = (err) => { clearTimeout(timeout); S.connection.off(VoiceConnectionStatus.Ready, onReady); reject(err) }
    S.connection.once(VoiceConnectionStatus.Ready, onReady)
    S.connection.once('error', onErr)
  })
  S.connection.subscribe(S.musicPlayer)
  S.currentChannelId = voiceChannelId
  S.currentChannelName = vc.name
}

function destroyConnection(S = activeSession()) {
  if (S.connection) {
    try { S.connection.destroy() } catch {}
    S.connection = null
    S.currentChannelId = null
    S.currentChannelName = null
  }
}

// ── Motor de reproducción ─────────────────────────────────────────────────
async function ensurePlaying(S = activeSession()) {
  if (S.playing) return
  S.playing = true
  try {
    while (true) {
      if (!S.current) {
        if (S.queue.length === 0) break
        S.current = S.queue.shift()
      }
      try {
        await ensureConnection(S.current.voiceChannelId, S.current.guildId)
      } catch (err) {
        console.error('Error de conexión:', err.message)
        await notifyError(S.current, err)
        S.current = null
        continue
      }

      S.seekOffset = S.seekTarget
      S.seekTarget = 0
      S.currentPlaying = false // aún en extracción/carga: no enriquecer hasta que suene
      S.playFailReason = null  // se setea si el stream del worker falla (video no disponible)
      console.log(`Reproduciendo: ${S.current.title || S.current.url}${S.seekOffset ? ` (desde ${S.seekOffset}s)` : ''}`)
      // PRIORIDAD: arrancar la reproducción cuanto antes, con UN solo yt-dlp.
      // No se resuelve ni se baja carátula/metadata aquí (eso lo hace el proceso
      // de inactividad). Solo se usa el archivo si ya está COMPLETO en caché.
      S.opusDirect = false
      S.currentMixer = null
      S.currentResource = null
      // Passthrough de Opus: solo con worker, fuente URL y SIN actividad reciente
      // de soundboard (si se usan sonidos seguimos en PCM para mezclarlos sin
      // cortes). Si el worker no puede extraer (geo-restricción), se cae al PCM.
      const wantOpusDirect = USE_WORKER && /^https?:\/\//i.test(S.current.url) &&
        (Date.now() - S.lastSoundAt > soundPcmWindowMs)
      if (wantOpusDirect) {
        try {
          const raw = S.current.url
          const s = musicCache.findByUrl(raw) || musicCache.upsertSong({ sourceUrl: raw, title: S.current.title })
          S.current.songId = s.id
          S.currentResource = await startRemoteOpusResource({ ...current, url: raw }, S.seekOffset)
          S.opusDirect = true
          console.log('  ↳ passthrough Opus (sin decodificar)')
        } catch (e) {
          console.warn('Opus-directo no disponible, uso PCM:', e.message)
          S.opusDirect = false
          S.currentResource = null
        }
      }
      if (!S.opusDirect) {
        let stream
        try {
          const raw = S.current.url
          const isUrl = /^https?:\/\//i.test(raw)
          let song = isUrl ? musicCache.findByUrl(raw) : null
          // Si el fondo está pre-cacheando JUSTO esta canción, espera a que termine
          // (segundos de descarga) en vez de matarla y re-extraer (~10s). Gapless.
          if (song && S.bgSongId === song.id && S.bgPromise) {
            try { await S.bgPromise } catch {}
            song = musicCache.findByUrl(raw) // refresca el estado tras el pre-cacheo
          }
          if (song && (musicCache.hasLocal(song) || song.persisted)) {
            // Cacheada completa → archivo (instantáneo, con seek). Sin yt-dlp.
            const filePath = await musicCache.getLocalAudio(song, dest => downloadToFile(raw, dest))
            stream = startFileStream(filePath, S.seekOffset)
          } else if (isUrl) {
            // URL no cacheada: stream + tee a caché en la MISMA descarga (1 yt-dlp).
            const s = song || musicCache.upsertSong({ sourceUrl: raw, title: S.current.title })
            S.current.songId = s.id
            stream = USE_WORKER
              ? startRemoteStream({ ...current, url: raw }, S.seekOffset, s)
              : startStreamAndCache({ ...current, url: raw }, S.seekOffset, s)
          } else {
            // Término de búsqueda: stream directo (yt-dlp resuelve y reproduce en una
            // sola pasada). El cacheo/resolución lo hará el proceso de inactividad.
            stream = USE_WORKER
              ? startRemoteStream(S.current, S.seekOffset, null)
              : startStream(S.current, S.seekOffset)
          }
        } catch (err) {
          console.warn('Reproducción: fallback a streaming directo:', err.message)
          stream = USE_WORKER ? startRemoteStream(S.current, S.seekOffset, null) : startStream(S.current, S.seekOffset)
        }
        S.currentMixer = new MixerStream(stream, () => S.currentResource ? S.currentResource.playbackDuration : 0, {
          getMusicVolume: () => S.musicVolume,
          getMusicDuck: () => musicDuck,
          getSoundBaseVolume: () => soundBaseVolume,
        })
        S.currentResource = createAudioResource(S.currentMixer, { inputType: StreamType.Raw })
      }
      S.musicPlayer.play(S.currentResource)
      updatePanel()
      // Cuando el audio EMPIEZA a sonar (pasó la extracción inicial), se habilita el
      // enriquecido en paralelo (metadata + carátula) aunque el stream siga bajando.
      // Además se sueltan los sonidos que esperaban el switch a PCM (si los hubo).
      S.musicPlayer.once(AudioPlayerStatus.Playing, () => { S.currentPlaying = true; flushPendingSounds(S); backgroundWork(S) })

      const err = await waitIdle(S.musicPlayer)
      const reachedPlaying = S.currentPlaying // ¿llegó a sonar antes de quedar idle?
      S.currentPlaying = false // terminó: no enriquecer esta canción ya
      killStreamProcs()
      S.currentResource = null
      S.currentMixer = null
      S.opusDirect = false
      if (err) {
        console.error('Error reproduciendo:', err.message)
        await notifyError(S.current, err)
      } else if (S.playFailReason && !reachedPlaying) {
        // El stream del worker falló y la canción nunca llegó a sonar → avisar y omitir.
        await notifyUnavailable(S.current, S.playFailReason)
      }
      S.playFailReason = null

      const t = S.transition
      S.transition = 'next'
      if (t === 'next') {
        S.history.push(S.current)
        if (S.history.length > MAX_HISTORY) S.history.shift()
        S.current = null
      } else if (t === 'previous') {
        S.queue.unshift(S.current)
        S.current = S.history.pop() ?? S.queue.shift()
      } else if (t === 'seek') {
        // S.current se mantiene, S.seekTarget ya viene seteado
      } else if (t === 'stop') {
        // Stop: la canción se trata como terminada (pasa a reproducidas), pero
        // NO se avanza a la siguiente. El bot queda detenido sin desconectarse.
        S.history.push(S.current)
        if (S.history.length > MAX_HISTORY) S.history.shift()
        S.current = null
        break
      }
    }
  } finally {
    S.playing = false
    S.currentResource = null
    S.currentMixer = null
    S.opusDirect = false
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

// Aviso cuando una canción no se pudo reproducir (video no disponible, privado,
// eliminado…). Se omite y se sigue con la cola.
async function notifyUnavailable(item, reason) {
  if (!item?.textChannelId) return
  try {
    const ch = await client.channels.fetch(item.textChannelId)
    await ch.send(`⚠️ No se pudo reproducir \`${item.title || item.url}\` (${reason}). La salté y sigo con la cola.`)
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

// Limpia una URL de YouTube de una CANCIÓN suelta: deja solo el video, quitando
// list=RD… (radio/mix), start_radio, index, pp, t, etc. — basura que a menudo hace
// que el "video" sea una radio no reproducible. Soporta watch/youtu.be/shorts/embed/
// live. Para hosts que no son YouTube (SoundCloud, Bandcamp…) devuelve la URL igual.
// OJO: NO se usa para playlists (el import necesita el list=…).
function cleanYouTubeUrl(url) {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^(www|m|music)\./, '')
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0]
      return id ? `https://www.youtube.com/watch?v=${id}` : url
    }
    if (host === 'youtube.com') {
      const v = u.searchParams.get('v')
      if (v) return `https://www.youtube.com/watch?v=${v}`
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/)
      if (m) return `https://www.youtube.com/watch?v=${m[1]}`
    }
  } catch { /* no es URL válida: se devuelve tal cual */ }
  return url
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
  // Link directo (YouTube u otra plataforma): limpiar la basura de YouTube si aplica.
  return { url: cleanYouTubeUrl(url) }
}

// Resuelve cualquier entrada (link o búsqueda, igual que la cola) a una canción
// de la Biblioteca con título/duración/carátula, para agregarla a una playlist.
async function resolveToSong(input) {
  const resolved = await resolveInput(input)   // { url, title }
  // URL directa ya conocida → reutilizar la canción sin gastar otro yt-dlp.
  if (/^https?:\/\//i.test(resolved.url)) {
    const existing = musicCache.findByUrl(resolved.url)
    if (existing) return existing
  }
  const meta = await ytdlpResolveMeta(resolved.url)
  const sourceUrl = meta?.sourceUrl || resolved.url
  const song = musicCache.findByUrl(sourceUrl)
    || musicCache.upsertSong({ sourceUrl, title: meta?.title || resolved.title })
  if (meta?.title) {
    const durationMs = !isNaN(meta.duration) ? meta.duration * 1000 : null
    musicCache.setMeta(song.id, { title: meta.title, durationMs })
  }
  ensureSongArt(song, sourceUrl).catch(() => {})   // carátula en segundo plano
  return musicCache.getById(song.id)
}

// ── Comandos del motor ────────────────────────────────────────────────────
// Forma { id, name, avatar } de quién pidió la canción, desde un GuildMember de
// Discord (comandos !p y slash). Mismo shape que el user de los sonidos.
function requesterFromMember(member) {
  if (!member) return null
  return {
    id: member.id,
    name: member.displayName || member.user?.username || 'Alguien',
    avatar: member.displayAvatarURL ? member.displayAvatarURL() : null,
  }
}

function addToQueue(url, voiceChannelId, guildId, textChannelId, title, addedBy = null, S = getSession(guildId)) {
  if (S.queue.length >= MAX_QUEUE) throw new Error(`La cola está llena (máximo ${MAX_QUEUE})`)
  const item = { url, title: title || url, duration: null, voiceChannelId, guildId, textChannelId, addedBy }
  // La metadata (título/duración) NO se pide aquí para no lanzar otro yt-dlp que
  // compita con el arranque del stream; la rellena backgroundWork cuando ya suena.
  S.queue.push(item)
  const startsNow = !S.current && S.queue.length === 1
  ensurePlaying()
  updatePanel()
  // No se dispara backgroundWork aquí: si esta canción arranca ahora, su stream
  // marcará S.streamDownloading y backgroundWork se gatea solo. El intervalo, el
  // cierre del yt-dlp y el evento Playing ya cubren el enriquecido/pre-cacheo.
  return { startsNow, position: S.queue.length }
}

function cmdSkip(S = activeSession()) {
  if (!S.current) return false
  S.transition = 'next'
  S.musicPlayer.stop()
  return true
}

function cmdPrevious(S = activeSession()) {
  if (S.current) {
    S.transition = 'previous'
    S.musicPlayer.stop()
    return true
  }
  if (S.history.length > 0) {
    S.current = S.history.pop()
    ensurePlaying()
    return true
  }
  return false
}

function cmdSeek(toSeconds, S = activeSession()) {
  if (!S.current) return false
  S.seekTarget = Math.max(0, toSeconds)
  S.transition = 'seek'
  S.musicPlayer.stop()
  return true
}

function cmdPause(S = activeSession()) {
  if (S.musicPlayer.state.status !== AudioPlayerStatus.Playing) return false
  S.musicPlayer.pause()
  updatePanel()
  return true
}

function cmdResume(S = activeSession()) {
  if (S.musicPlayer.state.status !== AudioPlayerStatus.Paused) return false
  S.musicPlayer.unpause()
  updatePanel()
  return true
}

function cmdStop(S = activeSession()) {
  // Detiene la canción actual como si hubiera terminado (pasa a reproducidas);
  // NO inicia la siguiente, NO borra la cola y NO se desconecta. El bot queda
  // detenido en el canal hasta que alguien reproduzca o agregue una canción.
  if (!S.current) return false
  S.transition = 'stop'
  S.pendingSounds = [] // si había sonidos esperando un switch, se descartan
  S.musicPlayer.stop()
  return true
}

// ── Panel de control en el chat de Discord ────────────────────────────────
// S.panelMsg es campo de S (GuildSession).

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

function progressBar(S = activeSession()) {
  if (!S.current || !S.current.duration) return null
  const pos = Math.min(elapsed(), S.current.duration)
  const n = 14
  const idx = Math.min(n - 1, Math.floor(pos / S.current.duration * n))
  return '▬'.repeat(idx) + '🔘' + '▬'.repeat(n - 1 - idx) + `  ${fmtDur(pos)} / ${fmtDur(S.current.duration)}`
}

function panelPayload(S = activeSession()) {
  const paused = S.musicPlayer.state.status === AudioPlayerStatus.Paused
  const lines = []
  if (S.current) {
    lines.push(`${paused ? '⏸' : '▶'} **${S.current.title}**`)
    const bar = progressBar()
    if (bar) lines.push(bar)
  } else {
    lines.push('Nada reproduciéndose')
  }
  if (S.queue.length > 0) {
    lines.push('', '**Cola:**')
    S.queue.slice(0, 5).forEach((it, i) => lines.push(`${i + 1}. ${it.title}${it.duration ? ` (${fmtDur(it.duration)})` : ''}`))
    if (S.queue.length > 5) lines.push(`… y ${S.queue.length - 5} más`)
  }
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(PANEL_TITLE)
    .setDescription(lines.join('\n'))
  const volFooter = `Volumen música: ${Math.round(S.musicVolume * 100)}%`
  embed.setFooter({ text: (S.currentChannelName ? `🔊 ${S.currentChannelName} · ` : '') + volFooter })
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mp_prev').setEmoji('⏮').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mp_voldown').setEmoji('🔉').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mp_toggle').setEmoji(paused ? '▶' : '⏸').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('mp_volup').setEmoji('🔊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mp_skip').setEmoji('⏭').setStyle(ButtonStyle.Secondary),
  )
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mp_goto').setEmoji('🕐').setLabel('Ir a...').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mp_stop').setEmoji('⏹').setLabel('Detener').setStyle(ButtonStyle.Danger),
  )
  const rows = [row1, row2]
  // Menú "Saltar a...": posiciones espaciadas según la duración (máx 25 opciones)
  if (S.current && S.current.duration) {
    const step = seekStep(S.current.duration)
    const opts = []
    for (let t = 0; t < S.current.duration && opts.length < 25; t += step) {
      opts.push({ label: fmtDur(t), value: String(t) })
    }
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('mp_seekto').setPlaceholder('⏩ Saltar a...').addOptions(opts)
    ))
  }
  return { embeds: [embed], components: rows }
}

const PANEL_TITLE = '🎵 Panel de música'

async function sendPanel(textChannelId, S = activeSession()) {
  try {
    const ch = await client.channels.fetch(textChannelId)
    if (S.panelMsg) { try { await S.panelMsg.delete() } catch {} ; S.panelMsg = null }
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
    S.panelMsg = await ch.send({ ...panelPayload(), flags: 4096 }) // 4096 = @silent, sin notificación
  } catch (err) { console.error('panel:', err.message) }
}

function updatePanel(S = activeSession()) {
  if (!S.panelMsg || S.panelUpdateQueued) return
  // Agrupar actualizaciones seguidas en una sola edición (evita rate limits)
  S.panelUpdateQueued = true
  setTimeout(async () => {
    S.panelUpdateQueued = false
    if (!S.panelMsg) return
    try { await S.panelMsg.edit(panelPayload()) } catch {}
  }, 300)
}

// Refrescar la barra de progreso mientras suena algo (10s mantiene las
// ediciones muy por debajo del rate limit de Discord)
setInterval(() => {
  if (S.panelMsg && S.current && S.musicPlayer.state.status === AudioPlayerStatus.Playing) updatePanel()
}, 10000)

// Detector de actividad: si el bot está en un canal SIN personas durante
// idleDisconnectMs, se desconecta solo — salvo que ese servidor tenga "mantener
// conectado siempre" (keepAliveGuilds) o el tiempo esté en 0 (desactivado).
const IDLE_CHECK_INTERVAL = 30000
setInterval(() => {
  if (!idleDisconnectMs) return // 0 = desactivado
  for (const sess of sessions.values()) {
    const gid = sess.guildId || sess.connection?.joinConfig?.guildId
    if (!sess.connection || !sess.currentChannelId || keepAliveGuilds.has(gid)) { sess.emptySince = 0; continue }
    if (humansInChannel(gid, sess.currentChannelId) > 0) { sess.emptySince = 0; continue }
    if (!sess.emptySince) { sess.emptySince = Date.now(); continue } // primer tick vacío
    if (Date.now() - sess.emptySince >= idleDisconnectMs) {
      sess.emptySince = 0
      console.log(`Inactividad: desconectando del canal de voz (guild ${gid})`)
      // Mismo efecto que el botón Desconectar (detiene y vacía la cola), en el
      // contexto de ESA sesión para que los defaults activeSession() resuelvan bien.
      sessionCtx.run(sess, () => { try { cmdStop() } catch {} sess.queue.length = 0; destroyConnection(); updatePanel() })
    }
  }
}, IDLE_CHECK_INTERVAL)

client.on('interactionCreate', (interaction) =>
  sessionCtx.run(getSession(interaction.guildId), () => onInteraction(interaction)))
async function onInteraction(interaction) {
  const S = activeSession() // = sesión del guild fijada por run()
  if (interaction.isChatInputCommand() && interaction.commandName === 'p') {
    const query = interaction.options.getString('cancion', true)
    const member = await interaction.guild.members.fetch(interaction.user.id)
    if (!member.voice.channel) {
      await interaction.reply({ content: 'Necesitas estar en un canal de voz para usar `/p`.', flags: 64 }) // 64 = efímero
      return
    }
    if (!memberCanControl(member)) {
      await interaction.reply({ content: `El bot ya está en **${S.currentChannelName}**. Únete a ese canal para usar \`/p\`.`, flags: 64 })
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
      r = addToQueue(resolved.url, member.voice.channel.id, interaction.guildId, interaction.channelId, resolved.title, requesterFromMember(member))
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
    if (!memberCanControl(interaction.member)) {
      await interaction.reply({ content: 'Debes estar en el canal de voz del bot para controlar la música.', flags: 64 }).catch(() => {})
      return
    }
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

  // Los botones del panel de Discord controlan la reproducción: solo quien esté
  // en el canal de voz del bot (admins exentos).
  if (!memberCanControl(interaction.member)) {
    await interaction.reply({ content: 'Debes estar en el canal de voz del bot para usar estos controles.', flags: 64 }).catch(() => {})
    return
  }

  if (id === 'mp_goto') {
    if (!S.current) {
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

  if (id === 'mp_voldown' || id === 'mp_volup') {
    const left = musicVolumeCooldownLeft(S)
    if (left > 0) {
      await interaction.reply({ content: `⏳ Espera ${Math.ceil(left / 1000)}s para volver a cambiar el volumen.`, flags: 64 }).catch(() => {})
      return
    }
    cmdMusicVolume(S.musicVolume + (id === 'mp_volup' ? 0.1 : -0.1), S)
  }
  else if (id === 'mp_prev') cmdPrevious()
  else if (id === 'mp_toggle') { if (!cmdPause()) cmdResume() }
  else if (id === 'mp_skip') cmdSkip()
  else if (id === 'mp_stop') cmdStop()
  else return
  try { await interaction.deferUpdate() } catch {}
  updatePanel()
}

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

function soundTree(S = activeSession()) {
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
// el S.soundPlayer. play() reemplaza al anterior SIN emitir Idle, así que la
// limpieza se hace aquí y se invoca tanto desde el listener persistente de Idle
// como al reemplazar un sonido por otro.
// S.currentDirectId y S.directResource son campos de S (GuildSession).

function finishDirectSound(S = activeSession()) {
  if (S.currentDirectId === null) return
  const e = S.activeSounds.get(S.currentDirectId)
  S.activeSounds.delete(S.currentDirectId)
  S.currentDirectId = null
  S.directResource = null
  if (e) { try { e.proc.kill() } catch {} }
  S.soundActive = 0
  if (S.connection) S.connection.subscribe(S.musicPlayer)
}

function spawnSoundFfmpeg(filePath, gainDb = 0) {
  // El volumen GLOBAL (slider) se aplica al mezclar, en vivo. Aquí solo se aplica
  // la ganancia de NORMALIZACIÓN por sonido (loudness), que es fija por archivo.
  const af = gainDb ? ['-af', `volume=${gainDb}dB`] : []
  const ff = spawn(FFMPEG, [
    '-loglevel', 'error', '-i', filePath, ...af,
    '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1'
  ])
  ff.on('error', err => console.error('ffmpeg sonido:', err.message))
  ff.stderr.on('data', d => process.stderr.write(d))
  return ff
}

async function playSound(soundId, user = null, S = activeSession()) {
  S.lastSoundAt = Date.now() // marca actividad de soundboard → mantiene el modo PCM
  // Si la música va en passthrough Opus, no hay mixer donde superponer: se cambia
  // a PCM reiniciando la canción actual desde su posición y el sonido se suelta
  // cuando el mixer esté listo (un único re-sync; solo ocurre tras 5 min sin
  // sonidos, por eso el soundboard en uso nunca se corta).
  if (S.opusDirect && S.current) {
    const id = ++S.soundIdSeq
    S.pendingSounds.push({ id, soundId: Number(soundId), user })
    S.seekTarget = elapsed()
    S.transition = 'seek'
    S.opusDirect = false
    S.musicPlayer.stop() // rompe waitIdle → ensurePlaying reconstruye en PCM
    return id
  }
  return playSoundCore(soundId, user)
}

// Suelta los sonidos que esperaban el switch de Opus-directo a PCM. Se llama
// cuando la música ya suena en PCM (el mixer existe).
function flushPendingSounds(S = activeSession()) {
  if (!S.pendingSounds.length) return
  const list = S.pendingSounds; S.pendingSounds = []
  for (const p of list) {
    Promise.resolve(playSoundCore(p.soundId, p.user, p.id))
      .catch(e => console.warn('sonido pendiente:', e.message))
  }
}

async function playSoundCore(soundId, user = null, presetId = null, S = activeSession()) {
  const sound = soundLib.getById(Number(soundId))
  if (!sound) throw new Error('Sonido no encontrado')
  const filePath = soundLib.localPath(sound)
  if (!existsSync(filePath)) throw new Error('Archivo del sonido no disponible')
  const key = String(sound.id) // identificador estable que usa el panel
  const gain = effectiveGain(sound) // normalización de volumen por sonido
  const id = presetId ?? ++S.soundIdSeq
  playHistory.record({ kind: 'sound', refId: sound.id, userId: user ? user.id : null })
  // Datos para la notificación "quién reproduce qué" del panel (dura lo que suene).
  const meta = { label: sound.label, user, startedAt: Date.now(), durationMs: sound.duration_ms || null }

  // Con música sonando: mezclar el sonido encima, música atenuada
  if (S.currentMixer && S.musicPlayer.state.status === AudioPlayerStatus.Playing) {
    const ff = spawnSoundFfmpeg(filePath, gain)
    S.activeProcs.push(ff)
    const ov = S.currentMixer.addOverlay(ff.stdout)
    S.activeSounds.set(id, { file: key, proc: ff, ov, mixer: S.currentMixer, ...meta })
    return id
  }

  // Sin música: mezclar sobre un SoundMixer dedicado para que suenen VARIOS a la
  // vez (sin límite). Requiere que el bot YA esté en un canal; no se conecta solo.
  if (!S.connection) throw new Error('El bot no está en un canal de voz')

  if (!S.soundMixer) {
    S.soundMixer = new SoundMixer({
      getSoundBaseVolume: () => soundBaseVolume,
      // Al cerrarse (sin sonidos un rato) devuelve la conexión al player de música.
      onClose: (inst) => {
        if (S.soundMixer === inst) S.soundMixer = null
        if (S.connection) { try { S.connection.subscribe(S.musicPlayer) } catch {} }
      },
    })
    const res = createAudioResource(S.soundMixer, { inputType: StreamType.Raw })
    S.connection.subscribe(S.soundPlayer)
    S.soundPlayer.play(res)
  }
  const ff = spawnSoundFfmpeg(filePath, gain)
  const ov = S.soundMixer.addOverlay(ff.stdout)
  S.activeSounds.set(id, { file: key, proc: ff, ov, mixer: S.soundMixer, ...meta })
  return id
}

function cmdSoundBaseVolume(v) {
  if (typeof v !== 'number' || isNaN(v)) return false
  soundBaseVolume = Math.min(5, Math.max(0, v)) // hasta 5x para subirlo bastante
  saveSettings()
  return true
}

// Duración máxima (segundos) de un sonido al subirlo (1..300). La aplica web.mjs;
// el bot solo guarda el valor (lo lee web.mjs de settings.json).
function cmdMaxSoundSeconds(n) {
  if (typeof n !== 'number' || isNaN(n)) return false
  maxSoundSeconds = Math.round(Math.min(300, Math.max(1, n)))
  saveSettings()
  return true
}

// Objetivo de loudness (LUFS): cambia a cuánto se igualan los sonidos. Al cambiarlo
// hay que re-medir todos (la ganancia es por archivo); se dispara en segundo plano.
function cmdSoundTargetLufs(v) {
  if (typeof v !== 'number' || isNaN(v)) return false
  soundTargetLufs = setTargetI(v)
  saveSettings()
  // Re-mide TODOS los sonidos con el nuevo objetivo (no bloquea la respuesta).
  soundLib.normalizeAll({ force: true })
    .then(r => { if (r.total) console.log(`Volumen: ${r.analyzed}/${r.total} sonidos re-medidos a ${soundTargetLufs} LUFS`) })
    .catch(err => console.error('re-normalizar sonidos:', err.message))
  return true
}

// Volumen de la música POR SERVIDOR (multiplicador 0..2; 1 = original). Aplica en
// vivo (el mixer de cada sesión lee S.musicVolume). El enfriamiento es por servidor
// (S.lastMusicVolumeAt) con la ventana global musicVolumeCooldownMs (0 = sin límite).
function musicVolumeCooldownLeft(S = activeSession()) {
  return Math.max(0, musicVolumeCooldownMs - (Date.now() - S.lastMusicVolumeAt))
}
function cmdMusicVolume(v, S = activeSession()) {
  if (typeof v !== 'number' || isNaN(v)) return false
  if (musicVolumeCooldownLeft(S) > 0) return false // limitado: aún en enfriamiento
  S.lastMusicVolumeAt = Date.now()
  S.musicVolume = Math.round(Math.min(2, Math.max(0, v)) * 100) / 100
  return true
}

// Enfriamiento (segundos) entre cambios de volumen de música. 0 = sin límite.
function cmdMusicVolumeCooldown(sec) {
  if (typeof sec !== 'number' || isNaN(sec)) return false
  musicVolumeCooldownMs = Math.round(Math.min(30, Math.max(0, sec)) * 1000)
  saveSettings()
  return true
}

// Tope de extracciones yt-dlp simultáneas en el worker (1..16). Lo aplica en vivo.
function cmdWorkerConcurrency(n) {
  if (typeof n !== 'number' || isNaN(n)) return false
  workerMaxConcurrency = Math.round(Math.min(16, Math.max(1, n)))
  saveSettings()
  pushWorkerConfig()
  return true
}

// Tope de la caché de audio del worker en disco (5..75 GB). Lo aplica en vivo
// (el worker expulsa lo menos usado si el nuevo tope queda por debajo del uso).
function cmdWorkerCacheMax(gb) {
  if (typeof gb !== 'number' || isNaN(gb)) return false
  workerCacheMaxGb = Math.round(Math.min(75, Math.max(5, gb)))
  saveSettings()
  pushWorkerConfig()
  return true
}

// Bitrate del Opus de música que produce el worker (64..256 kbps). Solo afecta
// descargas nuevas; lo ya cacheado conserva su bitrate.
function cmdMusicBitrate(k) {
  if (typeof k !== 'number' || isNaN(k)) return false
  musicBitrateKbps = Math.round(Math.min(256, Math.max(64, k)))
  saveSettings()
  pushWorkerConfig()
  return true
}

// Ventana (segundos) sin soundboard tras la cual la música vuelve a Opus-directo
// (passthrough). 0 = sin ventana (vuelve a directo de inmediato). Máx 1 h. Aplica
// a la SIGUIENTE canción que arranque.
function cmdSoundPcmWindow(sec) {
  if (typeof sec !== 'number' || isNaN(sec)) return false
  soundPcmWindowMs = Math.round(Math.min(3600, Math.max(0, sec)) * 1000)
  saveSettings()
  return true
}

// Tiempo (minutos) que el bot espera en un canal SIN personas antes de
// desconectarse solo. 0 = desactivado (no se desconecta por inactividad). Máx 120.
function cmdIdleDisconnect(min) {
  if (typeof min !== 'number' || isNaN(min)) return false
  idleDisconnectMs = Math.round(Math.min(120, Math.max(0, min)) * 60 * 1000)
  saveSettings()
  return true
}

// "Mantener conectado siempre" para un servidor: ignora el auto-desconectar por
// inactividad. POR SERVIDOR y solo-admin. Persiste entre reinicios.
function cmdKeepAlive(guildId, on) {
  if (!guildId) return false
  if (on) keepAliveGuilds.add(String(guildId)); else keepAliveGuilds.delete(String(guildId))
  getSession(guildId).emptySince = 0 // resetea el contador de inactividad
  saveSettings()
  return true
}

// Tope de la cola de música (1..500). No afecta lo ya encolado.
function cmdMaxQueue(n) {
  if (typeof n !== 'number' || isNaN(n)) return false
  MAX_QUEUE = Math.round(Math.min(500, Math.max(1, n)))
  saveSettings()
  return true
}

// Retención del historial de reproducidas (1..500). Si se reduce, recorta ya.
function cmdMaxHistory(n, S = activeSession()) {
  if (typeof n !== 'number' || isNaN(n)) return false
  MAX_HISTORY = Math.round(Math.min(500, Math.max(1, n)))
  while (S.history.length > MAX_HISTORY) S.history.shift()
  saveSettings()
  return true
}

// Atenuación de la música al sonar un efecto. `v` = factor 0..1 (volumen de la
// música durante el efecto). Aplica en vivo (los mixers leen `musicDuck`).
function cmdMusicDuck(v) {
  if (typeof v !== 'number' || isNaN(v)) return false
  musicDuck = Math.min(1, Math.max(0, v))
  saveSettings()
  return true
}

// Sonidos que siguen reproduciéndose; limpia de paso las entradas terminadas
function playingSounds(S = activeSession()) {
  const out = []
  for (const [id, e] of S.activeSounds) {
    if (e.ov && e.mixer && (e.mixer === S.currentMixer || e.mixer === S.soundMixer) && e.mixer.overlays.has(e.ov)) {
      out.push({ id, file: e.file, label: e.label, user: e.user || null, startedAt: e.startedAt, durationMs: e.durationMs })
    } else {
      S.activeSounds.delete(id)
    }
  }
  return out
}

function cmdStopSound(id, S = activeSession()) {
  if (id === undefined) {
    let stopped = false
    for (const sid of [...activeSounds.keys()]) stopped = cmdStopSound(sid) || stopped
    return stopped
  }
  const e = S.activeSounds.get(id)
  if (!e) return false
  try { e.proc.kill() } catch {}
  if (e.ov) {
    e.ov.ended = true; e.ov.chunks = []; e.ov.length = 0
    if (e.mixer) e.mixer.overlays.delete(e.ov)
    S.activeSounds.delete(id)
  }
  if (e.direct) S.soundPlayer.stop() // el listener de Idle (finishDirectSound) limpia la entrada
  return true
}

// ── Comandos de texto en Discord ──────────────────────────────────────────
client.on('messageCreate', (message) =>
  sessionCtx.run(getSession(message.guildId), () => onMessage(message)))
async function onMessage(message) {
  const S = activeSession() // = sesión del guild fijada por run()
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
    if (!memberCanControl(member)) {
      await message.reply(`El bot ya está en **${S.currentChannelName}**. Únete a ese canal para usar \`!p\`.`)
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
      r = addToQueue(resolved.url, member.voice.channel.id, message.guildId, message.channelId, resolved.title, requesterFromMember(member))
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

  // Controles de reproducción por texto: solo quien esté en el canal de voz del
  // bot (admins exentos).
  if (['!skip', '!prev', '!pause', '!resume', '!stop'].includes(content) && !memberCanControl(message.member)) {
    await message.reply(`Debes estar en el canal de voz del bot${S.currentChannelName ? ` (**${S.currentChannelName}**)` : ''} para controlar la música.`)
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
    if (!S.current && S.queue.length === 0) {
      await message.reply('La cola está vacía.')
      return
    }
    const lines = []
    if (S.current) lines.push(`**Ahora:** ${S.current.title}`)
    S.queue.forEach((item, i) => lines.push(`${i + 1}. ${item.title}`))
    await message.reply(lines.join('\n'))
    return
  }
}

// ── Servidor HTTP del panel ───────────────────────────────────────────────
function getState(S = activeSession()) {
  return {
    current: S.current ? { url: S.current.url, title: S.current.title, duration: S.current.duration, songId: S.current.songId ?? null } : null,
    elapsed: elapsed(),
    paused: S.musicPlayer.state.status === AudioPlayerStatus.Paused,
    queue: S.queue.map(i => ({ url: i.url, title: i.title, duration: i.duration, songId: i.songId ?? null, addedBy: i.addedBy || null })),
    // Reproducidas recientes (en memoria), de más antigua a más reciente,
    // para mostrarlas en gris en la cola sin que desaparezcan.
    played: S.history.slice(-20).map(i => ({ url: i.url, title: i.title, duration: i.duration, songId: i.songId ?? null, addedBy: i.addedBy || null })),
    historyCount: S.history.length,
    connected: !!S.connection,
    voiceChannel: S.currentChannelName,
    playingSounds: playingSounds(),
    soundBaseVolume,
    maxSoundSeconds,
    musicDuck,
    musicVolume: S.musicVolume,
    musicVolumeCooldownMs,
    soundTargetLufs,
    workerEnabled: USE_WORKER,
    workerMaxConcurrency,
    workerCacheMaxGb,
    musicBitrateKbps,
    soundPcmWindowMs,
    idleDisconnectMs,
    keepAlive: keepAliveGuilds.has(activeGuildId(S)),
    maxQueue: MAX_QUEUE,
    maxHistory: MAX_HISTORY,
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
  const token = parseCookies(req)[SID_COOKIE]
  return token ? auth.getSession(token) : null
}

// ¿El usuario del panel es administrador? (controles de canal de voz solo-admin)
function isPanelAdmin(req) {
  const u = panelUser(req)
  return !!(u && rbac.isAdmin(u.id))
}

// Cuenta las PERSONAS (no bots) presentes en un canal de voz.
function humansInChannel(guildId, channelId) {
  const guild = client.guilds.cache.get(guildId)
  if (!guild || !channelId) return 0
  let n = 0
  for (const vs of guild.voiceStates.cache.values()) {
    if (vs.channelId === channelId && !vs.member?.user?.bot) n++
  }
  return n
}

// Guild "activo" de una sesión: el suyo, el de su conexión, o —si el bot está en
// un solo servidor— ese único guild (para el panel sin selector de servidor).
function activeGuildId(S = activeSession()) {
  return S.guildId || S.connection?.joinConfig?.guildId ||
    (client.guilds.cache.size === 1 ? client.guilds.cache.first().id : null)
}

// ¿El usuario (por su Discord id) está ahora mismo en el canal de voz del bot?
function isInBotVoiceChannel(userId, S = activeSession()) {
  if (!S.connection || !S.currentChannelId || !userId) return false
  const guild = client.guilds.cache.get(S.connection.joinConfig.guildId)
  if (!guild) return false
  const vs = guild.voiceStates.cache.get(String(userId))
  return !!(vs && vs.channelId === S.currentChannelId)
}

// ¿El usuario del panel puede controlar la música/sonidos? Solo si es admin
// (exento) o si está en el canal de voz del bot. El acceso por contraseña legada
// se trata como admin. Ojo: rbac usa el id interno (u.id) pero la membresía de
// voz se consulta por el id de Discord (u.discord_id).
function canControlMusic(req) {
  if (authorizedByPassword(req)) return true
  const u = panelUser(req)
  if (!u) return false
  if (rbac.isAdmin(u.id)) return true
  return isInBotVoiceChannel(u.discord_id)
}

// Variante para comandos/botones de Discord: admin siempre; si el bot ya está en
// un canal, el miembro debe estar en ESE canal; si no hay conexión, se permite
// (el primero en pedir trae el bot a su canal). member.id es el id de Discord; el
// rol admin se consulta mapeando a la fila interna del usuario.
function memberCanControl(member, S = activeSession()) {
  if (!member) return false
  const u = auth.getUserByDiscordId(member.id)
  if (u && rbac.isAdmin(u.id)) return true
  if (!S.connection || !S.currentChannelId) return true
  return member.voice?.channelId === S.currentChannelId
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
function currentVoiceTarget(S = activeSession()) {
  if (S.current) return { vcId: S.current.voiceChannelId, gId: S.current.guildId }
  if (S.connection) return { vcId: S.currentChannelId, gId: S.connection.joinConfig.guildId }
  return null
}

// Lista los canales de voz del SERVIDOR ACTIVO (el que se está viendo en el panel,
// resuelto por la sesión / X-Guild-Id) con los usuarios que hay dentro, para que el
// panel deje elegir a cuál entrar. No muestra canales de otros servidores.
function listVoiceChannels(S = activeSession()) {
  const out = []
  const gid = activeGuildId(S)
  const activeGuild = gid ? client.guilds.cache.get(gid) : null
  for (const guild of (activeGuild ? [activeGuild] : [])) {
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
        members, botHere: S.currentChannelId === ch.id,
      })
    }
    channels.sort((a, b) => a.position - b.position)
    out.push({ guildId: guild.id, guildName: guild.name, channels })
  }
  return out
}

// Acciones del panel que solo puede ejecutar quien esté en el canal de voz del
// bot (o un admin): reproducir/encolar, controles de reproducción y sonidos.
const MUSIC_CONTROL_PATHS = new Set([
  '/api/play', '/api/music/play',
  '/api/skip', '/api/previous', '/api/pause', '/api/resume', '/api/stop', '/api/seek',
  '/api/music-volume',
  '/api/queue/remove', '/api/queue/reorder', '/api/queue/move',
  '/api/sound', '/api/sound/stop',
])

// Guilds del bot a los que un usuario de Discord pertenece. Se comprueba por REST
// (guild.members.fetch) porque el OAuth solo pide scope `identify`. Cacheado 60s
// por usuario para no llamar a la API de Discord en cada /api/guilds.
const _memberCache = new Map() // discordId -> { at, ids: Set<guildId> }
async function userGuildIds(discordId) {
  if (!discordId) return new Set()
  const c = _memberCache.get(discordId)
  if (c && Date.now() - c.at < 60000) return c.ids
  const ids = new Set()
  await Promise.all([...client.guilds.cache.values()].map(async g => {
    try { await g.members.fetch({ user: discordId, force: false }); ids.add(g.id) } catch { /* no es miembro */ }
  }))
  _memberCache.set(discordId, { at: Date.now(), ids })
  return ids
}

// Sesión que controla esta petición del panel: el guild elegido (header
// X-Guild-Id o query ?g=) si el bot está en él; si no, la sesión activa.
function sessionForReq(req) {
  let gid = req.headers['x-guild-id']
  if (!gid) { try { gid = new URL(req.url, 'http://x').searchParams.get('g') } catch {} }
  if (gid && client.guilds.cache.has(gid)) return getSession(gid)
  return activeSession()
}

http.createServer((req, res) =>
  sessionCtx.run(sessionForReq(req), () => onHttp(req, res))).listen(PORT, () => console.log(`Panel de control en el puerto ${PORT}`))
async function onHttp(req, res) {
  const S = activeSession() // = sesión fijada por run() (guild elegido o activa)
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Guild-Id')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  const path = new URL(req.url, 'http://x').pathname
  // Activos de marca (logo + favicon): públicos, sin requerir sesión. En Pages
  // los sirve Cloudflare; esto cubre dev y el acceso directo al bot.
  if (req.method === 'GET' && (path === '/Asher_logo.jpg' || path === '/Asher_icon.jpg')) {
    const file = join(ROOT, basename(path))
    if (existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' })
      res.end(readFileSync(file))
    } else { res.writeHead(404); res.end() }
    return
  }
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
      if (path === '/api/state') {
        const st = getState()
        st.canControl = canControlMusic(req)   // ¿este usuario puede tocar la música/sonidos?
        return sendJson(st)
      }
      if (path === '/api/guilds') {
        // Servidores del bot a los que ESTE usuario tiene acceso (es miembro), con
        // su estado, para el selector/pantalla de elección. Los admin globales ven
        // todos. La membresía se verifica por REST con caché (userGuildIds).
        const pu = panelUser(req)
        const admin = pu ? rbac.isAdmin(pu.id) : false
        const allowed = admin ? null : await userGuildIds(pu && pu.discord_id)
        const out = []
        for (const g of client.guilds.cache.values()) {
          if (allowed && !allowed.has(g.id)) continue
          const s = sessions.get(g.id)
          out.push({
            id: g.id,
            name: g.name,
            icon: g.iconURL?.({ size: 64 }) ?? null,
            connected: !!(s && s.connection),
            playing: !!(s && s.current),
            current: s && s.current ? (s.current.title || s.current.url) : null,
            queueLength: s ? s.queue.length : 0,
          })
        }
        out.sort((a, b) => (b.connected - a.connected) || (b.playing - a.playing) || a.name.localeCompare(b.name))
        return sendJson({ guilds: out, current: activeSession().guildId || null })
      }
      if (path === '/api/sounds') {
        const pu = panelUser(req)
        const uid = pu ? pu.id : null
        const admin = rbac.isAdmin(uid)
        const gid = activeSession().guildId || null // servidor activo de esta petición
        const other = new URL(req.url, 'http://x').searchParams.get('other') === '1'
        return sendJson(soundLib.tree(
          soundLib.listForUser(uid, gid, other), folders.listFor(uid, admin, gid),
          folders.aliasesForUser(uid), folders.meta(), uid))
      }
      if (path === '/api/voice-channels') {
        if (!isPanelAdmin(req)) return sendJson({ error: 'Solo un administrador' }, 403)
        return sendJson(listVoiceChannels())
      }
    }
    if (req.method === 'POST') {
      const body = await readBody(req)
      if (MUSIC_CONTROL_PATHS.has(path) && !canControlMusic(req)) {
        return sendJson({ error: 'Debes estar en el canal de voz del bot para controlar la música o los sonidos' }, 403)
      }
      switch (path) {
        case '/api/play': {
          if (!body.url) return sendJson({ error: 'Falta la URL' }, 400)
          const resolved = await resolveInput(body.url)
          const t = currentVoiceTarget()
          if (!t) return sendJson({ error: 'El bot no está en un canal de voz' }, 400)
          const pu = panelUser(req)
          const addedBy = pu ? { id: pu.id, name: pu.display_name || pu.username, avatar: pu.avatar_url || null } : null
          const r = addToQueue(resolved.url, t.vcId, t.gId, null, resolved.title, addedBy)
          return sendJson({ ok: true, ...r })
        }
        case '/api/music/cache': {
          if (!body.url) return sendJson({ error: 'Falta la URL' }, 400)
          const resolved = await resolveInput(body.url)
          const song = await forceCacheAudio({ url: resolved.url, title: resolved.title })
          return sendJson({ ok: true, id: song.id, title: song.title })
        }
        // Resuelve un link/búsqueda a una canción de la Biblioteca (sin reproducir
        // ni cachear), para agregarla a una playlist. No requiere canal de voz.
        case '/api/resolve': {
          if (!body.url) return sendJson({ error: 'Falta la URL' }, 400)
          try {
            const song = await resolveToSong(body.url)
            return sendJson({ ok: true, songId: song.id, title: song.title })
          } catch (e) {
            return sendJson({ error: e.message || 'No se pudo resolver' }, 400)
          }
        }
        // Importa una playlist completa (YouTube, etc.): lista sus entradas y crea
        // una canción de la Biblioteca por cada una. Devuelve los songIds.
        case '/api/resolve-playlist': {
          if (!body.url) return sendJson({ error: 'Falta la URL' }, 400)
          try {
            const entries = (await ytdlpFlatPlaylist(body.url)).slice(0, 200) // tope de seguridad
            if (!entries.length) return sendJson({ error: 'No se encontraron canciones (¿es un link de playlist?)' }, 400)
            const items = entries.map(e => ({
              song: musicCache.findByUrl(e.url) || musicCache.upsertSong({ sourceUrl: e.url, title: e.title }),
              thumb: e.thumbnail,
            }))
            const songIds = items.map(it => it.song.id)
            const name = entries.find(e => e.playlistTitle)?.playlistTitle || null
            // Trae solo las carátulas (imagen, sin bajar audio) de la playlist, con
            // tope de tiempo: lo que no alcance se completa en 2º plano (backfill).
            await Promise.race([fetchArtForSongs(items), new Promise(r => setTimeout(r, 12000))])
            return sendJson({ ok: true, songIds, count: songIds.length, name })
          } catch (e) {
            return sendJson({ error: e.message || 'No se pudo resolver la playlist' }, 400)
          }
        }
        case '/api/music/play': {
          const song = musicCache.getById(body.id)
          if (!song) return sendJson({ error: 'Canción no encontrada' }, 404)
          const t = currentVoiceTarget()
          if (!t) return sendJson({ error: 'El bot no está en un canal de voz' }, 400)
          const pu = panelUser(req)
          const addedBy = pu ? { id: pu.id, name: pu.display_name || pu.username, avatar: pu.avatar_url || null } : null
          const r = addToQueue(song.source_url, t.vcId, t.gId, null, song.title || song.source_url, addedBy)
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
        case '/api/music-volume': {
          const left = musicVolumeCooldownLeft(S)
          if (left > 0) return sendJson({ error: `Espera ${Math.ceil(left / 1000)}s para volver a cambiar el volumen`, retryMs: left, musicVolume: S.musicVolume }, 429)
          const v = body.to !== undefined ? body.to : S.musicVolume + (body.delta || 0)
          return sendJson({ ok: cmdMusicVolume(v, S), musicVolume: S.musicVolume })
        }
        case '/api/queue/remove': {
          const i = body.index
          if (i === undefined || i < 0 || i >= S.queue.length) return sendJson({ error: 'Índice inválido' }, 400)
          S.queue.splice(i, 1)
          updatePanel()
          return sendJson({ ok: true })
        }
        case '/api/queue/reorder': {
          const { from, to } = body
          if (from === undefined || to === undefined ||
              from < 0 || from >= S.queue.length || to < 0 || to >= S.queue.length)
            return sendJson({ error: 'Movimiento inválido' }, 400)
          const [it] = S.queue.splice(from, 1)
          S.queue.splice(to, 0, it)
          updatePanel()
          return sendJson({ ok: true })
        }
        case '/api/queue/move': {
          const { index, dir } = body
          const j = index + dir
          if (index === undefined || j < 0 || j >= S.queue.length || index < 0 || index >= S.queue.length)
            return sendJson({ error: 'Movimiento inválido' }, 400)
          ;[S.queue[index], S.queue[j]] = [S.queue[j], S.queue[index]]
          updatePanel()
          return sendJson({ ok: true })
        }
        case '/api/sound': {
          // Un sonido privado solo lo reproduce quien lo ve (su dueño o un admin).
          const pu = panelUser(req)
          const snd = soundLib.getById(Number(body.name))
          if (snd && !rbac.canSeeSound(pu ? pu.id : null, snd)) return sendJson({ error: 'Sonido no disponible' }, 403)
          // Quién dispara el sonido (para historial + notificación en vivo).
          const user = pu ? { id: pu.id, name: pu.display_name || pu.username, avatar: pu.avatar_url || null } : null
          const id = await playSound(body.name, user)
          return sendJson({ ok: true, id })
        }
        case '/api/sound/stop': return sendJson({ ok: cmdStopSound(body.id) })
        case '/api/sound/base-volume': {
          if (!isPanelAdmin(req)) return sendJson({ error: 'Solo un administrador' }, 403)
          return sendJson({ ok: cmdSoundBaseVolume(body.volume), soundBaseVolume })
        }
        case '/api/sound/max-seconds': {
          if (!isPanelAdmin(req)) return sendJson({ error: 'Solo un administrador' }, 403)
          return sendJson({ ok: cmdMaxSoundSeconds(body.seconds), maxSoundSeconds })
        }
        case '/api/sound/music-duck': {
          if (!isPanelAdmin(req)) return sendJson({ error: 'Solo un administrador' }, 403)
          return sendJson({ ok: cmdMusicDuck(body.value), musicDuck })
        }
        case '/api/sound/target-lufs': {
          if (!isPanelAdmin(req)) return sendJson({ error: 'Solo un administrador' }, 403)
          return sendJson({ ok: cmdSoundTargetLufs(body.value), soundTargetLufs })
        }
        case '/api/music-volume-cooldown': {
          if (!isPanelAdmin(req)) return sendJson({ error: 'Solo un administrador' }, 403)
          return sendJson({ ok: cmdMusicVolumeCooldown(body.seconds), musicVolumeCooldownMs })
        }
        case '/api/worker-concurrency': {
          if (!isPanelAdmin(req)) return sendJson({ error: 'Solo un administrador' }, 403)
          return sendJson({ ok: cmdWorkerConcurrency(body.value), workerMaxConcurrency })
        }
        case '/api/worker-cache-max': {
          if (!isPanelAdmin(req)) return sendJson({ error: 'Solo un administrador' }, 403)
          return sendJson({ ok: cmdWorkerCacheMax(body.gb), workerCacheMaxGb })
        }
        case '/api/music-bitrate': {
          if (!isPanelAdmin(req)) return sendJson({ error: 'Solo un administrador' }, 403)
          return sendJson({ ok: cmdMusicBitrate(body.kbps), musicBitrateKbps })
        }
        case '/api/sound-pcm-window': {
          if (!isPanelAdmin(req)) return sendJson({ error: 'Solo un administrador' }, 403)
          return sendJson({ ok: cmdSoundPcmWindow(body.seconds), soundPcmWindowMs })
        }
        case '/api/max-queue': {
          if (!isPanelAdmin(req)) return sendJson({ error: 'Solo un administrador' }, 403)
          return sendJson({ ok: cmdMaxQueue(body.value), maxQueue: MAX_QUEUE })
        }
        case '/api/max-history': {
          if (!isPanelAdmin(req)) return sendJson({ error: 'Solo un administrador' }, 403)
          return sendJson({ ok: cmdMaxHistory(body.value), maxHistory: MAX_HISTORY })
        }
        case '/api/disconnect': {
          if (!isPanelAdmin(req)) return sendJson({ error: 'Solo un administrador' }, 403)
          cmdStop()
          S.queue.length = 0   // al desconectar sí se vacía la cola (reset completo)
          destroyConnection()
          return sendJson({ ok: true })
        }
        // Tiempo de auto-desconexión por inactividad (minutos; 0 = desactivado).
        case '/api/idle-disconnect': {
          if (!isPanelAdmin(req)) return sendJson({ error: 'Solo un administrador' }, 403)
          return sendJson({ ok: cmdIdleDisconnect(body.minutes), idleDisconnectMs })
        }
        // "Mantener conectado siempre" para el servidor activo (solo-admin de ese servidor).
        case '/api/keep-alive': {
          const gid = activeGuildId(S)
          const u = panelUser(req)
          if (!u || !rbac.isAdmin(u.id, gid)) return sendJson({ error: 'Solo un administrador' }, 403)
          if (!gid) return sendJson({ error: 'Sin servidor activo' }, 400)
          return sendJson({ ok: cmdKeepAlive(gid, !!body.value), keepAlive: keepAliveGuilds.has(gid) })
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
}

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

// Revisa en segundo plano los sonidos sin medir e iguala su volumen (loudness).
// No bloquea el arranque; secuencial para no saturar la VM.
soundLib.normalizeAll({ force: false })
  .then(r => { if (r.total) console.log(`Volumen: ${r.analyzed}/${r.total} sonidos medidos`) })
  .catch(err => console.error('normalizar sonidos:', err.message))

client.login(process.env.DISCORD_BOT_TOKEN)
