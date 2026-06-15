// web.mjs — Proceso web separado del bot. Maneja identidad y datos:
// login OAuth de Discord, sesiones, subida de sonidos, playlists e historial.
// Comparte la DB y el object-store con bot.mjs a través de lib/.
// Corre en su propio puerto (WEB_PORT). El control en vivo (play/skip/sonidos)
// sigue en bot.mjs.
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
try { process.loadEnvFile(join(ROOT, '.env')) } catch { /* las vars pueden venir del entorno */ }

const { getDb } = await import('./lib/db.mjs')
const auth = await import('./lib/auth.mjs')
const rbac = await import('./lib/rbac.mjs')
const sounds = await import('./lib/sounds.mjs')
const playlists = await import('./lib/playlists.mjs')
const playHistory = await import('./lib/history.mjs')
const music = await import('./lib/music-cache.mjs')

const PORT = Number(process.env.WEB_PORT || 8770)
const CLIENT_ID = process.env.DISCORD_CLIENT_ID
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`
const SOUND_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'webm'])
const MAX_UPLOAD = 10 * 1024 * 1024 // 10 MB por sonido

getDb() // dispara migraciones

// ── Utilidades HTTP ─────────────────────────────────────────────────────────
function parseCookies(req) {
  const out = {}
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function setCookie(res, name, value, { maxAge, clear } = {}) {
  const attrs = [`${name}=${clear ? '' : encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
  if (clear) attrs.push('Max-Age=0')
  else if (maxAge) attrs.push(`Max-Age=${maxAge}`)
  const prev = res.getHeader('Set-Cookie')
  res.setHeader('Set-Cookie', prev ? [].concat(prev, attrs.join('; ')) : attrs.join('; '))
}

function readBody(req, limit = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > limit) { reject(new Error('Archivo demasiado grande')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const send = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function currentUser(req) {
  const token = parseCookies(req).sid
  return token ? auth.getSession(token) : null
}

// ── OAuth de Discord ────────────────────────────────────────────────────────
function authLoginRedirect(res) {
  if (!CLIENT_ID) return send(res, 500, { error: 'Falta DISCORD_CLIENT_ID en el entorno' })
  const state = randomBytes(16).toString('hex')
  setCookie(res, 'oauth_state', state, { maxAge: 600 })
  const url = 'https://discord.com/oauth2/authorize?' + new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: 'identify',
    state,
    redirect_uri: REDIRECT_URI,
  })
  res.writeHead(302, { Location: url })
  res.end()
}

async function authCallback(req, res, url) {
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const cookies = parseCookies(req)
  if (!code || !state || state !== cookies.oauth_state) {
    return send(res, 400, { error: 'Estado OAuth inválido' })
  }
  // Intercambiar el código por un token
  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  })
  if (!tokenRes.ok) return send(res, 502, { error: 'No se pudo canjear el código con Discord' })
  const { access_token } = await tokenRes.json()

  // Obtener el perfil
  const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${access_token}` },
  })
  if (!userRes.ok) return send(res, 502, { error: 'No se pudo leer el perfil de Discord' })
  const d = await userRes.json()
  const avatarUrl = d.avatar ? `https://cdn.discordapp.com/avatars/${d.id}/${d.avatar}.png` : null

  // Alta/actualización + rol por defecto (el primer usuario del sistema es admin)
  const db = getDb()
  const wasNew = !db.prepare('SELECT 1 FROM users WHERE discord_id = ?').get(d.id)
  const totalBefore = db.prepare('SELECT COUNT(*) AS c FROM users').get().c
  const user = auth.upsertUserByDiscord({
    discordId: d.id,
    username: d.username,
    displayName: d.global_name || d.username,
    avatarUrl,
  })
  if (wasNew) auth.assignRole(user.id, totalBefore === 0 ? 'admin' : 'user')

  const token = auth.createSession(user.id)
  setCookie(res, 'sid', token, { maxAge: 30 * 24 * 60 * 60 })
  setCookie(res, 'oauth_state', '', { clear: true })
  res.writeHead(302, { Location: '/' })
  res.end()
}

// ── Páginas ─────────────────────────────────────────────────────────────────
function landing(res, user) {
  const roles = user ? rbac.getUserRoleNames(user.id) : []
  const body = user
    ? `<p>Sesión iniciada como <b>${escapeHtml(user.display_name || user.username)}</b> (roles: ${roles.join(', ') || 'ninguno'}).</p>
       <p><a href="/api/me">/api/me</a> · <a href="/api/sounds">/api/sounds</a> · <a href="/api/history">/api/history</a> · <a href="/api/playlists">/api/playlists</a></p>
       <form method="POST" action="/auth/logout"><button>Cerrar sesión</button></form>`
    : `<p>No has iniciado sesión.</p><p><a href="/auth/login">Entrar con Discord</a></p>`
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html lang="es"><meta charset="utf-8"><title>Panel — web.mjs</title>
    <body style="font-family:system-ui;background:#1e1f22;color:#f2f3f5;padding:40px;max-width:720px;margin:auto">
    <h1>web.mjs (dev)</h1>${body}</body></html>`)
}

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// ── Servidor ──────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  // CORS para el panel servido por bot.mjs en dev (mismo host, otro puerto)
  const origin = req.headers.origin
  if (origin && /^http:\/\/localhost:\d+$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname

  try {
    // Rutas públicas
    if (req.method === 'GET' && path === '/') return landing(res, currentUser(req))
    if (req.method === 'GET' && path === '/auth/login') return authLoginRedirect(res)
    if (req.method === 'GET' && path === '/auth/callback') return await authCallback(req, res, url)
    if (req.method === 'POST' && path === '/auth/logout') {
      const token = parseCookies(req).sid
      if (token) auth.deleteSession(token)
      setCookie(res, 'sid', '', { clear: true })
      res.writeHead(302, { Location: '/' })
      res.end()
      return
    }

    // A partir de aquí se requiere sesión
    const user = currentUser(req)
    if (!user) return send(res, 401, { error: 'No autenticado' })

    if (req.method === 'GET' && path === '/api/me') {
      return send(res, 200, {
        id: user.id, username: user.username, displayName: user.display_name,
        avatarUrl: user.avatar_url, roles: rbac.getUserRoleNames(user.id),
      })
    }

    if (req.method === 'GET' && path === '/api/sounds') {
      return send(res, 200, sounds.tree(sounds.listForUser(user.id)))
    }

    // Subir sonido: cuerpo = bytes crudos; metadatos en el query
    if (req.method === 'POST' && path === '/api/sounds/upload') {
      const label = (url.searchParams.get('label') || '').trim()
      const ext = (url.searchParams.get('ext') || '').toLowerCase().trim()
      const folder = (url.searchParams.get('folder') || '').trim()
      const visibility = url.searchParams.get('visibility') === 'global' ? 'global' : 'private'
      if (!label) return send(res, 400, { error: 'Falta el nombre (label)' })
      if (!SOUND_EXTS.has(ext)) return send(res, 400, { error: `Extensión no permitida: ${ext}` })
      if (visibility === 'global' && !rbac.isAdmin(user.id)) return send(res, 403, { error: 'Solo un admin puede subir sonidos globales' })
      const buffer = await readBody(req)
      if (!buffer.length) return send(res, 400, { error: 'Cuerpo vacío' })
      const s = await sounds.upload({ ownerUserId: user.id, label, folder, ext, buffer, visibility })
      return send(res, 201, { id: s.id, label: s.label, folder: s.folder, visibility: s.visibility })
    }

    if (req.method === 'GET' && path === '/api/history') {
      const limit = Math.min(100, Number(url.searchParams.get('limit')) || 20)
      return send(res, 200, playHistory.recent({ userId: user.id, limit }))
    }

    // Playlists
    if (path === '/api/playlists' && req.method === 'GET') {
      return send(res, 200, playlists.listForUser(user.id))
    }
    if (path === '/api/playlists' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      if (!body.name) return send(res, 400, { error: 'Falta el nombre de la lista' })
      return send(res, 201, playlists.create(user.id, body.name, body.visibility))
    }
    const plItems = path.match(/^\/api\/playlists\/(\d+)\/items$/)
    if (plItems && (req.method === 'GET' || req.method === 'POST')) {
      const pl = playlists.get(Number(plItems[1]))
      if (!pl || pl.owner_user_id !== user.id) return send(res, 404, { error: 'Lista no encontrada' })
      if (req.method === 'GET') return send(res, 200, playlists.items(pl.id))
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      let songId = body.songId
      if (!songId && body.sourceUrl) songId = music.upsertSong({ sourceUrl: body.sourceUrl, title: body.title }).id
      if (!songId) return send(res, 400, { error: 'Falta songId o sourceUrl' })
      playlists.addItem(pl.id, songId)
      return send(res, 201, { ok: true })
    }
    const plId = path.match(/^\/api\/playlists\/(\d+)$/)
    if (plId && req.method === 'DELETE') {
      const pl = playlists.get(Number(plId[1]))
      if (!pl || pl.owner_user_id !== user.id) return send(res, 404, { error: 'Lista no encontrada' })
      playlists.remove(pl.id)
      return send(res, 200, { ok: true })
    }

    send(res, 404, { error: 'No encontrado' })
  } catch (err) {
    send(res, 500, { error: err.message })
  }
}).listen(PORT, () => {
  console.log(`web.mjs escuchando en http://localhost:${PORT}`)
  console.log(`Login: http://localhost:${PORT}/auth/login  (redirect: ${REDIRECT_URI})`)
  if (!CLIENT_ID || !CLIENT_SECRET) console.warn('⚠️  Faltan DISCORD_CLIENT_ID/SECRET: el login fallará')
})
