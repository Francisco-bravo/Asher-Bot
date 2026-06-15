// Caché de música. El object-store es la fuente de verdad durable; el disco
// local (data/music-cache/) es una caché LRU acotada. Una canción se persiste
// en el object-store al alcanzar CACHE_PLAY_THRESHOLD reproducciones, para no
// volver a descargarla con yt-dlp.
import { existsSync, statSync, rmSync, createReadStream } from 'node:fs'
import { join } from 'node:path'
import { getDb, now } from './db.mjs'
import { getStore } from './storage/index.mjs'
import { config, paths } from './config.mjs'

export function findByUrl(sourceUrl) {
  return getDb().prepare('SELECT * FROM songs WHERE source_url = ?').get(sourceUrl)
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

function cachePath(song) {
  return join(paths.musicCache, `${song.id}.${song.ext || 'webm'}`)
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
  const db = getDb()
  const store = getStore()
  const cp = cachePath(song)

  // 1) Hit en caché local
  if (existsSync(cp)) {
    touchCache(song.id, cp, statSync(cp).size)
  } else if (song.persisted && song.audio_key && await store.exists(song.audio_key)) {
    // 2) Está persistida en el object-store → bajar a caché
    await store.getToFile(song.audio_key, cp)
    touchCache(song.id, cp, statSync(cp).size)
  } else {
    // 3) No existe en ningún lado → descargar (yt-dlp)
    await downloader(cp)
    touchCache(song.id, cp, statSync(cp).size)
  }

  // Registrar la reproducción y, si cruza el umbral, persistir en object-store
  const updated = db.prepare(
    'UPDATE songs SET play_count = play_count + 1, last_played_at = ? WHERE id = ? RETURNING *'
  ).get(now(), song.id)

  if (!updated.persisted && updated.play_count >= config.cachePlayThreshold) {
    const key = `music/${updated.id}.${updated.ext || 'webm'}`
    await store.put(key, createReadStream(cp))
    db.prepare('UPDATE songs SET audio_key = ?, persisted = 1 WHERE id = ?').run(key, updated.id)
  }

  await evictIfNeeded()
  return cp
}

// Expulsa de la caché local los menos usados hasta volver bajo el tope.
export async function evictIfNeeded() {
  const db = getDb()
  let total = db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS s FROM local_cache').get().s
  if (total <= config.musicCacheMaxBytes) return { evicted: 0 }
  const rows = db.prepare('SELECT * FROM local_cache ORDER BY last_access_at ASC').all()
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
