/**
 * IndexedDB 后端 — 浏览器端大对象存储
 *
 * 特性：
 * - 支持大对象（通常 50MB+）
 * - 带版本化格式（schemaVersion 字段）
 * - 异步操作不阻塞主线程
 */

import type { StorageBackend } from './types'

const DB_NAME = 'chaotang_storage'
const DB_VERSION = 1
const STORE_NAME = 'kv'

export class IndexedDBBackend implements StorageBackend {
  readonly name = 'indexedDB'
  private dbPromise: Promise<IDBDatabase> | null = null

  private getDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION)

        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME)
          }
        }

        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(new Error(`IndexedDB 打开失败: ${request.error?.message}`))
      })
    }
    return this.dbPromise
  }

  private async withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.getDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode)
      const store = tx.objectStore(STORE_NAME)
      const request = fn(store)

      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(new Error(`IndexedDB 操作失败: ${request.error?.message}`))
    })
  }

  async get(key: string): Promise<string | null> {
    try {
      const result = await this.withStore('readonly', store => store.get(key))
      return typeof result === 'string' ? result : null
    } catch {
      return null
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      await this.withStore('readwrite', store => store.put(value, key))
    } catch (e) {
      throw new Error(`IndexedDB 写入失败: ${e instanceof Error ? e.message : '未知错误'}`)
    }
  }

  async delete(key: string): Promise<void> {
    await this.withStore('readwrite', store => store.delete(key))
  }

  async keys(prefix?: string): Promise<string[]> {
    const allKeys = await this.withStore('readonly', store => store.getAllKeys())
    const keys = allKeys as string[]
    if (!prefix) return keys
    return keys.filter(k => k.startsWith(prefix))
  }

  async size(): Promise<number> {
    const allKeys = await this.withStore('readonly', store => store.getAllKeys())
    let total = 0
    const db = await this.getDB()

    for (const key of allKeys) {
      const value = await new Promise<string | null>((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly')
        const store = tx.objectStore(STORE_NAME)
        const req = store.get(key)
        req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : null)
        req.onerror = () => resolve(null)
      })
      total += String(key).length + (value?.length || 0)
    }
    return total * 2
  }

  /** 关闭数据库连接 */
  close(): void {
    if (this.dbPromise) {
      this.dbPromise.then(db => db.close())
      this.dbPromise = null
    }
  }
}
