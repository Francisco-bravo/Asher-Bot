// Análisis de sonoridad (loudness) con ffmpeg para igualar el volumen de los
// sonidos. Mide cada archivo una vez (EBU R128 / filtro loudnorm) y calcula la
// ganancia en dB para llevarlo a un objetivo común; la ganancia se aplica en
// vivo al reproducir (no se reescribe el archivo).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import ffmpegStatic from 'ffmpeg-static'

// Igual que bot.mjs: en la VM se prefiere el ffmpeg del sistema.
const FFMPEG = process.env.FFMPEG_PATH ||
  (existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : ffmpegStatic)

// LUFS objetivo (sonoridad integrada). Configurable desde el panel (Variables
// Generales). -16 = solo igualar; subirlo acerca el volumen al máximo sin saturar
// (el techo de true-peak evita el recorte). -6.5 ≈ +9.5 dB ≈ al triple.
export let TARGET_I = -6.5

// Cambia el objetivo de loudness en vivo. Lo deja en un rango sensato. Tras
// cambiarlo hay que volver a medir los sonidos (normalizeAll force) para que
// la nueva ganancia se recalcule por archivo.
export function setTargetI(v) {
  const n = Number(v)
  if (Number.isFinite(n)) TARGET_I = Math.max(-30, Math.min(0, Math.round(n * 10) / 10))
  return TARGET_I
}
const TP_CEIL = -1.5          // techo de true peak (dBTP) para no saturar al subir
const MIN_GAIN = -15, MAX_GAIN = 25

// Ganancia (dB) para llevar `inputI` (LUFS) al objetivo, sin que el pico supere
// el techo. Silencio o medidas inválidas → 0 (no tocar).
export function computeGain(inputI, inputTp) {
  if (!Number.isFinite(inputI) || inputI <= -70) return 0
  let gain = TARGET_I - inputI
  if (Number.isFinite(inputTp)) gain = Math.min(gain, TP_CEIL - inputTp)
  gain = Math.max(MIN_GAIN, Math.min(MAX_GAIN, gain))
  return Math.round(gain * 10) / 10
}

// Analiza un archivo con loudnorm (1 pasada) y devuelve { inputI, inputTp, gainDb }
// o null si no se pudo medir. loudnorm imprime un bloque JSON al final del stderr.
export function analyzeFile(filePath) {
  return new Promise((resolve) => {
    let ff
    try {
      ff = spawn(FFMPEG, [
        '-hide_banner', '-nostats', '-i', filePath,
        '-af', `loudnorm=I=${TARGET_I}:TP=${TP_CEIL}:LRA=11:print_format=json`,
        '-f', 'null', '-',
      ])
    } catch { return resolve(null) }
    let err = ''
    ff.stderr.on('data', d => { err += d.toString() })
    ff.on('error', () => resolve(null))
    ff.on('close', () => {
      const m = err.match(/\{[\s\S]*\}/) // el bloque JSON de loudnorm
      if (!m) return resolve(null)
      try {
        const j = JSON.parse(m[0])
        const inputI = parseFloat(j.input_i)
        const inputTp = parseFloat(j.input_tp)
        resolve({ inputI, inputTp, gainDb: computeGain(inputI, inputTp) })
      } catch { resolve(null) }
    })
  })
}

// Duración de un archivo de audio en milisegundos, o null si no se pudo medir.
// Usa `ffmpeg -i` (sin salida): imprime "Duration: HH:MM:SS.ss" en stderr y sale
// con error (no hay output), por eso parseamos stderr sin importar el código.
export function probeDurationMs(filePath) {
  return new Promise((resolve) => {
    let ff
    try { ff = spawn(FFMPEG, ['-hide_banner', '-i', filePath]) }
    catch { return resolve(null) }
    let err = ''
    ff.stderr.on('data', d => { err += d.toString() })
    ff.on('error', () => resolve(null))
    ff.on('close', () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
      if (!m) return resolve(null)
      const ms = (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000
      resolve(Number.isFinite(ms) ? Math.round(ms) : null)
    })
  })
}

// Ganancia efectiva a aplicar al reproducir: medida + ajuste manual del admin.
export function effectiveGain(sound) {
  const base = sound && sound.gain_db != null ? Number(sound.gain_db) : 0
  const off = sound && sound.gain_offset_db != null ? Number(sound.gain_offset_db) : 0
  const g = base + off
  return Number.isFinite(g) ? Math.round(g * 10) / 10 : 0
}
