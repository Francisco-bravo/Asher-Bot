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
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle
} from 'discord.js'
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, StreamType
} from '@discordjs/voice'
import { spawn } from 'node:child_process'
import {
  readdirSync, existsSync, mkdirSync, readFileSync, writeFileSync,
  createWriteStream, chmodSync
} from 'node:fs'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import http from 'node:http'
import ffmpegStatic from 'ffmpeg-static'

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
  const args = ['--no-playlist', '--quiet', '--no-cache-dir', '--js-runtimes', 'node:/usr/bin/node']
  if (existsSync(COOKIES)) args.push('--cookies', COOKIES)
  return args.concat(extra)
}

// ── Estado ────────────────────────────────────────────────────────────────
// item: { url, title, duration, voiceChannelId, guildId, textChannelId }
const queue = []
const history = []
let current = null
let currentResource = null
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

let currentMixer = null

// ── Streaming ─────────────────────────────────────────────────────────────
function startStream(item, seekSec) {
  const yt = spawn(YTDLP, ytdlpArgs(['-f', 'bestaudio/best', '-o', '-', item.url]))
  const args = ['-loglevel', 'error', '-i', 'pipe:0']
  if (seekSec > 0) args.push('-ss', String(seekSec))
  args.push('-vn', '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1')
  const ff = spawn(FFMPEG, args)
  yt.stdout.pipe(ff.stdin)
  yt.stdout.on('error', () => {})
  ff.stdin.on('error', () => {})
  yt.on('error', err => console.error('yt-dlp:', err.message))
  ff.on('error', err => console.error('ffmpeg:', err.message))
  ff.stderr.on('data', d => process.stderr.write(d))
  activeProcs = [yt, ff]
  return ff.stdout
}

function killStreamProcs() {
  for (const p of activeProcs) { try { p.kill() } catch {} }
  activeProcs = []
}

function fetchMeta(item) {
  const proc = spawn(YTDLP, ytdlpArgs([
    '--skip-download', '--print', '%(title)s\n%(duration)s', item.url
  ]))
  let out = ''
  proc.stdout.on('data', d => out += d)
  proc.on('error', () => {})
  proc.on('close', () => {
    const [title, dur] = out.trim().split('\n')
    if (title) item.title = title
    const d = parseFloat(dur)
    if (!isNaN(d)) item.duration = d
    updatePanel()
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

async function findActiveVoiceChannel() {
  // Usar voiceStates (no channel.members): los miembros que ya estaban en voz
  // antes de que el bot arrancara no están en la caché de miembros.
  for (const guild of client.guilds.cache.values()) {
    const counts = new Map()
    for (const vs of guild.voiceStates.cache.values()) {
      if (!vs.channelId || vs.id === client.user.id) continue
      if (vs.member?.user?.bot) continue
      counts.set(vs.channelId, (counts.get(vs.channelId) || 0) + 1)
    }
    let bestId = null, bestN = 0
    for (const [id, n] of counts) if (n > bestN) { bestId = id; bestN = n }
    if (bestId) return await client.channels.fetch(bestId)
  }
  return null
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
      console.log(`Reproduciendo: ${current.title || current.url}${seekOffset ? ` (desde ${seekOffset}s)` : ''}`)
      const stream = startStream(current, seekOffset)
      currentMixer = new MixerStream(stream, () => currentResource ? currentResource.playbackDuration : 0)
      currentResource = createAudioResource(currentMixer, { inputType: StreamType.Raw })
      musicPlayer.play(currentResource)
      updatePanel()

      const err = await waitIdle(musicPlayer)
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
        current = null
        break
      }
    }
  } finally {
    playing = false
    currentResource = null
    currentMixer = null
    if (!current && queue.length === 0 && soundActive === 0) destroyConnection()
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
  fetchMeta(item)
  queue.push(item)
  const startsNow = !current && queue.length === 1
  ensurePlaying()
  updatePanel()
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
  queue.length = 0
  if (current) {
    transition = 'stop'
    musicPlayer.stop()
  } else if (soundActive === 0) {
    destroyConnection()
  }
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

async function playSound(name) {
  if (name.includes('\\') || name.split('/').some(s => s === '..' || s === '')) throw new Error('Nombre inválido')
  if (!listSounds().includes(name)) throw new Error('Sonido no encontrado')
  const filePath = join(SOUNDS_DIR, name)
  const id = ++soundIdSeq

  // Con música sonando: mezclar el sonido encima, música atenuada
  if (currentMixer && musicPlayer.state.status === AudioPlayerStatus.Playing) {
    const ff = spawnSoundFfmpeg(filePath)
    activeProcs.push(ff)
    const ov = currentMixer.addOverlay(ff.stdout)
    activeSounds.set(id, { file: name, proc: ff, ov, mixer: currentMixer })
    return id
  }

  // Sin música: reproducir directo
  if (!connection) {
    const ch = await findActiveVoiceChannel()
    if (!ch) throw new Error('No hay nadie en un canal de voz')
    await ensureConnection(ch.id, ch.guild.id)
  }

  finishDirectSound() // si había otro sonido directo, limpiarlo: play() lo reemplaza sin pasar por Idle
  soundActive = 1
  currentDirectId = id
  const ff = spawnSoundFfmpeg(filePath)
  activeSounds.set(id, { file: name, proc: ff, direct: true })
  connection.subscribe(soundPlayer)
  directResource = createAudioResource(ff.stdout, { inputType: StreamType.Raw, inlineVolume: true })
  directResource.volume.setVolume(soundVolume)
  soundPlayer.play(directResource)
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
    if (e.direct) { out.push({ id, file: e.file }); continue }
    if (e.mixer === currentMixer && e.mixer.overlays.has(e.ov)) out.push({ id, file: e.file })
    else activeSounds.delete(id)
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
    await message.reply('Reproducción detenida y cola vaciada.')
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
    current: current ? { url: current.url, title: current.title, duration: current.duration } : null,
    elapsed: elapsed(),
    paused: musicPlayer.state.status === AudioPlayerStatus.Paused,
    queue: queue.map(i => ({ url: i.url, title: i.title, duration: i.duration })),
    historyCount: history.length,
    connected: !!connection,
    voiceChannel: currentChannelName,
    playingSounds: playingSounds(),
    soundVolume,
  }
}

function authorized(req) {
  if (!PANEL_PASSWORD) return true
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

http.createServer(async (req, res) => {
  const sendJson = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Panel del bot"' })
    res.end('Contraseña requerida')
    return
  }
  const path = new URL(req.url, 'http://x').pathname
  try {
    if (req.method === 'GET') {
      if (path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(readFileSync(PANEL_HTML))
        return
      }
      if (path === '/api/state') return sendJson(getState())
      if (path === '/api/sounds') return sendJson(soundTree())
    }
    if (req.method === 'POST') {
      const body = await readBody(req)
      switch (path) {
        case '/api/play': {
          if (!body.url) return sendJson({ error: 'Falta la URL' }, 400)
          const resolved = await resolveInput(body.url)
          let vcId, gId
          if (current) { vcId = current.voiceChannelId; gId = current.guildId }
          else if (connection) { vcId = currentChannelId; gId = connection.joinConfig.guildId }
          else {
            const ch = await findActiveVoiceChannel()
            if (!ch) return sendJson({ error: 'No hay nadie en un canal de voz' }, 400)
            vcId = ch.id; gId = ch.guild.id
          }
          const r = addToQueue(resolved.url, vcId, gId, null, resolved.title)
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
          cmdStop()
          destroyConnection()
          return sendJson({ ok: true })
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
client.login(process.env.DISCORD_BOT_TOKEN)
