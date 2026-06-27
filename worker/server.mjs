// music-worker — extractor + transmisor de música para el plan de audio en dos
// nodos (Opción A(ii)). Corre en el CX33 (Alemania) dentro de un contenedor.
// El bot de Santiago abre GET /audio?url=...&seek=... y enchufa la respuesta a
// su mixer. Aquí se hace TODO lo pesado: yt-dlp (resuelve el nsig de YouTube con
// un runtime JS) + ffmpeg. NUNCA habla con Discord.
import http from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const PORT = +(process.env.PORT || 8080)
const TOKEN = process.env.WORKER_TOKEN || ''
const COOKIES = process.env.COOKIES_FILE || '/cookies.txt'
const YTDLP = process.env.YTDLP || '/usr/local/bin/yt-dlp'
const FFMPEG = process.env.FFMPEG || 'ffmpeg'
const NODE = process.execPath
// opus (Ogg/Opus, ~160 kbps, liviano en el cable transatlántico) | pcm (s16le crudo)
const FORMAT = (process.env.AUDIO_FORMAT || 'opus').toLowerCase()

function ytdlpArgs(extra) {
  // Mismos runtimes JS que el bot: node resuelve el desafío de firma de YouTube.
  const a = ['--no-playlist', '--quiet', '--no-warnings', '--js-runtimes', `node:${NODE}`]
  if (existsSync(COOKIES)) a.push('--cookies', COOKIES)
  return a.concat(extra)
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')

  if (u.pathname === '/healthz') { res.writeHead(200); return res.end('ok') }
  if (u.pathname !== '/audio') { res.writeHead(404); return res.end('not found') }

  // Auth: token Bearer obligatorio (el endpoint es público vía HTTPS).
  const auth = req.headers.authorization || ''
  if (!TOKEN || auth !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end('unauthorized') }

  const src = u.searchParams.get('url')
  if (!src) { res.writeHead(400); return res.end('missing url') }
  const seek = Math.max(0, parseInt(u.searchParams.get('seek') || '0', 10) || 0)

  const yt = spawn(YTDLP, ytdlpArgs(['-f', 'bestaudio/best', '-o', '-', src]))
  const ffArgs = ['-loglevel', 'error', '-i', 'pipe:0']
  if (seek > 0) ffArgs.push('-ss', String(seek))
  ffArgs.push('-vn', '-ar', '48000', '-ac', '2')
  if (FORMAT === 'pcm') ffArgs.push('-f', 's16le', 'pipe:1')
  else ffArgs.push('-c:a', 'libopus', '-b:a', '160k', '-f', 'ogg', 'pipe:1')
  const ff = spawn(FFMPEG, ffArgs)

  res.writeHead(200, {
    'Content-Type': FORMAT === 'pcm' ? 'audio/L16;rate=48000;channels=2' : 'audio/ogg',
    'Cache-Control': 'no-store',
    'X-Audio-Format': FORMAT,
  })

  yt.stdout.pipe(ff.stdin)
  ff.stdout.pipe(res)
  yt.stdout.on('error', () => {})
  ff.stdin.on('error', () => {})

  let ytErr = ''
  yt.stderr.on('data', d => { if (ytErr.length < 2000) ytErr += d })
  ff.stderr.on('data', d => process.stderr.write(d))

  let done = false
  const cleanup = () => { if (done) return; done = true; try { yt.kill('SIGKILL') } catch {} try { ff.kill('SIGKILL') } catch {} }
  req.on('close', cleanup)
  res.on('close', cleanup)

  yt.on('error', e => { console.error('yt-dlp:', e.message); try { res.destroy() } catch {} })
  ff.on('error', e => { console.error('ffmpeg:', e.message); try { res.destroy() } catch {} })
  yt.on('close', code => { if (code && code !== 0 && !done) console.error('yt-dlp exit', code, ytErr.slice(0, 400)) })
  ff.on('close', () => { try { res.end() } catch {} })
})

server.listen(PORT, () => console.log(`music-worker escuchando en :${PORT} (formato=${FORMAT})`))
