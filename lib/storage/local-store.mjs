// Backend de almacenamiento basado en carpeta local (stand-in de R2 en dev).
// Implementa la misma interfaz que el backend S3 para que el cambio a prod
// sea solo configuración.
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { config } from '../config.mjs'

export class LocalObjectStore {
  constructor(baseDir = config.objectStoreDir) {
    this.baseDir = baseDir
    this.kind = 'local'
  }

  _p(key) { return join(this.baseDir, key) }

  async put(key, data) {
    const p = this._p(key)
    mkdirSync(dirname(p), { recursive: true })
    if (Buffer.isBuffer(data) || typeof data === 'string') writeFileSync(p, data)
    else await pipeline(data, createWriteStream(p)) // stream
    return key
  }

  getStream(key) {
    return createReadStream(this._p(key))
  }

  async getToFile(key, destPath) {
    mkdirSync(dirname(destPath), { recursive: true })
    copyFileSync(this._p(key), destPath) // mismo filesystem: copia directa
    return destPath
  }

  exists(key) { return existsSync(this._p(key)) }

  size(key) { return existsSync(this._p(key)) ? statSync(this._p(key)).size : 0 }

  delete(key) { rmSync(this._p(key), { force: true }) }

  // En dev no hay CDN: la web servirá /art/:key leyendo del object-store.
  publicUrl() { return null }
}
