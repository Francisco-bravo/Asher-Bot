// Caché de música. El object-store es la fuente de verdad durable; el disco
// local (data/music-cache/) es una caché LRU acotada. Una canción se persiste
// en el object-store al alcanzar CACHE_PLAY_THRESHOLD reproducciones, para no
// volver a descargarla con yt-dlp.
import { existsSync, statSync, rmSync, createReadStream, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, now } from './db.mjs'
import { getStore } from './storage/index.mjs'
import { config, paths } from './config.mjs'

export function findByUrl(sourceUrl) {
  return getDb().prepare('SELECT * FROM songs WHERE source_url = ?').get(sourceUrl)
}

export function getById(id) {
  return getDb().prepare('SELECT * FROM songs WHERE id = ?').get(Number(id))
}

export function upsertSong({ sourceUrl, title = null, artist = null, album = null, durationMs = null, ext = null }) {
  const db = getDb()
  const existing = findByUrl(sourceUrl)
  if (existing) return existing
  const info = db.prepare(
    `INSERT INTO songs (source_url, title, artist, album, duration_ms, ext, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(sourceUrl, title, artist, album, durationMs, ext, now())
  return db.prepare('SELECT * FROM songs WHERE id = ?').get(Number(info.lastInsertRowid))
}

export function cachePath(song) {
  return join(paths.musicCache, `${song.id}.${song.ext || 'webm'}`)
}

// ¿Está el audio ya en la caché local en disco? (sin tocar red ni yt-dlp)
export function hasLocal(song) {
  return existsSync(cachePath(song))
}

function touchCache(songId, path, size) {
  getDb().prepare(
    `INSERT INTO local_cache (song_id, path, size_bytes, last_access_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(song_id) DO UPDATE SET last_access_at = excluded.last_access_at`
  ).run(songId, path, size, now())
}

// Devuelve la ruta local del audio, descargándolo/persistiéndolo según haga falta.
// `downloader(destPath)` lo provee el bot (yt-dlp) y debe dejar el archivo en destPath.
export async function getLocalAudio(song, downloader) {
  const store = getStore()
  const cp = cachePath(song)

  // 1) Hit en caché local
  if (existsSync(cp)) {
    // ya está
  } else if (song.persisted && song.audio_key && await store.exists(song.audio_key)) {
    // 2) Está persistida en el object-store → bajar a caché
    await store.getToFile(song.audio_key, cp)
  } else {
    // 3) No existe en ningún lado → descargar (yt-dlp)
    await downloader(cp)
  }
  return registerPlay(song, cp)
}

// Contabiliza una reproducción del archivo `cp` (ya en disco): actualiza la
// caché LRU, sube play_count y persiste en el object-store al cruzar el umbral.
// Lo usa tanto getLocalAudio como el modo stream-first (cacheo en 2º plano).
export async function registerPlay(song, cp) {
  const db = getDb()
  const store = getStore()
  if (existsSync(cp)) touchCache(song.id, cp, statSync(cp).size)
  const updated = db.prepare(
    'UPDATE songs SET play_count = play_count + 1, last_played_at = ? WHERE id = ? RETURNING *'
  ).get(now(), song.id)

  if (!updated.persisted && updated.play_count >= config.cachePlayThreshold && existsSync(cp)) {
    const key = `music/${updated.id}.${updated.ext || 'webm'}`
    await store.put(key, createReadStream(cp))
    db.prepare('UPDATE songs SET audio_key = ?, persisted = 1 WHERE id = ?').run(key, updated.id)
  }

  await evictIfNeeded()
  return cp
}

// Asegura que el audio esté en la caché local SIN contar una reproducción
// (para "forzar caché" desde la interfaz). Baja del object-store o descarga.
export async function ensureCached(song, downloader) {
  const store = getStore()
  const cp = cachePath(song)
  if (existsSync(cp)) {
    touchCache(song.id, cp, statSync(cp).size)
  } else if (song.persisted && song.audio_key && await store.exists(song.audio_key)) {
    await store.getToFile(song.audio_key, cp)
    touchCache(song.id, cp, statSync(cp).size)
  } else {
    await downloader(cp)
    touchCache(song.id, cp, statSync(cp).size)
  }
  await evictIfNeeded()
  return cp
}

// Expulsa de la caché local los menos usados hasta volver bajo el tope.
// Nunca expulsa canciones permanentes (fijadas).
export async function evictIfNeeded() {
  const db = getDb()
  let total = db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS s FROM local_cache').get().s
  if (total <= config.musicCacheMaxBytes) return { evicted: 0 }
  const rows = db.prepare(`
    SELECT lc.* FROM local_cache lc
    JOIN songs s ON s.id = lc.song_id
    WHERE s.permanent = 0
    ORDER BY lc.last_access_at ASC
  `).all()
  let evicted = 0
  for (const r of rows) {
    if (total <= config.musicCacheMaxBytes) break
    rmSync(r.path, { force: true })
    db.prepare('DELETE FROM local_cache WHERE song_id = ?').run(r.song_id)
    total -= r.size_bytes
    evicted++
  }
  return { evicted }
}

// ── Gestión desde la interfaz ───────────────────────────────────────────────
// Lista todas las canciones con su estado de caché (para el panel).
export function listAll() {
  return getDb().prepare(`
    SELECT s.*, c.size_bytes AS cache_size, c.last_access_at AS cache_access,
           CASE WHEN c.song_id IS NULL THEN 0 ELSE 1 END AS cached
    FROM songs s
    LEFT JOIN local_cache c ON c.song_id = s.id
    ORDER BY COALESCE(s.last_played_at, 0) DESC, s.created_at DESC
  `).all()
}

// Fija/desfija una canción como permanente (no evictable).
export function setPermanent(id, permanent) {
  getDb().prepare('UPDATE songs SET permanent = ? WHERE id = ?').run(permanent ? 1 : 0, Number(id))
  return getById(id)
}

// Renombra una canción (editar el título mostrado).
export function setTitle(id, title) {
  getDb().prepare('UPDATE songs SET title = ? WHERE id = ?').run(title, Number(id))
  return getById(id)
}

// Borra una canción: archivo de caché, objeto del store, referencias y fila.
export async function removeSong(id) {
  const db = getDb()
  const song = getById(id)
  if (!song) return false
  const c = db.prepare('SELECT * FROM local_cache WHERE song_id = ?').get(song.id)
  if (c) { try { rmSync(c.path, { force: true }) } catch {} }
  if (song.audio_key) { try { await getStore().delete(song.audio_key) } catch {} }
  if (song.art_key) { try { await getStore().delete(song.art_key) } catch {} } // carátula
  db.prepare('DELETE FROM playlist_items WHERE song_id = ?').run(song.id) // sin cascade en el esquema
  db.prepare('DELETE FROM songs WHERE id = ?').run(song.id)               // cascade borra local_cache
  return true
}

// Sube un archivo de audio como canción permanente (persistida + fijada).
export async function uploadPermanent({ title, artist = null, ext = 'mp3', buffer, durationMs = null }) {
  const db = getDb()
  const ts = now()
  const sourceUrl = `upload:${ts}:${Math.random().toString(36).slice(2, 8)}` // clave única sintética
  const info = db.prepare(
    `INSERT INTO songs (source_url, title, artist, duration_ms, ext, play_count, persisted, permanent, created_at)
     VALUES (?, ?, ?, ?, ?, 0, 1, 1, ?)`
  ).run(sourceUrl, title, artist, durationMs, ext, ts)
  const id = Number(info.lastInsertRowid)
  const key = `music/${id}.${ext}`
  db.prepare('UPDATE songs SET audio_key = ? WHERE id = ?').run(key, id)
  await getStore().put(key, buffer)                 // fuente de verdad durable
  const cp = join(paths.musicCache, `${id}.${ext}`) // espejo en caché local (fijado)
  writeFileSync(cp, buffer)
  db.prepare(
    'INSERT INTO local_cache (song_id, path, size_bytes, last_access_at) VALUES (?, ?, ?, ?)'
  ).run(id, cp, buffer.length, ts)
  return getById(id)
}
