// Carátulas de canciones: se guardan como override en el worker (compartido
// por todos los entornos), con prioridad sobre la miniatura auto-descargada
// de YouTube. El disco local no las necesita para reproducir.
const MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }

export async function store(songId, buffer, ext = 'jpg') {
  const { setArt } = await import('./music-cache.mjs')
  await setArt(songId, buffer, MIME_BY_EXT[ext] || 'image/jpeg')
}
