/**
 * 存储后端与迁移测试
 *
 * 覆盖：
 * - LocalStorageBackend 读写
 * - 迁移：旧数据正确迁移、失败回滚
 * - 工厂自动选择
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { LocalStorageBackend } from '@/services/storage/local-storage'
import { migrateData, getMigrationStatus, cleanupMigratedData } from '@/services/storage/migration'
import { FileStorageBackend } from '@/services/storage/file-storage'
import { setStorageBackend, resetStorageBackend } from '@/services/storage/factory'
import { appStorage, flushAppStorage, initializeAppStorage, resetAppStorageForTest } from '@/services/storage/app-storage'
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
    delete (window as { electronAPI?: unknown }).electronAPI
    backend = {
      name: 'mock',
      get: async (key) => store.get(key) ?? null,
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

  it('目标数据丢失时重新迁移旧数据', async () => {
    localStorage.setItem('debates_history', '[{"id":"1"}]')

    await migrateData(backend)
    store.clear() // 模拟目标文件丢失，旧数据仍在

    const result = await migrateData(backend)
    expect(result.state).toBe('completed')
    expect(store.get('debates_history')).toBe('[{"id":"1"}]')
  })

  it('迁移全部旧键，并保留旧数据', async () => {
    const keys = ['debates_history', 'agent_memories', 'gepa_patterns', 'background_tasks', 'theme', 'custom_key']
    keys.forEach((key, i) => localStorage.setItem(key, `value-${i}`))
    const result = await migrateData(backend)
    expect(result.state).toBe('completed')
    keys.forEach((key, i) => {
      expect(store.get(key)).toBe(`value-${i}`)
      expect(localStorage.getItem(key)).toBe(`value-${i}`)
    })
  })

  it('重试不会覆盖目标中较新的数据', async () => {
    localStorage.setItem('debates_history', 'old')
    store.set('debates_history', 'new')
    const result = await migrateData(backend)
    expect(result.state).toBe('completed')
    expect(store.get('debates_history')).toBe('new')
  })

  it('迁移 Electron 旧版明文 API Key，目标已有元数据时也补迁密钥', async () => {
    const loadApiKeys = vi.fn(async () => ({}))
    const saveApiKeys = vi.fn(async () => true)
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { loadApiKeys, saveApiKeys }
    })
    localStorage.setItem('llm_configs', JSON.stringify([{ id: 'model-1', model: 'example', apiKey: 'secret-value' }]))
    store.set('llm_configs', JSON.stringify([{ id: 'model-1', model: 'newer' }]))
    await migrateData(backend)
    expect(saveApiKeys).toHaveBeenCalledWith({ 'model-1': 'secret-value' })
    expect(store.get('llm_configs')).not.toContain('secret-value')
    expect(localStorage.getItem('llm_configs')).not.toContain('secret-value')
  })

  it('迁移首次写入的 Electron 元数据不含明文 API Key', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { loadApiKeys: async () => ({}), saveApiKeys: async () => true }
    })
    localStorage.setItem('llm_configs', JSON.stringify([{ id: 'model-1', apiKey: 'secret-value' }]))
    expect((await migrateData(backend)).state).toBe('completed')
    expect(store.get('llm_configs')).toBe('[{"id":"model-1"}]')
    expect(localStorage.getItem('llm_configs')).toBe('[{"id":"model-1"}]')
  })

  it('加密保存失败时保留旧 API Key 且不写入新文件', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { loadApiKeys: async () => ({}), saveApiKeys: async () => false }
    })
    localStorage.setItem('llm_configs', JSON.stringify([{ id: 'model-1', apiKey: 'secret-value' }]))
    expect((await migrateData(backend)).state).toBe('failed')
    expect(localStorage.getItem('llm_configs')).toContain('secret-value')
    expect(store.has('llm_configs')).toBe(false)
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

describe('Electron 文件存储业务接入', () => {
  const file = new Map<string, string>()

  beforeEach(() => {
    localStorage.clear()
    file.clear()
    resetAppStorageForTest()
    resetStorageBackend()
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        storeGetAll: async () => Object.fromEntries(file),
        storeGetPath: async () => 'test/chaotang-store.json',
        storeSet: async (key: string, value: string) => { file.set(key, value); return true },
        storeDelete: async (key: string) => { file.delete(key); return true },
        storeSetSync: (key: string, value: string) => { file.set(key, value) },
        storeDeleteSync: (key: string) => { file.delete(key) },
        loadApiKeys: async () => ({}),
        saveApiKeys: async () => true
      }
    })
  })

  afterEach(() => {
    resetAppStorageForTest()
    resetStorageBackend()
    delete (window as { electronAPI?: unknown }).electronAPI
    localStorage.clear()
  })

  it('启动迁移旧数据，业务写入立即落盘，重新加载后读回', async () => {
    localStorage.setItem('debates_history', '[{"id":"old"}]')
    setStorageBackend(new FileStorageBackend())
    await initializeAppStorage()
    expect(appStorage.getItem('debates_history')).toBe('[{"id":"old"}]')

    appStorage.setItem('debates_history', '[{"id":"new"}]')
    expect(file.get('debates_history')).toBe('[{"id":"new"}]')

    resetAppStorageForTest()
    setStorageBackend(new FileStorageBackend())
    await initializeAppStorage()
    expect(appStorage.getItem('debates_history')).toBe('[{"id":"new"}]')
  })

  it('同步写入失败时业务缓存保持旧值', async () => {
    setStorageBackend(new FileStorageBackend())
    await initializeAppStorage()
    appStorage.setItem('key', 'old')
    const api = window.electronAPI!
    api.storeSetSync = () => { throw new Error('磁盘满') }
    expect(() => appStorage.setItem('key', 'new')).toThrow('磁盘满')
    expect(appStorage.getItem('key')).toBe('old')
  })
})

describe('浏览器异步写入', () => {
  beforeEach(() => {
    localStorage.clear()
    resetAppStorageForTest()
    resetStorageBackend()
    delete (window as { electronAPI?: unknown }).electronAPI
  })

  afterEach(() => {
    resetAppStorageForTest()
    resetStorageBackend()
    localStorage.clear()
  })

  it('写入失败时恢复缓存并让调用方可检查错误', async () => {
    const file = new Map<string, string>()
    file.set('key', 'old')
    const backend: StorageBackend = {
      name: 'indexedDB',
      get: async key => file.get(key) ?? null,
      set: async (key, value) => {
        if (key === 'key') throw new Error('配额不足')
        file.set(key, value)
      },
      delete: async key => { file.delete(key) },
      keys: async () => Array.from(file.keys()),
      size: async () => 0
    }
    setStorageBackend(backend)
    await initializeAppStorage()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    appStorage.setItem('key', 'new')
    await expect(flushAppStorage()).rejects.toThrow('配额不足')
    expect(appStorage.getItem('key')).toBe('old')
    expect(file.get('key')).toBe('old')
    spy.mockRestore()
  })
})
