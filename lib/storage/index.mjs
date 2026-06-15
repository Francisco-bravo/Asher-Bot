// Selector de backend de almacenamiento según STORAGE_BACKEND.
import { LocalObjectStore } from './local-store.mjs'
import { S3ObjectStore } from './s3-store.mjs'
import { config } from '../config.mjs'

let instance = null

export function getStore() {
  if (!instance) {
    instance = config.storageBackend === 's3' ? new S3ObjectStore() : new LocalObjectStore()
  }
  return instance
}
