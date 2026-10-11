/**
 * 存储后端与迁移测试
 *
 * 覆盖：
 * - LocalStorageBackend 读写
 * - 迁移：旧数据正确迁移、失败回滚
 * - 工厂自动选择
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LocalStorageBackend } from '@/services/storage/local-storage'
import { migrateData, getMigrationStatus, cleanupMigratedData } from '@/services/storage/migration'
import type { StorageBackend } from '@/services/storage/types'

describe('LocalStorageBackend', () => {
  let backend: LocalStorageBackend

  beforeEach(() => {
    localStorage.clear()
    backend = new LocalStorageBackend('test_')
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('get/set 读写', async () => {
    await backend.set('key1', 'value1')
    const result = await backend.get('key1')
    expect(result).toBe('value1')
  })

  it('get 不存在的键返回 null', async () => {
    const result = await backend.get('nonexistent')
    expect(result).toBeNull()
  })

  it('delete 删除键', async () => {
    await backend.set('key1', 'value1')
    await backend.delete('key1')
    const result = await backend.get('key1')
    expect(result).toBeNull()
  })

  it('keys 列出匹配前缀的键', async () => {
    await backend.set('debate_1', 'a')
    await backend.set('debate_2', 'b')
    await backend.set('config_x', 'c')

    const debateKeys = await backend.keys('debate_')
    expect(debateKeys).toHaveLength(2)
    expect(debateKeys).toContain('debate_1')
    expect(debateKeys).toContain('debate_2')
  })

  it('size 返回估算大小', async () => {
    await backend.set('key1', 'hello')
    const size = await backend.size()
    expect(size).toBeGreaterThan(0)
  })
})

describe('数据迁移', () => {
  let backend: StorageBackend
  const store = new Map<string, string>()

  beforeEach(() => {
    localStorage.clear()
    store.clear()
    backend = {
      name: 'mock',
      get: async (key) => store.get(key) || null,
      set: async (key, value) => { store.set(key, value) },
      delete: async (key) => { store.delete(key) },
      keys: async () => Array.from(store.keys()),
      size: async () => 0
    }
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('成功迁移 localStorage 中的数据', async () => {
    // 准备旧数据
    localStorage.setItem('debates_history', '[{"id":"1"}]')
    localStorage.setItem('debate_mode', 'serial')

    const result = await migrateData(backend)

    expect(result.state).toBe('completed')
    expect(result.migratedKeys).toContain('debates_history')
    expect(result.migratedKeys).toContain('debate_mode')
    expect(store.get('debates_history')).toBe('[{"id":"1"}]')
  })

  it('已完成的迁移不重复执行', async () => {
    localStorage.setItem('debates_history', '[{"id":"1"}]')

    await migrateData(backend)
    store.clear() // 模拟后端已持久化

    const result = await migrateData(backend)
    expect(result.state).toBe('completed')
    // 不应重新写入
    expect(store.size).toBe(0)
  })

  it('无旧数据时迁移成功（空迁移）', async () => {
    const result = await migrateData(backend)
    expect(result.state).toBe('completed')
    expect(result.migratedKeys).toHaveLength(0)
  })

  it('迁移失败时保留旧数据', async () => {
    localStorage.setItem('debates_history', '[{"id":"1"}]')

    // 模拟写入失败
    const failBackend: StorageBackend = {
      name: 'fail',
      get: async () => null,
      set: async () => { throw new Error('磁盘满') },
      delete: async () => {},
      keys: async () => [],
      size: async () => 0
    }

    const result = await migrateData(failBackend)
    expect(result.state).toBe('failed')
    expect(result.error).toContain('磁盘满')

    // 旧数据仍在
    expect(localStorage.getItem('debates_history')).toBe('[{"id":"1"}]')
  })

  it('cleanupMigratedData 清理旧数据', async () => {
    localStorage.setItem('debates_history', '[{"id":"1"}]')
    localStorage.setItem('debate_mode', 'serial')

    await migrateData(backend)
    const cleaned = cleanupMigratedData()

    expect(cleaned).toBeGreaterThan(0)
    // debate_mode 保留（轻量配置）
    expect(localStorage.getItem('debate_mode')).toBe('serial')
    // debates_history 已清理
    expect(localStorage.getItem('debates_history')).toBeNull()
  })

  it('getMigrationStatus 返回正确状态', async () => {
    let status = getMigrationStatus()
    expect(status.state).toBe('idle')

    localStorage.setItem('debates_history', '[{"id":"1"}]')
    await migrateData(backend)

    status = getMigrationStatus()
    expect(status.state).toBe('completed')
    expect(status.completedAt).toBeTruthy()
  })
})
