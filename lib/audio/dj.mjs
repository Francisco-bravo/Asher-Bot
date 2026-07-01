// DJ automático: cuando la cola de una sesión se queda vacía y el modo DJ está
// activo para ese servidor, elige la siguiente canción sola. Si la última
// canción sonada venía de una playlist, continúa esa playlist (sin repetir en
// la sesión de DJ); al agotarla —o si no venía de ninguna— pasa a elegir al
// azar de toda la Biblioteca, sin repetir hasta agotarla (al agotrarla,
// reinicia y sigue). El estado de "ya sonadas en esta sesión de DJ" y "qué
// playlist se está siguiendo" vive en la propia GuildSession (djPlayedIds /
// djLastPlaylistId), para que cada servidor tenga su propio DJ independiente.
import * as playlists from '../playlists.mjs'
import * as musicCache from '../music-cache.mjs'

export function pickNext(S) {
  if (S.djLastPlaylistId) {
    const rest = playlists.items(S.djLastPlaylistId).filter(it => !S.djPlayedIds.has(it.song_id))
    if (rest.length) {
      const it = rest[0]
      S.djPlayedIds.add(it.song_id)
      return toQueueItem(S, { id: it.song_id, source_url: it.source_url, title: it.title, duration_ms: it.duration_ms }, S.djLastPlaylistId)
    }
    // Playlist agotada: de acá en más, aleatorio (no se vuelve sola a esta lista).
    S.djLastPlaylistId = null
  }

  let pool = musicCache.listAll().filter(s => !S.djPlayedIds.has(s.id))
  if (!pool.length) {
    S.djPlayedIds.clear() // biblioteca agotada: reinicia y sigue (puede repetir)
    pool = musicCache.listAll()
  }
  if (!pool.length) return null // biblioteca vacía, nada para elegir

  const song = pool[Math.floor(Math.random() * pool.length)]
  S.djPlayedIds.add(song.id)
  return toQueueItem(S, song, null)
}

function toQueueItem(S, song, playlistId) {
  return {
    url: song.source_url,
    title: song.title || song.source_url,
    duration: song.duration_ms ? song.duration_ms / 1000 : null,
    voiceChannelId: S.currentChannelId,
    guildId: S.guildId,
    textChannelId: null,
    addedBy: { id: 'dj', name: 'DJ automático', avatar: null },
    playlistId,
    songId: song.id,
  }
}
