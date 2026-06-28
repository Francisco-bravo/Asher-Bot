// Helpers de yt-dlp local (Santiago) + invariante "máximo UN yt-dlp de fondo a
// la vez". El audio pesado normalmente lo hace el worker (lib/worker-client);
// esto es el fallback local y las resoluciones puntuales de metadata/playlist.
// Las rutas (yt-dlp, cookies, etc.) se inyectan una vez con initYtdlp().
import { spawn } from 'node:child_process'
import { existsSync, createWriteStream, chmodSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const cfg = { YTDLP: 'yt-dlp', COOKIES: '', IS_WIN: false, YTDLP_ASSET: null, YTDLP_URL: '' }
export function initYtdlp(c) { Object.assign(cfg, c) }

// ── Proceso de fondo: garantiza que NUNCA corran dos yt-dlp a la vez ──────────
// Las funciones de este módulo registran su proceso aquí; los spawn de fondo de
// fuera (fetchMetaLocal, downloadToFile) usan trackBg/untrackBg. killBgYtdlp se
// llama al arrancar una reproducción para matar el yt-dlp de fondo en curso.
let bgProc = null
export function trackBg(proc) { bgProc = proc; return proc }
export function untrackBg(proc) { if (bgProc === proc) bgProc = null }
export function killBgYtdlp() {
  if (bgProc) { try { bgProc.kill() } catch {} bgProc = null }
}

export function ytdlpArgs(extra) {
  // Runtimes JS para el desafío de YouTube: Bun (primario) y Node (respaldo).
  // Se quitó Deno de la VM porque, si está presente, yt-dlp lo prefiere siempre.
  // Sin --no-cache-dir para que yt-dlp cachee el solve y repetir un tema sea rápido.
  const args = ['--no-playlist', '--quiet',
    '--js-runtimes', 'bun:/usr/local/bin/bun',
    '--js-runtimes', 'node:/usr/bin/node']
  if (existsSync(cfg.COOKIES)) args.push('--cookies', cfg.COOKIES)
  return args.concat(extra)
}

// Como ytdlpArgs pero SIN --no-playlist y con --flat-playlist: para listar las
// entradas de una playlist (rápido, sin resolver cada video) al importarla.
export function ytdlpPlaylistArgs(extra) {
  const args = ['--flat-playlist', '--quiet',
    '--js-runtimes', 'bun:/usr/local/bin/bun',
    '--js-runtimes', 'node:/usr/bin/node']
  if (existsSync(cfg.COOKIES)) args.push('--cookies', cfg.COOKIES)
  return args.concat(extra)
}

// Descarga automática de yt-dlp en Linux si no está presente.
export async function ensureYtDlp() {
  if (existsSync(cfg.YTDLP)) return
  if (cfg.IS_WIN) throw new Error(`No se encontró ${cfg.YTDLP}`)
  console.log(`Descargando yt-dlp (${cfg.YTDLP_ASSET})...`)
  const res = await fetch(cfg.YTDLP_URL, { redirect: 'follow' })
  if (!res.ok) throw new Error(`No se pudo descargar yt-dlp: HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(cfg.YTDLP))
  chmodSync(cfg.YTDLP, 0o755)
  console.log('yt-dlp listo.')
}

// Lee un único campo de metadatos con yt-dlp (resuelve búsquedas a URL real).
export function ytdlpPrint(url, field) {
  return new Promise(resolve => {
    const proc = spawn(cfg.YTDLP, ytdlpArgs(['--skip-download', '--print', `%(${field})s`, url]))
    bgProc = proc
    let out = ''
    proc.stdout.on('data', d => out += d)
    proc.on('error', () => { if (bgProc === proc) bgProc = null; resolve(null) })
    proc.on('close', () => { if (bgProc === proc) bgProc = null; resolve(out.trim() || null) })
  })
}

// Resuelve fuente real + título + duración en UNA sola llamada (resuelve también
// términos de búsqueda ytsearch1:). Para crear canciones de playlist con metadata.
export function ytdlpResolveMetaLocal(url) {
  return new Promise(resolve => {
    const proc = spawn(cfg.YTDLP, ytdlpArgs(['--skip-download', '--print', '%(webpage_url)s\t%(title)s\t%(duration)s', url]))
    bgProc = proc
    let out = ''
    proc.stdout.on('data', d => out += d)
    proc.on('error', () => { if (bgProc === proc) bgProc = null; resolve(null) })
    proc.on('close', () => {
      if (bgProc === proc) bgProc = null
      const [sourceUrl, title, dur] = (out.trim().split('\n')[0] || '').split('\t')
      resolve(sourceUrl ? { sourceUrl, title: title || null, duration: parseFloat(dur) } : null)
    })
  })
}

// Traduce un error de yt-dlp de playlist a un mensaje claro (fallback local; el
// worker tiene su propia copia de esta lógica).
export function classifyPlaylistError(text) {
  const t = (text || '').toLowerCase()
  if (/private|privada/.test(t)) return 'La playlist es PRIVADA. Cámbiala a "Pública" o "No listada" en YouTube y reintenta.'
  if (/does not exist|unavailable|deleted|removed|not found|no longer|404/.test(t)) return 'La playlist no existe o fue eliminada. Verifica que el enlace sea correcto.'
  if (/sign in|log in|confirm you|members-only|cookies|age/.test(t)) return 'La playlist requiere iniciar sesión (es privada o solo para miembros).'
  return 'No se pudo acceder a la playlist. Asegúrate de que el enlace sea correcto y de que la playlist sea pública o "no listada".'
}

// Lista las entradas (url + título) de una playlist sin resolver cada video.
export function ytdlpFlatPlaylistLocal(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cfg.YTDLP, ytdlpPlaylistArgs(['--print', '%(url)s\t%(title)s\t%(duration)s\t%(playlist_title)s\t%(thumbnail)s', url]))
    bgProc = proc
    let out = '', err = ''
    proc.stdout.on('data', d => out += d)
    proc.stderr.on('data', d => err += d)
    proc.on('error', e => { if (bgProc === proc) bgProc = null; reject(e) })
    proc.on('close', code => {
      if (bgProc === proc) bgProc = null
      if (code !== 0 && !out.trim()) { const e = new Error(classifyPlaylistError(err)); e.playlistError = true; return reject(e) }
      const entries = out.trim().split('\n').filter(Boolean).map(line => {
        const [u, title, dur, plTitle, thumb] = line.split('\t')
        return {
          url: u,
          title: (title && title !== 'NA') ? title : u,
          duration: parseFloat(dur),
          playlistTitle: (plTitle && plTitle !== 'NA') ? plTitle : null,
          thumbnail: (thumb && thumb !== 'NA' && /^https?:\/\//i.test(thumb)) ? thumb : null,
        }
      }).filter(e => e.url && /^https?:\/\//i.test(e.url))
      resolve(entries)
    })
  })
}
