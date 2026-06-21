// Backend de almacenamiento S3-compatible (Cloudflare R2 / Oracle Object Storage).
// El SDK se importa de forma perezosa: en dev (backend 'local') nunca se carga,
// así que no es necesario instalar @aws-sdk/client-s3 hasta el despliegue.
import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { config } from '../config.mjs'

let sdk = null
async function getSdk() {
  if (sdk) return sdk
  let mod
  try {
    mod = await import('@aws-sdk/client-s3')
  } catch {
    throw new Error('Backend s3 requiere @aws-sdk/client-s3. Instálalo: npm i @aws-sdk/client-s3')
  }
  const client = new mod.S3Client({
    endpoint: config.s3.endpoint,
    region: config.s3.region,
    credentials: { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secret },
  })
  sdk = { mod, client }
  return sdk
}

export class S3ObjectStore {
  constructor() {
    this.bucket = config.s3.bucket
    this.kind = 's3'
  }

  async put(key, data) {
    const { mod, client } = await getSdk()
    await client.send(new mod.PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }))
    return key
  }

  async getStream(key) {
    const { mod, client } = await getSdk()
    const res = await client.send(new mod.GetObjectCommand({ Bucket: this.bucket, Key: key }))
    return res.Body
  }

  async getToFile(key, destPath) {
    mkdirSync(dirname(destPath), { recursive: true })
    await pipeline(await this.getStream(key), createWriteStream(destPath))
    return destPath
  }

  async exists(key) {
    const { mod, client } = await getSdk()
    try {
      await client.send(new mod.HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return true
    } catch { return false }
  }

  async delete(key) {
    const { mod, client } = await getSdk()
    await client.send(new mod.DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  // En prod: dominio público r2.dev o CDN de Cloudflare delante del bucket.
  // R2 NO sirve público por el endpoint S3 → requiere S3_PUBLIC_BASE (ya apunta al bucket).
  publicUrl(key) {
    return config.s3.publicBase ? `${config.s3.publicBase.replace(/\/$/, '')}/${key}` : null
  }
}
