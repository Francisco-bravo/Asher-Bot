// Carátulas de canciones/álbumes. Se guardan en el object-store (en prod,
// servidas por CDN). El disco local no las necesita para reproducir.
import { getDb } from './db.mjs'
import { getStore } from './storage/index.mjs'

export async function store(songId, buffer, ext = 'jpg') {
  const key = `art/${songId}.${ext}`
  await getStore().put(key, buffer)
  getDb().prepare('UPDATE songs SET art_key = ? WHERE id = ?').run(key, songId)
  return key
}

export function publicUrl(song) {
  if (!song.art_key) return null
  return getStore().publicUrl(song.art_key)
}
