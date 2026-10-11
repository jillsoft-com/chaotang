/**
 * 存储工厂 — 自动选择最佳后端
 *
 * 选择策略：
 * - Electron 环境 → FileStorageBackend（本地 JSON 文件）
 * - 浏览器环境 → IndexedDBBackend
 * - 降级 → LocalStorageBackend
 */

import type { StorageBackend } from './types'
import { LocalStorageBackend } from './local-storage'
import { IndexedDBBackend } from './indexeddb-storage'
import { FileStorageBackend } from './file-storage'

/** 检测是否为 Electron 环境 */
function isElectron(): boolean {
  return typeof window !== 'undefined' && !!(window as any).electronAPI
}

/** 检测 IndexedDB 是否可用 */
function isIndexedDBAvailable(): boolean {
  return typeof indexedDB !== 'undefined'
}

let _backend: StorageBackend | null = null

/**
 * 获取存储后端（单例）
 *
 * 首次调用时自动选择后端并缓存。
 */
export function getStorageBackend(): StorageBackend {
  if (_backend) return _backend

  if (isElectron()) {
    // Electron 环境：优先使用本地文件存储（持久化到 userData）
    _backend = new FileStorageBackend()
    console.log('[Storage] 使用 FileStorageBackend（Electron 本地文件）')
  } else if (isIndexedDBAvailable()) {
    _backend = new IndexedDBBackend()
    console.log('[Storage] 使用 IndexedDB 后端')
  } else {
    _backend = new LocalStorageBackend('')
    console.log('[Storage] 降级使用 localStorage')
  }

  return _backend
}

/**
 * 强制设置存储后端（测试用）
 */
export function setStorageBackend(backend: StorageBackend): void {
  _backend = backend
}

/**
 * 重置存储后端
 */
export function resetStorageBackend(): void {
  _backend = null
}
