/**
 * 文件系统后端 — Electron 本地持久化存储
 *
 * 通过 IPC 将数据存储在 Electron userData 目录下的 chaotang-store.json 文件中。
 * 优势：
 * - 无浏览器 localStorage 5-10 MB 容量限制
 * - 数据持久化到磁盘，不受缓存清理影响
 * - 写入使用原子操作（先写临时文件再重命名），防止数据损坏
 *
 * 设计依据：朝堂任务树运行时改进说明 R3。
 */

import type { StorageBackend } from './types'

export class FileStorageBackend implements StorageBackend {
  readonly name = 'file'
  private store: Map<string, string> | null = null
  private loadPromise: Promise<void> | null = null
  private filePath: string | null = null

  /**
   * 确保数据已加载（首次调用时从主进程读取，后续复用缓存）
   */
  private async ensureLoaded(): Promise<void> {
    if (this.store !== null) return
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = this.doLoad()
    return this.loadPromise
  }

  private async doLoad(): Promise<void> {
    const result = await window.electronAPI!.storeGetAll()
    this.store = new Map(Object.entries(result || {}))
    this.filePath = await window.electronAPI!.storeGetPath?.() ?? null
  }

  async get(key: string): Promise<string | null> {
    await this.ensureLoaded()
    return this.store!.get(key) ?? null
  }

  async set(key: string, value: string): Promise<void> {
    await this.ensureLoaded()
    await window.electronAPI!.storeSet(key, value)
    this.store!.set(key, value)
  }

  async delete(key: string): Promise<void> {
    await this.ensureLoaded()
    await window.electronAPI!.storeDelete(key)
    this.store!.delete(key)
  }

  /** 同步提交关键业务数据，确保关闭窗口前已落盘。 */
  setSync(key: string, value: string): void {
    window.electronAPI!.storeSetSync(key, value)
    this.store?.set(key, value)
  }

  deleteSync(key: string): void {
    window.electronAPI!.storeDeleteSync(key)
    this.store?.delete(key)
  }

  async keys(prefix?: string): Promise<string[]> {
    await this.ensureLoaded()
    const allKeys = Array.from(this.store!.keys())
    if (!prefix) return allKeys
    return allKeys.filter(k => k.startsWith(prefix))
  }

  async size(): Promise<number> {
    await this.ensureLoaded()
    let total = 0
    for (const [key, value] of this.store!) {
      total += key.length + (value?.length || 0)
    }
    return total * 2
  }

  /**
   * 强制重新加载（外部数据变更后刷新缓存）
   */
  async reload(): Promise<void> {
    this.store = null
    this.loadPromise = null
    await this.ensureLoaded()
  }

  /** 获取数据文件路径（调试/日志用） */
  getDataFilePath(): string | null {
    return this.filePath
  }
}
