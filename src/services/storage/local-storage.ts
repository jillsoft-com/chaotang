/**
 * LocalStorage 后端 — 轻量配置与小对象
 *
 * 保留现有行为，用于：
 * - 迁移状态标记
 * - 轻量配置（debate_mode 等）
 * - 降级回退
 */

import type { StorageBackend } from './types'

export class LocalStorageBackend implements StorageBackend {
  readonly name = 'localStorage'
  private prefix: string

  constructor(prefix: string = 'ct_') {
    this.prefix = prefix
  }

  async get(key: string): Promise<string | null> {
    try {
      return localStorage.getItem(this.prefix + key)
    } catch {
      return null
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      localStorage.setItem(this.prefix + key, value)
    } catch (e) {
      // 容量满额时抛出
      throw new Error(`localStorage 写入失败: ${e instanceof Error ? e.message : '未知错误'}`)
    }
  }

  async delete(key: string): Promise<void> {
    localStorage.removeItem(this.prefix + key)
  }

  async keys(prefix?: string): Promise<string[]> {
    const result: string[] = []
    const fullPrefix = this.prefix + (prefix || '')
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith(fullPrefix)) {
        result.push(key.slice(this.prefix.length))
      }
    }
    return result
  }

  async size(): Promise<number> {
    let total = 0
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith(this.prefix)) {
        const value = localStorage.getItem(key)
        total += key.length + (value?.length || 0)
      }
    }
    // 粗略估算：UTF-16 字符 * 2 字节
    return total * 2
  }
}
