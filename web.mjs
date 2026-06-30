// web.mjs — Proceso web separado del bot. Maneja identidad y datos:
// login OAuth de Discord, sesiones, subida de sonidos, playlists e historial.
// Comparte la DB y el object-store con bot.mjs a través de lib/.
// Corre en su propio puerto (WEB_PORT). El control en vivo (play/skip/sonidos)
// sigue en bot.mjs.
import http from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'

const ROOT = dirname(fileURLToPath(import.meta.url))
try { process.loadEnvFile(join(ROOT, '.env')) } catch { /* las vars pueden venir del entorno */ }

const { getDb } = await import('./lib/db.mjs')
const auth = await import('./lib/auth.mjs')
const rbac = await import('./lib/rbac.mjs')
const sounds = await import('./lib/sounds.mjs')
const folders = await import('./lib/folders.mjs')
const playlists = await import('./lib/playlists.mjs')
const playHistory = await import('./lib/history.mjs')
const music = await import('./lib/music-cache.mjs')
const artStore = await import('./lib/art.mjs')
const artsearch = await import('./lib/artsearch.mjs')
const { getStore } = await import('./lib/storage/index.mjs')
const loudness = await import('./lib/loudness.mjs')
const { paths } = await import('./lib/config.mjs')

const PORT = Number(process.env.WEB_PORT || 8770)
const ART_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }
const SOUND_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', webm: 'audio/webm' }
const CLIENT_ID = process.env.DISCORD_CLIENT_ID
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`
// Orígenes del panel autorizados (CORS + retorno OAuth). Lista por coma en Pages.
const PANEL_ORIGINS = new Set((process.env.PANEL_ORIGIN || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean))
const VALID_ROLES = new Set(['admin', 'dj', 'user', 'guest'])
const SOUND_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'webm'])
const MAX_UPLOAD = 10 * 1024 * 1024 // 10 MB por sonido
const MUSIC_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'webm', 'opus'])
const MAX_MUSIC = 50 * 1024 * 1024 // 50 MB por canción

// Worker de música (CX33): guarda y sirve audio/carátulas. La web proxea la
// carátula desde el worker y le avisa de borrados/permanencia. Cliente compartido
// con bot.mjs en lib/worker-client.mjs. Sin MUSIC_WORKER_URL, USE_WORKER es false
// y todo sigue saliendo del object-store local como antes.
const { USE_WORKER, workerReq, workerMeta, workerKeep, workerDelete, workerCachedKeys } = await import('./lib/worker-client.mjs')
// Misma clave que el worker (sha1 de la fuente) para cruzar la biblioteca con lo
// que el worker tiene cacheado.
const sha1 = s => createHash('sha1').update(s).digest('hex')

getDb() // dispara migraciones

// Progreso de la normalización de volumen lanzada desde el panel (en memoria).
let normProgress = { running: false, done: 0, total: 0 }

// ── Utilidades HTTP ─────────────────────────────────────────────────────────
function parseCookies(req) {
  const out = {}
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

// En Pages el panel y la API viven en subdominios distintos de aronne.dev. La
// cookie se comparte poniendo Domain=.aronne.dev (COOKIE_DOMAIN) y, al ir por
// HTTPS cross-site, debe ser SameSite=None; Secure. En dev (localhost, http) se
// deja SameSite=Lax sin Secure. Configurable por env para no romper dev.
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || ''           // ej: .aronne.dev
const COOKIE_CROSS_SITE = process.env.COOKIE_CROSS_SITE === '1' // None;Secure
// Prefijo para diferenciar entornos que comparten Domain=.aronne.dev (test vs
// prod). Sin prefijo la cookie de un entorno pisa la del otro (mismo nombre y
// dominio) y obliga a re-loguearse al saltar entre subdominios. Test usa
// COOKIE_PREFIX=test_ ; prod lo deja vacío (cookie `sid`). bot.mjs usa el mismo.
const COOKIE_PREFIX = process.env.COOKIE_PREFIX || ''
const SID_COOKIE = COOKIE_PREFIX + 'sid'
const OAUTH_STATE_COOKIE = COOKIE_PREFIX + 'oauth_state'
const OAUTH_RETURN_COOKIE = COOKIE_PREFIX + 'oauth_return'
function setCookie(res, name, value, { maxAge, clear } = {}) {
  const sameSite = COOKIE_CROSS_SITE ? 'None' : 'Lax'
  const attrs = [`${name}=${clear ? '' : encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`]
  if (COOKIE_CROSS_SITE) attrs.push('Secure')
  if (COOKIE_DOMAIN) attrs.push(`Domain=${COOKIE_DOMAIN}`)
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

// Tope de duración (segundos) para subir sonidos. Lo configura el admin desde el
// panel (Variables Generales) y lo guarda bot.mjs en settings.json (FS compartido,
// mismo ROOT). Se lee en cada subida para tomar el valor vigente. Default 40 s.
const SETTINGS_FILE = join(ROOT, 'settings.json')
function maxSoundSeconds() {
  try {
    const v = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')).maxSoundSeconds
    if (Number.isFinite(v) && v > 0) return v
  } catch { /* sin archivo aún o ilegible → default */ }
  return 40
}

// Mide la duración del audio subido escribiéndolo a un temporal y sondeándolo con
// ffmpeg. Devuelve { ok, durationMs }. Si no se pudo medir, NO bloquea (ok=true,
// durationMs=null) para no rechazar formatos raros por un fallo de sondeo.
async function checkSoundDuration(buffer, ext) {
  const tmp = join(paths.tmp, `up_${randomBytes(8).toString('hex')}.${ext}`)
  try {
    writeFileSync(tmp, buffer)
    const durationMs = await loudness.probeDurationMs(tmp)
    if (durationMs == null) return { ok: true, durationMs: null }
    const maxMs = maxSoundSeconds() * 1000
    return { ok: durationMs <= maxMs, durationMs, maxSeconds: maxSoundSeconds() }
  } finally {
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
  }
}

function currentUser(req) {
  const token = parseCookies(req)[SID_COOKIE]
  return token ? auth.getSession(token) : null
}

// ── OAuth de Discord ────────────────────────────────────────────────────────
// Solo se permite volver a destinos en la allowlist (evita open redirect):
// hosts locales (dev) o los orígenes del panel configurados (Pages).
function isSafeReturn(ret) {
  if (/^https?:\/\/(localhost|127\.0\.0\.1):\d+(\/|$)/.test(ret)) return true
  for (const o of PANEL_ORIGINS) if (ret === o || ret.startsWith(o + '/')) return true
  return false
}
function authLoginRedirect(req, res, url) {
  if (!CLIENT_ID) return send(res, 500, { error: 'Falta DISCORD_CLIENT_ID en el entorno' })
  const state = randomBytes(16).toString('hex')
  setCookie(res, OAUTH_STATE_COOKIE, state, { maxAge: 600 })
  // Guarda a dónde volver tras el login (p.ej. el panel del bot en otro puerto).
  const ret = url.searchParams.get('return')
  if (ret && isSafeReturn(ret)) setCookie(res, OAUTH_RETURN_COOKIE, ret, { maxAge: 600 })
  const authUrl = 'https://discord.com/oauth2/authorize?' + new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: 'identify',
    state,
    redirect_uri: REDIRECT_URI,
  })
  res.writeHead(302, { Location: authUrl })
  res.end()
}

async function authCallback(req, res, url) {
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const cookies = parseCookies(req)
  if (!code || !state || state !== cookies[OAUTH_STATE_COOKIE]) {
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
  setCookie(res, SID_COOKIE, token, { maxAge: 30 * 24 * 60 * 60 })
  setCookie(res, OAUTH_STATE_COOKIE, '', { clear: true })
  // Vuelve al destino guardado (panel del bot) si es seguro; si no, a la home.
  const ret = cookies[OAUTH_RETURN_COOKIE]
  const dest = ret && isSafeReturn(ret) ? ret : '/'
  setCookie(res, OAUTH_RETURN_COOKIE, '', { clear: true })
  res.writeHead(302, { Location: dest })
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
  // CORS: en dev el panel lo sirve bot.mjs (otro puerto localhost); en Pages vive
  // en panel-test.aronne.dev (PANEL_ORIGIN). Ambos llaman con credenciales.
  const origin = req.headers.origin
  if (origin && (PANEL_ORIGINS.has(origin.replace(/\/$/, '')) || /^https?:\/\/localhost:\d+$/.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Guild-Id')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname

  try {
    // Rutas públicas
    if (req.method === 'GET' && path === '/') return landing(res, currentUser(req))
    // Carátula de una canción (imagen pública, servida desde el object-store).
    const mArt = path.match(/^\/art\/(\d+)$/)
    if (mArt && req.method === 'GET') {
      const song = music.getById(Number(mArt[1]))
      if (!song) { res.writeHead(404); res.end('Sin carátula'); return }
      const store = getStore()
      // PRIORIDAD: la carátula elegida/resuelta (art_key en object-store) manda. Solo
      // si no hay art_key se cae a la miniatura del worker (YouTube) como fallback.
      // exists/getStream son sync en local-store y async en s3-store; await unifica ambos.
      if (song.art_key && await store.exists(song.art_key)) {
        const ext = song.art_key.split('.').pop().toLowerCase()
        // no-store: la carátula elegida puede cambiar; es un archivo local barato de
        // re-servir. Así un refresco SIEMPRE muestra la actual (no la cacheada vieja).
        res.writeHead(200, { 'Content-Type': ART_MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' })
        ;(await store.getStream(song.art_key)).pipe(res)
        return
      }
      // Sin art_key: miniatura del worker (la baja la 1ª vez). Uploads (upload:) no van al worker.
      if (USE_WORKER && /^https?:\/\//i.test(song.source_url)) {
        try {
          const r = await workerReq('GET', '/art', song.source_url)
          if (r.ok && r.body) {
            // Miniatura del worker (fallback transitorio hasta que el bot resuelva
            // art_key): caché corto para que no quede "pegada" la vieja por un día.
            res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'public, max-age=300' })
            Readable.fromWeb(r.body).pipe(res)
            return
          }
        } catch { /* nada */ }
      }
      res.writeHead(404); res.end('Sin carátula'); return
    }
    if (req.method === 'GET' && path === '/auth/login') return authLoginRedirect(req, res, url)
    if (req.method === 'GET' && path === '/auth/callback') return await authCallback(req, res, url)
    if (req.method === 'POST' && path === '/auth/logout') {
      const token = parseCookies(req)[SID_COOKIE]
      if (token) auth.deleteSession(token)
      setCookie(res, SID_COOKIE, '', { clear: true })
      res.writeHead(302, { Location: '/' })
      res.end()
      return
    }

    // A partir de aquí se requiere sesión
    const user = currentUser(req)
    if (!user) return send(res, 401, { error: 'No autenticado' })
    // Servidor activo (multiservidor): para los chequeos de admin POR SERVIDOR y
    // para etiquetar lo que se crea. NULL = transversal / global.
    const guildId = req.headers['x-guild-id'] || url.searchParams.get('g') || null

    if (req.method === 'GET' && path === '/api/me') {
      return send(res, 200, {
        id: user.id, username: user.username, displayName: user.display_name,
        avatarUrl: user.avatar_url, roles: rbac.getUserRoleNames(user.id, guildId),
        isSuper: rbac.isSuper(user.id),
      })
    }

    if (req.method === 'GET' && path === '/api/sounds') {
      const admin = rbac.isAdmin(user.id, guildId)
      return send(res, 200, sounds.tree(
        sounds.listForUser(user.id), folders.listFor(user.id, admin),
        folders.aliasesForUser(user.id), folders.meta(), user.id))
    }

    // Audio crudo de un sonido (para el recortador en el navegador). Requiere
    // poder ver el sonido (admin o canSeeSound).
    const mSndAudio = path.match(/^\/api\/sound-audio\/(\d+)$/)
    if (mSndAudio && req.method === 'GET') {
      const s = sounds.getById(Number(mSndAudio[1]))
      if (!s) return send(res, 404, { error: 'Sonido no encontrado' })
      if (!rbac.isAdmin(user.id, guildId) && !rbac.canSeeSound(user.id, s)) return send(res, 403, { error: 'No disponible' })
      const store = getStore()
      if (!(await store.exists(s.object_key))) return send(res, 404, { error: 'Sin audio' })
      res.writeHead(200, { 'Content-Type': SOUND_MIME[s.ext] || 'application/octet-stream' })
      ;(await store.getStream(s.object_key)).pipe(res)
      return
    }

    // Carpetas del soundboard: listar (para el selector) y crear (botón dedicado).
    // Solo carpetas transversales o del servidor activo (guildId, declarado arriba).
    if (req.method === 'GET' && path === '/api/folders') {
      return send(res, 200, folders.list(guildId))
    }
    if (req.method === 'POST' && path === '/api/folders') {
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      const raw = body.parent ? `${body.parent}/${body.name || ''}` : (body.path || body.name || '')
      try {
        // Quien la crea es su dueño; elige color y público/privado; nace en su server.
        const path = folders.create(raw, {
          ownerUserId: user.id, color: body.color || null,
          visibility: body.visibility === 'private' ? 'private' : 'public',
          guildId,
        })
        return send(res, 201, { ok: true, path })
      } catch (e) {
        return send(res, 400, { error: e.message || 'No se pudo crear la carpeta' })
      }
    }

    // Cambiar color/visibilidad de una carpeta (dueño o admin).
    if (req.method === 'POST' && path === '/api/folder-props') {
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      if (!body.path) return send(res, 400, { error: 'Falta path' })
      try {
        folders.setProps(body.path, { color: body.color, visibility: body.visibility }, user.id, rbac.isAdmin(user.id, guildId))
        return send(res, 200, { ok: true })
      } catch (e) { return send(res, 400, { error: e.message }) }
    }

    // Subir sonido: cuerpo = bytes crudos; metadatos en el query
    if (req.method === 'POST' && path === '/api/sounds/upload') {
      const label = (url.searchParams.get('label') || '').trim()
      const ext = (url.searchParams.get('ext') || '').toLowerCase().trim()
      const folder = (url.searchParams.get('folder') || '').trim()
      let visibility = url.searchParams.get('visibility') === 'global' ? 'global' : 'private'
      if (!label) return send(res, 400, { error: 'Falta el nombre (label)' })
      if (!folder) return send(res, 400, { error: 'Debes elegir una carpeta (no se puede subir a la raíz)' })
      if (!SOUND_EXTS.has(ext)) return send(res, 400, { error: `Extensión no permitida: ${ext}` })
      // Cualquiera puede subir público o privado. Pero si la carpeta es privada,
      // el sonido queda privado (la carpeta gobierna su subárbol).
      if (folders.isPrivatePath(folder, folders.meta())) visibility = 'private'
      // El sonido nace ligado al servidor activo (guildId, declarado arriba).
      // NULL = transversal (single-server o sin selección) → visible en todos.
      const buffer = await readBody(req)
      if (!buffer.length) return send(res, 400, { error: 'Cuerpo vacío' })
      const dur = await checkSoundDuration(buffer, ext)
      if (!dur.ok) return send(res, 400, { error: `El sonido dura ${(dur.durationMs / 1000).toFixed(1)} s; el máximo es ${dur.maxSeconds} s. Recórtalo antes de subirlo.` })
      const s = await sounds.upload({ ownerUserId: user.id, label, folder, ext, buffer, durationMs: dur.durationMs, visibility, guildId })
      return send(res, 201, { id: s.id, label: s.label, folder: s.folder, visibility: s.visibility })
    }

    // Personalización del soundboard por usuario: renombrar (alias propio) y/o
    // ocultar un sonido solo para sí mismo. El cuerpo trae los campos a cambiar.
    if (req.method === 'POST' && path === '/api/sound-prefs') {
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      const soundId = Number(body.soundId)
      if (!soundId) return send(res, 400, { error: 'Falta soundId' })
      const snd = sounds.getById(soundId)
      // Solo se personaliza un sonido que el usuario realmente ve.
      if (!snd || !rbac.canSeeSound(user.id, snd)) return send(res, 404, { error: 'Sonido no disponible' })
      if (Object.prototype.hasOwnProperty.call(body, 'alias')) sounds.setAlias(user.id, soundId, body.alias)
      if (Object.prototype.hasOwnProperty.call(body, 'hidden')) sounds.setHidden(user.id, soundId, !!body.hidden)
      return send(res, 200, { ok: true })
    }

    // Mover un sonido a otra carpeta. Admin = global (cambia la carpeta real);
    // usuario normal = personal (solo cambia dónde lo ve él). No se permite la raíz.
    if (req.method === 'POST' && path === '/api/sound-move') {
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      const soundId = Number(body.soundId)
      const folder = folders.normalizePath(body.folder || '')
      if (!soundId) return send(res, 400, { error: 'Falta soundId' })
      if (!folder) return send(res, 400, { error: 'Carpeta inválida (no se puede mover a la raíz)' })
      const snd = sounds.getById(soundId)
      if (!snd || !rbac.canSeeSound(user.id, snd)) return send(res, 404, { error: 'Sonido no disponible' })
      if (rbac.isAdmin(user.id, guildId)) { folders.create(folder); sounds.moveSoundGlobal(soundId, folder) }
      else {
        // El usuario solo puede mover a una carpeta que él pueda ver (no privada ajena).
        if (!folders.accessibleTo(folder, user.id, false, folders.meta())) return send(res, 403, { error: 'Carpeta no disponible' })
        sounds.setSoundFolder(user.id, soundId, folder)
      }
      return send(res, 200, { ok: true })
    }

    // Renombrar una carpeta. Admin = global (afecta a todos); usuario = personal
    // (solo cambia el nombre que él ve; la ruta real no cambia).
    if (req.method === 'POST' && path === '/api/folder-rename') {
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      if (!body.path || !(body.name || '').trim()) return send(res, 400, { error: 'Falta path o name' })
      try {
        if (rbac.isAdmin(user.id, guildId)) return send(res, 200, { ok: true, path: folders.rename(body.path, body.name) })
        folders.setUserAlias(user.id, body.path, body.name)
        return send(res, 200, { ok: true, path: body.path })
      } catch (e) { return send(res, 400, { error: e.message }) }
    }

    if (req.method === 'POST' && path === '/api/folder-delete') {
      if (!rbac.isAdmin(user.id, guildId)) return send(res, 403, { error: 'Solo un administrador puede eliminar carpetas' })
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      if (!body.path) return send(res, 400, { error: 'Falta path' })
      try { folders.deleteFolder(body.path); return send(res, 200, { ok: true }) }
      catch (e) { return send(res, 400, { error: e.message }) }
    }

    // Gestión (solo admin): árbol completo de TODOS los sonidos (incl. ocultos)
    // para administrarlos junto a las carpetas.
    if (req.method === 'GET' && path === '/api/sound-admin') {
      if (!rbac.isAdmin(user.id, guildId)) return send(res, 403, { error: 'Solo un administrador' })
      // Super admin gestiona TODOS los servidores; admin por-servidor solo los
      // transversales + los de su servidor activo.
      const all = rbac.isSuper(user.id)
      return send(res, 200, { tree: sounds.tree(sounds.listAllForAdmin(guildId, all), all ? folders.list() : folders.list(guildId)) })
    }
    // Auditoría (solo admin): renombres por usuario + registro de subidas.
    if (req.method === 'GET' && path === '/api/sound-audit') {
      if (!rbac.isAdmin(user.id, guildId)) return send(res, 403, { error: 'Solo un administrador' })
      const all = rbac.isSuper(user.id)
      return send(res, 200, { renames: sounds.allAliases(guildId, all), uploads: sounds.allUploads(guildId, all) })
    }
    // Renombrar el nombre real de un sonido y/o cambiar su visibilidad
    // (público⇄privado). Afecta a todos. Solo admin.
    if (req.method === 'POST' && path === '/api/sound-admin/rename') {
      if (!rbac.isAdmin(user.id, guildId)) return send(res, 403, { error: 'Solo un administrador' })
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      if (!body.soundId || !(body.label || '').trim()) return send(res, 400, { error: 'Falta soundId o label' })
      try {
        const sid = Number(body.soundId)
        sounds.renameSound(sid, body.label)
        if (body.visibility === 'global' || body.visibility === 'private') sounds.setVisibility(sid, body.visibility)
        if (body.offsetDb !== undefined) sounds.setGainOffset(sid, Number(body.offsetDb) || 0)
        // Transversal: visible en TODOS los servidores (guild_id NULL). Al quitarlo,
        // queda ligado al servidor activo. Solo admin (gateo de arriba).
        if (body.transversal !== undefined) {
          const gid = req.headers['x-guild-id'] || url.searchParams.get('g') || null
          sounds.setGuild(sid, body.transversal ? null : gid)
        }
        return send(res, 200, { ok: true, sound: sounds.getById(sid) })
      } catch (e) { return send(res, 400, { error: e.message }) }
    }
    // Reemplazar el audio de un sonido (recortado en el navegador). Solo admin.
    if (req.method === 'POST' && path === '/api/sound-admin/replace-audio') {
      if (!rbac.isAdmin(user.id, guildId)) return send(res, 403, { error: 'Solo un administrador' })
      const id = Number(url.searchParams.get('id'))
      const ext = (url.searchParams.get('ext') || '').toLowerCase().trim()
      if (!id) return send(res, 400, { error: 'Falta id' })
      if (!SOUND_EXTS.has(ext)) return send(res, 400, { error: `Extensión no permitida: ${ext}` })
      const buffer = await readBody(req)
      if (!buffer.length) return send(res, 400, { error: 'Cuerpo vacío' })
      const dur = await checkSoundDuration(buffer, ext)
      if (!dur.ok) return send(res, 400, { error: `El sonido dura ${(dur.durationMs / 1000).toFixed(1)} s; el máximo es ${dur.maxSeconds} s.` })
      const s = await sounds.replaceAudio(id, ext, buffer)
      return send(res, 200, { ok: true, id: s.id })
    }
    // Renombrar una carpeta (afecta a todos). Solo admin.
    if (req.method === 'POST' && path === '/api/sound-admin/rename-folder') {
      if (!rbac.isAdmin(user.id, guildId)) return send(res, 403, { error: 'Solo un administrador' })
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      if (!body.path || !(body.name || '').trim()) return send(res, 400, { error: 'Falta path o name' })
      try { return send(res, 200, { ok: true, path: folders.rename(body.path, body.name) }) }
      catch (e) { return send(res, 400, { error: e.message }) }
    }
    // Ajuste MANUAL de volumen por sonido (se suma a la ganancia medida). Solo admin.
    if (req.method === 'POST' && path === '/api/sound-admin/gain') {
      if (!rbac.isAdmin(user.id, guildId)) return send(res, 403, { error: 'Solo un administrador' })
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      if (!body.soundId) return send(res, 400, { error: 'Falta soundId' })
      sounds.setGainOffset(Number(body.soundId), Number(body.offsetDb) || 0)
      return send(res, 200, { ok: true })
    }
    // Revisar/igualar el volumen de TODOS los sonidos (en segundo plano). Solo admin.
    // `force`: re-mide también los ya medidos. Devuelve el progreso para sondear.
    if (req.method === 'POST' && path === '/api/sound-admin/normalize-all') {
      if (!rbac.isAdmin(user.id, guildId)) return send(res, 403, { error: 'Solo un administrador' })
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      if (normProgress.running) return send(res, 200, { ...normProgress })
      normProgress = { running: true, done: 0, total: 0 }
      sounds.normalizeAll({ force: !!body.force, onProgress: (d, t) => { normProgress.done = d; normProgress.total = t } })
        .then(() => { normProgress.running = false })
        .catch(() => { normProgress.running = false })
      return send(res, 202, { started: true, ...normProgress })
    }
    if (req.method === 'GET' && path === '/api/sound-admin/normalize-progress') {
      if (!rbac.isAdmin(user.id, guildId)) return send(res, 403, { error: 'Solo un administrador' })
      return send(res, 200, normProgress)
    }
    // Ocultar/restaurar un sonido para TODOS (soft delete). Solo admin.
    if (req.method === 'POST' && path === '/api/sound-admin/hide') {
      if (!rbac.isAdmin(user.id, guildId)) return send(res, 403, { error: 'Solo un administrador' })
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      if (!body.soundId) return send(res, 400, { error: 'Falta soundId' })
      sounds.setGlobalHidden(Number(body.soundId), !!body.hidden)
      return send(res, 200, { ok: true })
    }
    // Eliminar un sonido de forma permanente: solo si ya estaba oculto. Solo admin.
    if (req.method === 'DELETE' && path === '/api/sound-admin/sound') {
      if (!rbac.isAdmin(user.id, guildId)) return send(res, 403, { error: 'Solo un administrador' })
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      const snd = body.soundId ? sounds.getById(Number(body.soundId)) : null
      if (!snd) return send(res, 404, { error: 'Sonido no encontrado' })
      if (!snd.hidden) return send(res, 400, { error: 'Primero oculta el sonido antes de eliminarlo' })
      await sounds.deleteSound(snd.id)
      return send(res, 200, { ok: true })
    }

    if (req.method === 'GET' && path === '/api/history') {
      const limit = Math.min(100, Number(url.searchParams.get('limit')) || 20)
      return send(res, 200, playHistory.recent({ userId: user.id, limit }))
    }

    // Estadísticas de sonidos para el panel de administración: últimas
    // reproducciones de todos (con quién) + ranking ajustable. Solo admin.
    if (req.method === 'GET' && path === '/api/sound-stats') {
      if (!rbac.isAdmin(user.id, guildId)) return send(res, 403, { error: 'Solo un administrador' })
      const top = Math.min(50, Math.max(1, Number(url.searchParams.get('top')) || 10))
      return send(res, 200, {
        recent: playHistory.recentDetailed({ limit: 20 }),
        top: playHistory.topSounds({ limit: top }),
      })
    }

    // Gestión de usuarios (solo admin): listar usuarios con sus roles y
    // asignar/quitar el rol admin.
    if (req.method === 'GET' && path === '/api/users') {
      if (!rbac.isAdmin(user.id)) return send(res, 403, { error: 'Solo un administrador' })
      return send(res, 200, { users: auth.listUsers(), me: user.id })
    }
    if (req.method === 'POST' && path === '/api/users/role') {
      if (!rbac.isAdmin(user.id)) return send(res, 403, { error: 'Solo un administrador' })
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      const targetId = Number(body.userId)
      const role = String(body.role || '')
      const grant = !!body.grant
      // Ámbito: guildId='<id>' (admin de ese servidor) | null (global). Asignar
      // admin (global o por-servidor) y tocar super requiere SER super.
      const scope = body.guildId ? String(body.guildId) : null
      if (!targetId || !VALID_ROLES.has(role)) return send(res, 400, { error: 'Datos inválidos' })
      if (role === 'admin' && !rbac.isSuper(user.id)) {
        return send(res, 403, { error: 'Solo un super administrador puede gestionar administradores' })
      }
      // No permitir quedarse sin ningún admin pleno (super o admin global).
      if (role === 'admin' && scope === null && !grant && auth.countAdmins() <= 1) {
        return send(res, 400, { error: 'No puedes quitar el último administrador' })
      }
      try {
        if (grant) auth.assignRole(targetId, role, scope)
        else auth.removeRole(targetId, role, scope)
      } catch (e) {
        return send(res, 400, { error: e.message || 'No se pudo actualizar el rol' })
      }
      return send(res, 200, { ok: true })
    }
    // Super administrador global (solo otro super puede otorgarlo/quitarlo).
    if (req.method === 'POST' && path === '/api/users/super') {
      if (!rbac.isSuper(user.id)) return send(res, 403, { error: 'Solo un super administrador' })
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      const targetId = Number(body.userId)
      const grant = !!body.grant
      if (!targetId) return send(res, 400, { error: 'Datos inválidos' })
      if (!grant && auth.countAdmins() <= 1) return send(res, 400, { error: 'No puedes quitar el último administrador' })
      auth.setSuper(targetId, grant)
      return send(res, 200, { ok: true })
    }

    // Playlists. Las listas son visibles para todos (con su autor); solo el dueño
    // (o un admin) puede modificarlas.
    if (path === '/api/playlists' && req.method === 'GET') {
      return send(res, 200, { playlists: playlists.listAllWithOwner(), me: user.id })
    }
    if (path === '/api/playlists' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      const name = (body.name || '').trim()
      if (!name) return send(res, 400, { error: 'Falta el nombre de la lista' })
      return send(res, 201, playlists.create(user.id, name, body.visibility))
    }
    const plItems = path.match(/^\/api\/playlists\/(\d+)\/items$/)
    if (plItems && (req.method === 'GET' || req.method === 'POST')) {
      const pl = playlists.get(Number(plItems[1]))
      if (!pl) return send(res, 404, { error: 'Lista no encontrada' })
      if (req.method === 'GET') return send(res, 200, playlists.items(pl.id))
      // Modificar = solo dueño o admin.
      if (pl.owner_user_id !== user.id && !rbac.isAdmin(user.id)) return send(res, 403, { error: 'No es tu lista' })
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      // Agregar varias de golpe (importar playlist).
      if (Array.isArray(body.songIds)) {
        const ids = body.songIds.map(Number).filter(Boolean)
        if (!ids.length) return send(res, 400, { error: 'Sin canciones que agregar' })
        for (const sid of ids) playlists.addItem(pl.id, sid)
        return send(res, 201, { ok: true, added: ids.length })
      }
      let songId = body.songId
      if (!songId && body.sourceUrl) songId = music.upsertSong({ sourceUrl: body.sourceUrl, title: body.title }).id
      if (!songId) return send(res, 400, { error: 'Falta songId o sourceUrl' })
      playlists.addItem(pl.id, Number(songId))
      return send(res, 201, { ok: true })
    }
    // Quitar una canción de la lista (solo dueño o admin).
    const plItemDel = path.match(/^\/api\/playlists\/(\d+)\/items\/(\d+)$/)
    if (plItemDel && req.method === 'DELETE') {
      const pl = playlists.get(Number(plItemDel[1]))
      if (!pl) return send(res, 404, { error: 'Lista no encontrada' })
      if (pl.owner_user_id !== user.id && !rbac.isAdmin(user.id)) return send(res, 403, { error: 'No es tu lista' })
      playlists.removeItem(Number(plItemDel[2]))
      return send(res, 200, { ok: true })
    }
    const plId = path.match(/^\/api\/playlists\/(\d+)$/)
    if (plId && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const pl = playlists.get(Number(plId[1]))
      if (!pl) return send(res, 404, { error: 'Lista no encontrada' })
      if (pl.owner_user_id !== user.id && !rbac.isAdmin(user.id)) return send(res, 403, { error: 'No es tu lista' })
      if (req.method === 'PATCH') {
        const body = JSON.parse((await readBody(req)).toString() || '{}')
        const name = (body.name || '').trim()
        if (!name) return send(res, 400, { error: 'Falta el nombre de la lista' })
        return send(res, 200, playlists.rename(pl.id, name))
      }
      playlists.remove(pl.id)
      return send(res, 200, { ok: true })
    }

    // ── Música / caché ────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/music') {
      const list = music.listAll()
      // location: 'local' (caché de Santiago) | 'worker' (lo tiene el worker) | 'none'.
      const wk = await workerCachedKeys()
      for (const s of list) {
        s.location = s.cached ? 'local'
          : (USE_WORKER && /^https?:/i.test(s.source_url || '') && wk.has(sha1(s.source_url))) ? 'worker'
          : 'none'
      }
      return send(res, 200, list)
    }
    // Subir una canción permanente (archivo de audio del usuario). Solo admin.
    if (req.method === 'POST' && path === '/api/music/upload') {
      if (!rbac.isAdmin(user.id)) return send(res, 403, { error: 'Solo un admin puede subir canciones permanentes' })
      const title = (url.searchParams.get('title') || '').trim()
      const artist = (url.searchParams.get('artist') || '').trim() || null
      const ext = (url.searchParams.get('ext') || '').toLowerCase().trim()
      if (!title) return send(res, 400, { error: 'Falta el título' })
      if (!MUSIC_EXTS.has(ext)) return send(res, 400, { error: `Extensión no permitida: ${ext}` })
      const buffer = await readBody(req, MAX_MUSIC)
      if (!buffer.length) return send(res, 400, { error: 'Cuerpo vacío' })
      const song = await music.uploadPermanent({ title, artist, ext, buffer })
      return send(res, 201, { id: song.id, title: song.title })
    }
    // Renombrar una canción (editar el título). Solo admin.
    const mRename = path.match(/^\/api\/music\/(\d+)\/rename$/)
    if (mRename && req.method === 'POST') {
      if (!rbac.isAdmin(user.id)) return send(res, 403, { error: 'Solo un admin' })
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      const title = (body.title || '').trim()
      if (!title) return send(res, 400, { error: 'Falta el título' })
      const song = music.setTitle(Number(mRename[1]), title)
      if (!song) return send(res, 404, { error: 'Canción no encontrada' })
      return send(res, 200, { id: song.id, title: song.title })
    }
    // Fijar/desfijar como permanente. Solo admin.
    const mPerm = path.match(/^\/api\/music\/(\d+)\/permanent$/)
    if (mPerm && req.method === 'POST') {
      if (!rbac.isAdmin(user.id)) return send(res, 403, { error: 'Solo un admin' })
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      const song = music.setPermanent(Number(mPerm[1]), !!body.permanent)
      if (!song) return send(res, 404, { error: 'Canción no encontrada' })
      // El worker no debe evictar las permanentes de su disco.
      if (USE_WORKER && /^https?:\/\//i.test(song.source_url)) workerKeep(song.source_url, song.permanent)
      return send(res, 200, { id: song.id, permanent: song.permanent })
    }
    // Botón ✏️: busca la carátula en iTunes → Deezer → álbum (album-art) → arte
    // embebido (music-metadata) → miniatura de YouTube, y la fija. Solo admin.
    const mArtSearch = path.match(/^\/api\/music\/(\d+)\/art-search$/)
    if (mArtSearch && req.method === 'POST') {
      if (!rbac.isAdmin(user.id)) return send(res, 403, { error: 'Solo un admin' })
      const song = music.getById(Number(mArtSearch[1]))
      if (!song) return send(res, 404, { error: 'Canción no encontrada' })
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      const query = (body.query || '').trim() || null
      let localFile = null
      try { localFile = music.cachePath(song) } catch {}
      const thumbFallback = async () => {
        if (!USE_WORKER || !/^https?:\/\//i.test(song.source_url)) return null
        try {
          const r = await workerReq('GET', '/art', song.source_url)
          if (!r.ok) return null
          const buf = Buffer.from(await r.arrayBuffer())
          const ct = (r.headers.get('content-type') || '').toLowerCase()
          return buf.length ? { buf, ext: ct.includes('png') ? 'png' : 'jpg' } : null
        } catch { return null }
      }
      const r = await artsearch.resolveArt(song, { manual: true, query, localFile, thumbFallback })
      if (!r) return send(res, 404, { error: 'No se encontró carátula en ninguna fuente' })
      await artStore.store(song.id, r.buf, r.ext)
      return send(res, 200, { ok: true, id: song.id, ext: r.ext })
    }
    // Modal de carátula: lista candidatas de TODAS las fuentes para que el admin elija.
    const mArtOptions = path.match(/^\/api\/music\/(\d+)\/art-options$/)
    if (mArtOptions && req.method === 'POST') {
      if (!rbac.isAdmin(user.id)) return send(res, 403, { error: 'Solo un admin' })
      const song = music.getById(Number(mArtOptions[1]))
      if (!song) return send(res, 404, { error: 'Canción no encontrada' })
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      const query = (body.query || '').trim() || null
      let localFile = null
      try { localFile = music.cachePath(song) } catch {}
      const options = await artsearch.searchAllOptions(song, { query, localFile })
      // Añadir la miniatura "de siempre" (YouTube) como una opción más.
      if (USE_WORKER && /^https?:\/\//i.test(song.source_url)) {
        try {
          const m = await workerMeta(song.source_url)
          if (m.thumbnail) options.push({ source: 'YouTube', url: m.thumbnail, label: 'miniatura del video' })
        } catch {}
      }
      return send(res, 200, { options })
    }
    // Modal de carátula: fija la carátula elegida (URL http o data:base64).
    const mArtSet = path.match(/^\/api\/music\/(\d+)\/art-set$/)
    if (mArtSet && req.method === 'POST') {
      if (!rbac.isAdmin(user.id)) return send(res, 403, { error: 'Solo un admin' })
      const song = music.getById(Number(mArtSet[1]))
      if (!song) return send(res, 404, { error: 'Canción no encontrada' })
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      const url = (body.url || '').trim()
      if (!url) return send(res, 400, { error: 'Falta la imagen' })
      let buf = null, ext = 'jpg'
      const dm = url.match(/^data:image\/(\w+);base64,(.+)$/)
      if (dm) { ext = dm[1] === 'png' ? 'png' : dm[1] === 'webp' ? 'webp' : 'jpg'; buf = Buffer.from(dm[2], 'base64') }
      else { const img = await artsearch.fetchImg(url); if (img) { buf = img.buf; ext = img.ext } }
      if (!buf || !buf.length) return send(res, 400, { error: 'No se pudo obtener la imagen' })
      await artStore.store(song.id, buf, ext)
      return send(res, 200, { ok: true, id: song.id, ext })
    }
    // Borrar una canción (caché + object-store + fila). Solo admin.
    const mId = path.match(/^\/api\/music\/(\d+)$/)
    if (mId && req.method === 'DELETE') {
      if (!rbac.isAdmin(user.id)) return send(res, 403, { error: 'Solo un admin' })
      const song = music.getById(Number(mId[1])) // capturar source_url antes de borrar la fila
      const ok = await music.removeSong(Number(mId[1]))
      // Borra también la copia del disco del worker.
      if (ok && USE_WORKER && song && /^https?:\/\//i.test(song.source_url)) workerDelete(song.source_url)
      return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Canción no encontrada' })
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
