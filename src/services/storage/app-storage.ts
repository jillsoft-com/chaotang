/**
 * 业务层同步读取接口。启动时先迁移旧 localStorage，再把目标后端载入内存。
 * Electron 写入经 FileStorageBackend 同步 IPC 落盘；浏览器 IndexedDB 写入排队。
 */
import { getStorageBackend } from './factory'
import { FileStorageBackend } from './file-storage'
import { migrateData } from './migration'
import type { StorageBackend } from './types'

let backend: StorageBackend | null = null
let cache = new Map<string, string>()
let readyPromise: Promise<void> | null = null
let pendingWrites: Promise<void> = Promise.resolve()
let lastWriteError: Error | null = null

function reportWriteError(error: unknown): void {
  lastWriteError = error instanceof Error ? error : new Error(String(error))
  console.error('[Storage] 持久化失败:', lastWriteError)
  window.dispatchEvent(new CustomEvent('app-storage-error', { detail: lastWriteError.message }))
}

export function initializeAppStorage(): Promise<void> {
  if (readyPromise) return readyPromise
  readyPromise = (async () => {
    const selected = getStorageBackend()
    if (selected.name !== 'localStorage') {
      const migration = await migrateData(selected)
      if (migration.state === 'failed') throw new Error(`旧数据迁移失败：${migration.error}`)
    }
    const loaded = new Map<string, string>()
    for (const key of await selected.keys()) {
      if (key.startsWith('__legacy_migration_')) continue
      const value = await selected.get(key)
      if (value !== null) loaded.set(key, value)
    }
    cache = loaded
    backend = selected
  })()
  return readyPromise
}

function requireBackend(): StorageBackend {
  if (!backend) throw new Error('本地存储尚未初始化')
  return backend
}

export const appStorage = {
  getItem(key: string): string | null {
    requireBackend()
    return cache.get(key) ?? null
  },

  setItem(key: string, value: string): void {
    const selected = requireBackend()
    const text = String(value)
    if (cache.get(key) === text) return
    if (selected instanceof FileStorageBackend) {
      selected.setSync(key, text)
      cache.set(key, text)
      return
    }
    const previous = cache.get(key)
    cache.set(key, text)
    pendingWrites = pendingWrites.then(() => selected.set(key, text)).catch(error => {
      if (cache.get(key) === text) {
        if (previous === undefined) cache.delete(key)
        else cache.set(key, previous)
      }
      reportWriteError(error)
    })
  },

  removeItem(key: string): void {
    const selected = requireBackend()
    if (!cache.has(key)) return
    if (selected instanceof FileStorageBackend) {
      selected.deleteSync(key)
      cache.delete(key)
      return
    }
    const previous = cache.get(key)
    cache.delete(key)
    pendingWrites = pendingWrites.then(() => selected.delete(key)).catch(error => {
      if (!cache.has(key) && previous !== undefined) cache.set(key, previous)
      reportWriteError(error)
    })
  }
}

export async function flushAppStorage(): Promise<void> {
  await pendingWrites
  if (lastWriteError) throw lastWriteError
}

/** 测试用：清空进程内缓存，不删除磁盘数据。 */
export function resetAppStorageForTest(): void {
  backend = null
  cache = new Map()
  readyPromise = null
  pendingWrites = Promise.resolve()
  lastWriteError = null
}
