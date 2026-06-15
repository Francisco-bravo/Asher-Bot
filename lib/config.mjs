// Configuración central y rutas de la capa de almacenamiento.
// En dev el "object store" es una carpeta local que imita R2/S3.
// En prod se cambia STORAGE_BACKEND=s3 y el resto del código no cambia.
import { mkdirSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)) // carpeta dev/

function resolveDir(envVal, fallback) {
  const v = envVal || fallback
  return isAbsolute(v) ? v : join(ROOT, v)
}

export const config = {
  root: ROOT,
  storageBackend: process.env.STORAGE_BACKEND || 'local', // 'local' | 's3'
  dataDir: resolveDir(process.env.DATA_DIR, 'data'),
  objectStoreDir: resolveDir(process.env.OBJECT_STORE_DIR, 'object-store'),
  musicCacheMaxBytes: Number(process.env.MUSIC_CACHE_MAX_BYTES || 20 * 1024 ** 3), // 20 GB
  cachePlayThreshold: Number(process.env.CACHE_PLAY_THRESHOLD || 3),
  s3: {
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || 'auto',
    bucket: process.env.S3_BUCKET,
    accessKey: process.env.S3_ACCESS_KEY,
    secret: process.env.S3_SECRET,
  },
}

export const paths = {
  db: join(config.dataDir, 'bot.db'),
  sounds: join(config.dataDir, 'sounds'),          // espejo permanente: TODOS los sonidos
  musicCache: join(config.dataDir, 'music-cache'), // caché LRU de música
  artCache: join(config.dataDir, 'art-cache'),
  tmp: join(config.dataDir, 'tmp'),
  migrations: join(ROOT, 'lib', 'migrations'),
}

export function ensureDirs() {
  for (const d of [config.dataDir, config.objectStoreDir, paths.sounds, paths.musicCache, paths.artCache, paths.tmp]) {
    mkdirSync(d, { recursive: true })
  }
}
