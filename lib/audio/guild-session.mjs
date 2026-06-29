// Estado de reproducción POR SERVIDOR (GuildSession). Todo el estado en vivo de
// una guild de Discord (cola, historial, conexión, players, mixer, prefetch,
// passthrough de Opus) vive en una instancia de esta clase. El motor de audio en
// bot.mjs opera sobre la sesión activa (ver AsyncLocalStorage en bot.mjs).
//
// Es un contenedor de estado puro: no conoce el motor. Las dependencias externas
// (los constructores de player de @discordjs/voice, el volumen por defecto y el
// callback de "sonido directo terminó") se inyectan vía defineGuildSession(),
// para no acoplar este módulo a bot.mjs ni a discord.js.
//
// Trabajo de fondo (metadata/carátula/pre-cacheo): corre SOLO cuando no hay un
// stream de reproducción descargando → JAMÁS dos yt-dlp a la vez (regla estricta).
// Gapless: al cerrar el yt-dlp de la canción actual (descarga terminada) se
// dispara el pre-cacheo a DISCO de la siguiente; al terminar de sonar, ya está.

// Construye la clase GuildSession con sus dependencias inyectadas:
//   - createAudioPlayer: factoría de player de @discordjs/voice.
//   - AudioPlayerStatus: enum de estados (para el listener Idle).
//   - getDefaultMusicVolume(): volumen de música con que nace cada sesión (el
//     default global, leído en el momento de crear la sesión).
//   - onSoundIdle(session): se llama al quedar idle/errar el soundPlayer de ESA
//     sesión (limpia el sonido directo). En bot.mjs = finishDirectSound.
export function defineGuildSession({ createAudioPlayer, AudioPlayerStatus, getDefaultMusicVolume, onSoundIdle }) {
  return class GuildSession {
    constructor(guildId = null) {
      this.guildId = guildId
      this.queue = []
      this.history = []
      this.current = null
      this.currentResource = null
      this.prefetching = false        // el trabajo de fondo está activo
      this.streamDownloading = false  // hay un yt-dlp de reproducción descargando (con extracción)
      this.currentPlaying = false     // la canción actual YA suena (pasó la extracción inicial)
      this.bgSongId = null            // id de la canción que el fondo está pre-cacheando
      this.bgPromise = null           // promesa del pre-cacheo en curso (para esperarlo si toca)
      this.playFailReason = null      // motivo si la canción actual no se pudo reproducir
      this.seekOffset = 0             // segundos ya descartados por seek en el stream actual
      this.seekTarget = 0             // desde dónde arrancar el próximo stream
      this.transition = 'next'        // al quedar idle: next | previous | seek | stop
      this.playing = false
      this.connection = null
      this.currentChannelId = null
      this.currentChannelName = null
      this.soundActive = 0
      this.activeProcs = []
      this.remoteAbort = null         // AbortController del fetch al worker (si USE_WORKER)
      this.soundIdSeq = 0
      this.activeSounds = new Map()   // id -> { file, proc, ov?, mixer?, direct? }
      // Passthrough de Opus: música sola → Ogg/Opus del worker tal cual (sin ffmpeg
      // ni encoder). Si hubo soundboard en los últimos soundPcmWindowMs, se queda
      // en mezcla PCM → cero cortes (prioridad soundboard).
      this.opusDirect = false         // la canción actual suena en passthrough (sin mixer)
      this.lastSoundAt = 0            // timestamp del último uso del soundboard
      this.pendingSounds = []         // sonidos a soltar cuando el mixer PCM esté listo tras un switch
      this.soundMixer = null
      this.currentMixer = null
      this.panelMsg = null            // mensaje del panel de control en el chat de Discord
      this.currentDirectId = null
      this.directResource = null
      this.lastMusicVolumeAt = 0      // último cambio de volumen (cooldown)
      this.musicVolume = getDefaultMusicVolume() // volumen de música POR SERVIDOR (sembrado del default global)
      this.panelUpdateQueued = false
      this.musicPlayer = createAudioPlayer()
      this.soundPlayer = createAudioPlayer()
      // Listeners por sesión: al quedar idle/errar el soundPlayer, limpia el sonido
      // directo de ESTA sesión.
      this.soundPlayer.on(AudioPlayerStatus.Idle, () => onSoundIdle(this))
      this.soundPlayer.on('error', err => { console.error('sound:', err.message); onSoundIdle(this) })
    }
  }
}
