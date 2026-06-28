// Mixers de audio PCM s16le 48kHz estéreo.
//  · MixerStream: la música es la base y los sonidos del soundboard se suman
//    encima con la música atenuada (ducking).
//  · SoundMixer: base de silencio para reproducir sonidos SIN música.
// Los volúmenes (música, ducking, base de sonidos) cambian en vivo desde el
// panel, así que se leen mediante getters inyectados (no se capturan valores).
import { Readable } from 'node:stream'

export const SILENCE = Buffer.alloc(19200) // 50ms de silencio
export const BYTES_PER_MS = 192 // PCM s16le 48kHz estéreo
export const LEAD_BYTES = 96000 // ~500ms de adelanto máximo sobre lo reproducido

// Multiplica en sitio las muestras PCM s16le por `factor`, con recorte a ±32767.
export function applyGainInPlace(buf, factor) {
  for (let i = 0; i + 1 < buf.length; i += 2) {
    let v = (buf.readInt16LE(i) * factor) | 0
    if (v > 32767) v = 32767
    else if (v < -32768) v = -32768
    buf.writeInt16LE(v, i)
  }
  return buf
}

const num = (fn, dflt) => { const v = typeof fn === 'function' ? fn() : fn; return typeof v === 'number' ? v : dflt }

export class MixerStream extends Readable {
  // getPlayedMs: cuántos ms lleva reproducidos el player. El mixer solo avanza
  // LEAD_BYTES por delante de eso; sin este freno, el encoder opus consume la
  // canción entera en segundos, el mixer "termina" y los sonidos del soundboard
  // ya no tienen dónde mezclarse.
  // vol: { getMusicVolume, getMusicDuck, getSoundBaseVolume } (se leen en vivo).
  constructor(base, getPlayedMs = () => Infinity, vol = {}) {
    super()
    this.base = base
    this.getPlayedMs = getPlayedMs
    this.vol = vol
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

  get _musicVolume() { return num(this.vol.getMusicVolume, 1) }
  get _musicDuck() { return num(this.vol.getMusicDuck, 0.35) }
  get _soundBaseVolume() { return num(this.vol.getSoundBaseVolume, 1) }

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
      // Con sonidos encima → _mix (aplica ducking + volumen de música). Sin
      // sonidos → solo el volumen de música (si no es 1; si es 1, pasa tal cual).
      let out
      const mv = this._musicVolume
      if (this.overlays.size > 0) out = this._mix(chunk)
      else if (mv !== 1) out = applyGainInPlace(Buffer.from(chunk), mv)
      else out = chunk
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
    const soundBaseVolume = this._soundBaseVolume
    // Música: atenuada por el ducking y escalada por el volumen de música.
    applyGainInPlace(out, this._musicDuck * this._musicVolume)
    for (const ov of [...this.overlays]) {
      if (ov.ended && ov.length === 0) { this.overlays.delete(ov); continue }
      const avail = Math.min(out.length, ov.length) & ~1
      if (avail === 0) continue
      const data = this._takeFrom(ov, avail)
      for (let i = 0; i + 1 < data.length && i + 1 < out.length; i += 2) {
        let v = out.readInt16LE(i) + ((data.readInt16LE(i) * soundBaseVolume) | 0)
        if (v > 32767) v = 32767
        else if (v < -32768) v = -32768
        out.writeInt16LE(v, i)
      }
    }
    return out
  }
}

// Mixer del soundboard SIN música: base de SILENCIO sobre la que se mezclan N
// sonidos a la vez (sin límite, sin "uno a la vez"). Paceado a tiempo real. Se
// auto-cierra tras unos segundos sin sonidos (llama a onClose). El volumen base
// (getSoundBaseVolume) se aplica al mezclar, en vivo.
export class SoundMixer extends Readable {
  // opts: { getSoundBaseVolume, onClose(instancia) }
  constructor(opts = {}) {
    super()
    this.opts = opts
    this.overlays = new Set()
    this.pushedBytes = 0
    this.startMs = Date.now()
    this.lastActive = Date.now()
    this._closed = false
    this.timer = null
    this._schedule()
  }
  addOverlay(stream) {
    const ov = { chunks: [], length: 0, ended: false }
    stream.on('data', d => { ov.chunks.push(d); ov.length += d.length })
    stream.on('end', () => { ov.ended = true })
    stream.on('error', () => { ov.ended = true })
    this.overlays.add(ov)
    this.lastActive = Date.now()
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
  _read() {}
  _mix() {
    const out = Buffer.alloc(SILENCE.length) // base de silencio
    const soundBaseVolume = num(this.opts.getSoundBaseVolume, 1)
    for (const ov of [...this.overlays]) {
      if (ov.ended && ov.length === 0) { this.overlays.delete(ov); continue }
      const avail = Math.min(out.length, ov.length) & ~1
      if (avail === 0) continue
      const data = this._takeFrom(ov, avail)
      for (let i = 0; i + 1 < data.length; i += 2) {
        let v = out.readInt16LE(i) + ((data.readInt16LE(i) * soundBaseVolume) | 0)
        if (v > 32767) v = 32767
        else if (v < -32768) v = -32768
        out.writeInt16LE(v, i)
      }
    }
    return out
  }
  _schedule() {
    this.timer = setTimeout(() => {
      if (this._closed) return
      const now = Date.now()
      const target = (now - this.startMs) * BYTES_PER_MS // realtime: nunca adelantarse
      while (this.pushedBytes < target) {
        const out = this._mix()
        this.pushedBytes += out.length
        this.push(out)
      }
      if (this.overlays.size > 0) this.lastActive = now
      if (now - this.lastActive > 2000) { this.close(); return } // sin sonidos: cerrar
      this._schedule()
    }, 20)
  }
  close() {
    if (this._closed) return
    this._closed = true
    if (this.timer) clearTimeout(this.timer)
    try { this.push(null) } catch {}
    if (typeof this.opts.onClose === 'function') { try { this.opts.onClose(this) } catch {} }
  }
}
