// Búsqueda de carátulas desde varias fuentes, en orden de preferencia.
//  - iTunes Search API y Deezer: APIs públicas SIN clave → siempre disponibles.
//  - album-art (npm): fuente extra (Last.fm/Spotify/iTunes) si está instalada.
//  - music-metadata (npm): lee el arte EMBEBIDO de un archivo de audio (equivalente
//    en Node a Mutagen/MusicTag) → útil para canciones subidas o cacheadas localmente.
// album-art y music-metadata se cargan por import dinámico best-effort: si no están
// instaladas, simplemente se omiten (iTunes/Deezer siguen funcionando).
// Todas devuelven { buf, ext } o null.
import { existsSync } from 'node:fs'

const TIMEOUT = 8000
const sig = ms => { try { return AbortSignal.timeout(ms) } catch { return undefined } }

// Limpia un título de YouTube para buscar mejor (quita "(Official Video)", "[HD]",
// "Lyric Video", "feat.", "4K Remaster", etc.). Devuelve "artista título" si hay artista.
export function cleanQuery(title = '', artist = '') {
  let t = String(title || '')
    .replace(/[([][^)\]]*\b(official|video|audio|lyrics?|hd|hq|4k|8k|remaster(ed)?|visuali[sz]er|m\/?v|color\s*coded)\b[^)\]]*[)\]]/gi, ' ')
    .replace(/\b(official\s*(music\s*)?video|lyrics?\s*video|official\s*audio|visuali[sz]er)\b/gi, ' ')
    .replace(/\s*[-|·]\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return [artist, t].filter(Boolean).join(' ').trim() || String(title || '')
}

export async function fetchImg(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null
  try {
    const r = await fetch(url, { signal: sig(TIMEOUT) })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length < 800) return null // imágenes diminutas = placeholder/roto
    const ct = (r.headers.get('content-type') || '').toLowerCase()
    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : 'jpg'
    return { buf, ext }
  } catch { return null }
}

export async function itunesArt(term) {
  if (!term) return null
  try {
    const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=1`, { signal: sig(TIMEOUT) })
    if (!r.ok) return null
    const d = await r.json()
    const a = d.results?.[0]?.artworkUrl100
    if (!a) return null
    // Subir resolución: iTunes sirve 100x100 pero acepta 600x600 (incluso 1200).
    return await fetchImg(a.replace(/\/\d+x\d+bb\.(jpg|png)/i, '/600x600bb.$1'))
  } catch { return null }
}

export async function deezerArt(term) {
  if (!term) return null
  try {
    const r = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(term)}&limit=1`, { signal: sig(TIMEOUT) })
    if (!r.ok) return null
    const d = await r.json()
    const al = d.data?.[0]?.album
    const cover = al?.cover_xl || al?.cover_big || al?.cover_medium
    return cover ? await fetchImg(cover) : null
  } catch { return null }
}

// Paquete npm 'album-art' (best-effort: solo si está instalado).
export async function albumArtNpm(artist, album) {
  if (!artist) return null
  try {
    const mod = await import('album-art').catch(() => null)
    if (!mod) return null
    const albumArt = mod.default || mod
    const url = await albumArt(artist, album ? { album, size: 'large' } : { size: 'large' })
    return (typeof url === 'string') ? await fetchImg(url) : null
  } catch { return null }
}

// Arte embebido del archivo de audio vía 'music-metadata' (best-effort; ≈ Mutagen/MusicTag).
export async function embeddedArt(filePath) {
  if (!filePath || !existsSync(filePath)) return null
  try {
    const mm = await import('music-metadata').catch(() => null)
    if (!mm) return null
    const meta = await mm.parseFile(filePath)
    const pic = meta.common?.picture?.[0]
    if (!pic?.data?.length) return null
    const ext = String(pic.format || '').includes('png') ? 'png' : 'jpg'
    return { buf: Buffer.from(pic.data), ext }
  } catch { return null }
}

// ── Modo "elegir": devuelven VARIAS candidatas { source, url, label } para un modal.
export async function itunesOptions(term, limit = 8) {
  if (!term) return []
  try {
    const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=${limit}`, { signal: sig(TIMEOUT) })
    if (!r.ok) return []
    const d = await r.json()
    const seen = new Set(), out = []
    for (const x of (d.results || [])) {
      if (!x.artworkUrl100) continue
      const url = x.artworkUrl100.replace(/\/\d+x\d+bb\.(jpg|png)/i, '/600x600bb.$1')
      if (seen.has(url)) continue; seen.add(url)
      out.push({ source: 'iTunes', url, label: [x.artistName, x.trackName].filter(Boolean).join(' – ') })
    }
    return out
  } catch { return [] }
}
export async function deezerOptions(term, limit = 8) {
  if (!term) return []
  try {
    const r = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(term)}&limit=${limit}`, { signal: sig(TIMEOUT) })
    if (!r.ok) return []
    const d = await r.json()
    const seen = new Set(), out = []
    for (const x of (d.data || [])) {
      const cover = x.album?.cover_xl || x.album?.cover_big
      if (!cover || seen.has(cover)) continue; seen.add(cover)
      out.push({ source: 'Deezer', url: cover, label: [x.artist?.name, x.title].filter(Boolean).join(' – ') })
    }
    return out
  } catch { return [] }
}
export async function albumArtUrl(artist, album) {
  if (!artist) return null
  try {
    const mod = await import('album-art').catch(() => null)
    if (!mod) return null
    const albumArt = mod.default || mod
    const url = await albumArt(artist, album ? { album, size: 'large' } : { size: 'large' })
    return (typeof url === 'string' && /^https?:\/\//i.test(url)) ? url : null
  } catch { return null }
}
export async function embeddedOption(localFile) {
  const r = await embeddedArt(localFile)
  if (!r) return []
  const mime = r.ext === 'png' ? 'image/png' : 'image/jpeg'
  return [{ source: 'archivo', url: `data:${mime};base64,${r.buf.toString('base64')}`, label: 'arte embebido del archivo' }]
}
// Junta candidatas de todas las fuentes para que el usuario elija en un modal.
export async function searchAllOptions(song, { query = null, localFile = null } = {}) {
  const term = (query && query.trim()) || cleanQuery(song.title, song.artist)
  const [em, it, dz, au] = await Promise.all([
    embeddedOption(localFile),
    itunesOptions(term),
    deezerOptions(term),
    albumArtUrl(song.artist || term, song.album).then(u => u ? [{ source: 'álbum (album-art)', url: u, label: term }] : []).catch(() => []),
  ])
  // Dedup global por URL, manteniendo el orden de preferencia.
  const seen = new Set(), out = []
  for (const o of [...em, ...it, ...dz, ...au]) { if (o.url && !seen.has(o.url)) { seen.add(o.url); out.push(o) } }
  return out
}

// Resuelve la mejor carátula para una canción. Orden: iTunes → Deezer → (manual:
// album-art → arte embebido) → thumbFallback (la miniatura "de siempre", p.ej. de
// YouTube). `thumbFallback` es async ()=>({buf,ext}|null). Devuelve {buf,ext}|null.
export async function resolveArt(song, { manual = false, query = null, localFile = null, thumbFallback = null } = {}) {
  const term = (query && query.trim()) || cleanQuery(song.title, song.artist)
  let r = await itunesArt(term)
  if (!r) r = await deezerArt(term)
  if (!r && manual) r = await albumArtNpm(song.artist || song.title, song.album)
  if (!r && manual && localFile) r = await embeddedArt(localFile)
  if (!r && thumbFallback) { try { r = await thumbFallback() } catch {} }
  return r
}
