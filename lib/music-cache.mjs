// Caché de música. El catálogo (título/artista/duración/play_count/permanente)
// vive en el worker (CX33), compartido por todos los entornos — ver
// lib/worker-client.mjs. Santiago solo mantiene una caché LRU local en disco
// (local_cache) para no re-extraer canciones ya bajadas por el fallback
// geo-restringido (startLocalFallback en bot.mjs); todo lo demás pasa por HTTP.
import { existsSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, now } from './db.mjs'
import { config, paths } from './config.mjs'
import {
  workerSongsList, workerSongOne, workerSongUpsert, workerSongUpdate,
  workerSongPlay, workerSongDelete, workerSongArt, workerImport, workerKeep,
} from './worker-client.mjs'

export async function findByUrl(sourceUrl) {
  return workerSongOne({ url: sourceUrl })
}

export async function getById(id) {
  return workerSongOne({ id })
}

export async function upsertSong({ sourceUrl, title = null, artist = null, album = null, durationMs = null, ext = null }) {
  return workerSongUpsert({ sourceUrl, title, artist, album, durationMs, ext })
}

export function cachePath(song) {
  return join(paths.musicCache, `${song.id}.${song.ext || 'webm'}`)
}

// ¿Está el audio ya en la caché local en disco? (sin tocar red)
export function hasLocal(song) {
  return existsSync(cachePath(song))
}

function touchCache(songId, path, size) {
  getDb().prepare(
    `INSERT INTO local_cache (song_id, path, size_bytes, last_access_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(song_id) DO UPDATE SET last_access_at = excluded.last_access_at`
  ).run(songId, path, size, now())
}

// Devuelve la ruta local del audio, descargándolo si hace falta (fallback
// geo-restringido: la fuente NO pasa por el worker). `downloader(destPath)`
// lo provee el bot (yt-dlp local) y debe dejar el archivo en destPath.
export async function getLocalAudio(song, downloader) {
  const cp = cachePath(song)
  if (!existsSync(cp)) await downloader(cp)
  return registerPlay(song, cp)
}

// Contabiliza una reproducción del archivo `cp` (ya en disco): actualiza la
// caché LRU local y suma play_count en el catálogo del worker (best-effort:
// un worker caído no debe romper la reproducción local).
export async function registerPlay(song, cp) {
  if (existsSync(cp)) touchCache(song.id, cp, statSync(cp).size)
  await evictIfNeeded()
  try { await workerSongPlay(song.id) } catch {}
  return cp
}

// Contabiliza una reproducción SIN tocar disco local (modo worker normal: el
// audio vive en el disco del worker, Santiago solo lleva el contador).
export async function recordPlay(song) {
  try { return await workerSongPlay(song.id) } catch { return song }
}

// Asegura que el audio esté en la caché LOCAL sin contar una reproducción
// (fallback geo-restringido: "forzar caché" para no re-extraer la próxima vez).
export async function ensureCached(song, downloader) {
  const cp = cachePath(song)
  if (existsSync(cp)) {
    touchCache(song.id, cp, statSync(cp).size)
  } else {
    await downloader(cp)
    touchCache(song.id, cp, statSync(cp).size)
  }
  await evictIfNeeded()
  return cp
}

// Expulsa de la caché LOCAL los menos usados hasta volver bajo el tope.
// Nunca expulsa canciones permanentes (fijadas) — se consulta al worker.
export async function evictIfNeeded() {
  const db = getDb()
  let total = db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS s FROM local_cache').get().s
  if (total <= config.musicCacheMaxBytes) return { evicted: 0 }
  const rows = db.prepare('SELECT * FROM local_cache ORDER BY last_access_at ASC').all()
  let evicted = 0
  for (const r of rows) {
    if (total <= config.musicCacheMaxBytes) break
    let song = null
    try { song = await getById(r.song_id) } catch {}
    if (song && song.permanent) continue // nunca expulsar permanentes
    rmSync(r.path, { force: true })
    db.prepare('DELETE FROM local_cache WHERE song_id = ?').run(r.song_id)
    total -= r.size_bytes
    evicted++
  }
  return { evicted }
}

// ── Gestión desde la interfaz ───────────────────────────────────────────────
// Catálogo completo (del worker) + estado de caché LOCAL para el panel.
export async function listAll() {
  const songs = await workerSongsList()
  const cacheRows = getDb().prepare('SELECT * FROM local_cache').all()
  const cacheById = new Map(cacheRows.map(r => [r.song_id, r]))
  return songs.map(s => {
    const c = cacheById.get(s.id)
    return { ...s, cache_size: c ? c.size_bytes : null, cache_access: c ? c.last_access_at : null, cached: c ? 1 : 0 }
  })
}

// Fija/desfija una canción como permanente (no evictable).
export async function setPermanent(id, permanent) {
  return workerSongUpdate(id, { permanent })
}

// Renombra una canción (editar el título mostrado).
export async function setTitle(id, title) {
  return workerSongUpdate(id, { title })
}

// Persiste metadata obtenida (título/duración) en el catálogo. Solo actualiza
// los campos provistos (no nulos), para no pisar datos buenos.
export async function setMeta(id, { title = null, durationMs = null, artist = null } = {}) {
  const patch = {}
  if (title != null && title !== '') patch.title = title
  if (durationMs != null && !isNaN(durationMs)) patch.durationMs = Math.round(durationMs)
  if (artist != null && artist !== '') patch.artist = artist
  if (!Object.keys(patch).length) return getById(id)
  return workerSongUpdate(id, patch)
}

// Borra una canción: caché local + catálogo/audio/carátula en el worker.
export async function removeSong(id) {
  const song = await getById(id)
  if (!song) return false
  const db = getDb()
  const c = db.prepare('SELECT * FROM local_cache WHERE song_id = ?').get(Number(id))
  if (c) { try { rmSync(c.path, { force: true }) } catch {} }
  db.prepare('DELETE FROM local_cache WHERE song_id = ?').run(Number(id))
  await workerSongDelete(id)
  return true
}

// Guarda una carátula elegida a mano (override, prioridad sobre la de YouTube).
export async function setArt(id, buffer, mime) {
  await workerSongArt(id, buffer, mime)
}

// Sube un archivo de audio como canción permanente (persistida + fijada). Ya
// no toca el object-store local: el worker guarda el audio bajo la misma
// clave sintética `upload:<ts>:<rand>` que usa /import para audio geo-subido.
export async function uploadPermanent({ title, artist = null, ext = 'mp3', buffer, durationMs = null }) {
  const sourceUrl = `upload:${now()}:${Math.random().toString(36).slice(2, 8)}`
  const song = await workerSongUpsert({ sourceUrl, title, artist, durationMs, ext })
  await workerSongUpdate(song.id, { permanent: true })
  await workerImport(sourceUrl, buffer)
  await workerKeep(sourceUrl, true)
  return getById(song.id)
}
