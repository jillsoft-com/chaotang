/**
 * 数据迁移 — 从 localStorage 迁移到新的存储后端
 *
 * 迁移策略：
 * 1. 检测 localStorage 中的旧数据
 * 2. 一次性迁移到新后端
 * 3. 迁移成功后标记完成（保留旧数据作为备份）
 * 4. 失败回滚：保留旧数据 + 记录状态
 *
 * 迁移状态记录在 localStorage（`ct_migration_status_v2`）
 */

import type { StorageBackend } from './types'

/** 迁移状态 */
export interface MigrationStatus {
  state: 'idle' | 'migrating' | 'completed' | 'failed'
  startedAt?: number
  completedAt?: number
  error?: string
  migratedKeys: string[]
}

const STATUS_KEY = 'ct_migration_status_v2'
const BACKEND_MARKER = '__legacy_migration_v2'

async function prepareValue(key: string, value: string): Promise<string> {
  if (key !== 'llm_configs' || !window.electronAPI) return value
  let configs: Array<Record<string, unknown>>
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) throw new Error('格式不是数组')
    configs = parsed
  } catch { throw new Error('旧模型配置格式无效，已保留原数据，未写入新存储') }

  const legacyKeys: Record<string, string> = {}
  const metadata = configs.map(config => {
    const { apiKey, ...rest } = config
    if (typeof apiKey === 'string' && apiKey && typeof config.id === 'string') {
      legacyKeys[config.id] = apiKey
    }
    return rest
  })
  if (Object.keys(legacyKeys).length > 0) {
    const existing = await window.electronAPI.loadApiKeys()
    if (!await window.electronAPI.saveApiKeys({ ...legacyKeys, ...existing })) {
      throw new Error('旧版 API Key 加密保存失败')
    }
  }
  return JSON.stringify(metadata)
}

/**
 * 获取迁移状态
 */
export function getMigrationStatus(): MigrationStatus {
  try {
    const raw = localStorage.getItem(STATUS_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* 忽略 */ }
  return { state: 'idle', migratedKeys: [] }
}

/**
 * 保存迁移状态
 */
function saveMigrationStatus(status: MigrationStatus): void {
  localStorage.setItem(STATUS_KEY, JSON.stringify(status))
}

/**
 * 执行数据迁移
 *
 * @param backend 目标存储后端
 * @returns 迁移结果
 */
export async function migrateData(backend: StorageBackend): Promise<MigrationStatus> {
  const status = getMigrationStatus()

  // 以目标后端标记为准；浏览器存储中的旧标记不能证明目标数据仍存在。
  if (status.state === 'completed' && await backend.get(BACKEND_MARKER) === 'completed') {
    return status
  }

  // 标记为迁移中
  const newStatus: MigrationStatus = {
    state: 'migrating',
    startedAt: Date.now(),
    migratedKeys: []
  }
  saveMigrationStatus(newStatus)

  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key !== STATUS_KEY && key !== 'ct_migration_status') keys.push(key)
    }
    for (const key of keys) {
      const value = localStorage.getItem(key)
      if (value === null) continue
      // 即便配置元数据已进入新后端，也要补迁旧版明文 API Key。
      // prepareValue 会先保存到 Electron 的加密密钥文件，再去掉元数据中的明文。
      const prepared = await prepareValue(key, value)
      // 已写入文件的较新值优先；重试迁移也不能覆盖它。
      const existing = await backend.get(key)
      if (existing === null) {
        await backend.set(key, prepared)
        if (await backend.get(key) !== prepared) throw new Error(`迁移校验失败: ${key}`)
        newStatus.migratedKeys.push(key)
      } else if (key === 'llm_configs') {
        const sanitized = await prepareValue(key, existing)
        if (sanitized !== existing) {
          await backend.set(key, sanitized)
          if (await backend.get(key) !== sanitized) throw new Error(`迁移校验失败: ${key}`)
        }
      }
      // 已确认加密密钥保存成功且目标元数据可读，清除旧浏览器副本中的明文密钥。
      if (key === 'llm_configs' && prepared !== value) localStorage.setItem(key, prepared)
    }

    await backend.set(BACKEND_MARKER, 'completed')

    // 标记完成
    newStatus.state = 'completed'
    newStatus.completedAt = Date.now()
    saveMigrationStatus(newStatus)

    console.log(`[Migration] 迁移完成，共 ${newStatus.migratedKeys.length} 个键`)
    return newStatus
  } catch (error) {
    // 迁移失败：保留旧数据
    newStatus.state = 'failed'
    newStatus.error = error instanceof Error ? error.message : '未知错误'
    saveMigrationStatus(newStatus)

    console.error('[Migration] 迁移失败:', newStatus.error)
    return newStatus
  }
}

/**
 * 清理已迁移的旧数据（可选，在确认新后端稳定后调用）
 *
 * @returns 清理的键数量
 */
export function cleanupMigratedData(): number {
  const status = getMigrationStatus()
  if (status.state !== 'completed') return 0

  let cleaned = 0
  for (const key of status.migratedKeys) {
    // 保留 debate_mode（轻量配置继续使用 localStorage）
    if (key === 'debate_mode') continue
    localStorage.removeItem(key)
    cleaned++
  }

  console.log(`[Migration] 清理了 ${cleaned} 个旧键`)
  return cleaned
}
