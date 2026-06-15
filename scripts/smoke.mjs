// Prueba end-to-end de la capa de almacenamiento contra el stand-in local.
// Usa una DB y un object-store temporales para no tocar los reales.
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Configurar entorno ANTES de importar los módulos (leen config al cargar).
const base = mkdtempSync(join(tmpdir(), 'botsmoke-'))
process.env.DATA_DIR = join(base, 'data')
process.env.OBJECT_STORE_DIR = join(base, 'object-store')
process.env.STORAGE_BACKEND = 'local'
process.env.CACHE_PLAY_THRESHOLD = '3'
process.env.MUSIC_CACHE_MAX_BYTES = '1500' // diminuto para forzar LRU

const { getDb } = await import('../lib/db.mjs')
const sounds = await import('../lib/sounds.mjs')
const music = await import('../lib/music-cache.mjs')
const art = await import('../lib/art.mjs')
const auth = await import('../lib/auth.mjs')
const rbac = await import('../lib/rbac.mjs')
const history = await import('../lib/history.mjs')
const playlists = await import('../lib/playlists.mjs')
const { paths } = await import('../lib/config.mjs')
const { writeFileSync: wf } = await import('node:fs')

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.error(`  ✗ ${msg}`) } }

console.log(`\nTemp: ${base}\n`)
getDb() // dispara migraciones

console.log('— Migraciones y roles —')
const roles = getDb().prepare('SELECT name FROM roles ORDER BY name').all().map(r => r.name)
ok(JSON.stringify(roles) === JSON.stringify(['admin', 'dj', 'guest', 'user']), 'roles sembrados: ' + roles.join(','))

console.log('\n— Usuarios y sesiones —')
const alice = auth.upsertUserByDiscord({ discordId: '111', username: 'alice' })
const bob = auth.upsertUserByDiscord({ discordId: '222', username: 'bob' })
auth.assignRole(alice.id, 'admin')
auth.assignRole(bob.id, 'guest')
ok(rbac.isAdmin(alice.id) && !rbac.isAdmin(bob.id), 'roles asignados (alice admin, bob guest)')
const token = auth.createSession(bob.id)
ok(auth.getSession(token)?.id === bob.id, 'sesión válida resuelve al usuario')

console.log('\n— Sonidos: upload + espejo local + respaldo —')
const s1 = await sounds.upload({ label: 'risa', folder: 'Memes', ext: 'mp3', buffer: Buffer.from('FAKE-AUDIO') })
const s2 = await sounds.upload({ label: 'privado-bob', ext: 'mp3', buffer: Buffer.from('X'), ownerUserId: bob.id, visibility: 'private' })
ok(existsSync(sounds.localPath(s1)), 'espejo local creado en data/sounds/')
ok(existsSync(join(process.env.OBJECT_STORE_DIR, s1.object_key)), 'respaldo en object-store')

console.log('\n— Sync desde object-store (simula VPS reconstruido) —')
const { rmSync } = await import('node:fs')
rmSync(sounds.localPath(s1)) // borrar espejo local
const sync = await sounds.syncFromStore()
ok(existsSync(sounds.localPath(s1)) && sync.restored >= 1, `restaurados ${sync.restored} sonido(s) del respaldo`)

console.log('\n— Visibilidad por rol —')
const tGlobal = getDb().prepare("SELECT id FROM roles WHERE name='user'").get().id
getDb().prepare('INSERT INTO sound_role_policy (sound_id, role_id, visible) VALUES (?, ?, 0)').run(s1.id, getDb().prepare("SELECT id FROM roles WHERE name='guest'").get().id)
const visBob = sounds.listForUser(bob.id).map(s => s.label)
ok(!visBob.includes('risa'), 'sonido oculto para guest (bob no lo ve)')
ok(visBob.includes('privado-bob'), 'bob ve su sonido privado')
const visAlice = sounds.listForUser(alice.id).map(s => s.label)
ok(visAlice.includes('risa') && !visAlice.includes('privado-bob'), 'admin ve global, no ve privado ajeno')

console.log('\n— Límite de uso por rol —')
const guestId = getDb().prepare("SELECT id FROM roles WHERE name='guest'").get().id
const s3 = await sounds.upload({ label: 'spam', ext: 'mp3', buffer: Buffer.from('Y') })
getDb().prepare('INSERT INTO sound_role_policy (sound_id, role_id, visible, rate_limit, rate_window_s) VALUES (?, ?, 1, 2, 60)').run(s3.id, guestId)
ok(rbac.canPlaySound(bob.id, s3).ok, 'primer uso permitido')
history.record({ userId: bob.id, kind: 'sound', refId: s3.id })
history.record({ userId: bob.id, kind: 'sound', refId: s3.id })
ok(!rbac.canPlaySound(bob.id, s3).ok && rbac.canPlaySound(bob.id, s3).reason === 'rate_limit', 'tope alcanzado: bloqueado')
ok(rbac.canPlaySound(alice.id, s3).ok, 'admin ignora el tope')

console.log('\n— Música: descarga, persistencia por umbral y LRU —')
const song = music.upsertSong({ sourceUrl: 'https://yt/abc', title: 'Tema A', ext: 'webm' })
let downloads = 0
const fakeDownloader = async (dest) => { downloads++; wf(dest, Buffer.alloc(800, 1)) } // 800 bytes
for (let i = 0; i < 3; i++) await music.getLocalAudio(music.findByUrl('https://yt/abc'), fakeDownloader)
const songAfter = music.findByUrl('https://yt/abc')
ok(songAfter.play_count === 3, `play_count = ${songAfter.play_count}`)
ok(songAfter.persisted === 1 && existsSync(join(process.env.OBJECT_STORE_DIR, songAfter.audio_key)), 'persistida en object-store al cruzar umbral (3)')

const song2 = music.upsertSong({ sourceUrl: 'https://yt/def', title: 'Tema B', ext: 'webm' })
await music.getLocalAudio(song2, fakeDownloader) // 800 + 800 = 1600 > 1500 → evicta el más viejo
const cacheCount = getDb().prepare('SELECT COUNT(*) AS c FROM local_cache').get().c
ok(cacheCount === 1, `LRU expulsó el más viejo (quedan ${cacheCount} en caché)`)

console.log('\n— Carátula —')
await art.store(song.id, Buffer.from('JPEGDATA'), 'jpg')
ok(existsSync(join(process.env.OBJECT_STORE_DIR, 'art', `${song.id}.jpg`)), 'carátula guardada en object-store')

console.log('\n— Historial —')
const rec = history.recent({ limit: 5 })
ok(rec.length >= 1 && rec[0].title != null, `historial reciente con título (${rec.length} filas)`)

console.log('\n— Playlists —')
const pl = playlists.create(bob.id, 'Favoritas')
playlists.addItem(pl.id, song.id)
playlists.addItem(pl.id, song2.id)
const its = playlists.items(pl.id)
ok(its.length === 2 && its[0].position === 0 && its[1].position === 1, 'playlist con 2 ítems ordenados')

console.log(`\n${'='.repeat(40)}\nRESULTADO: ${pass} OK, ${fail} fallos\n`)
process.exit(fail ? 1 : 0)
