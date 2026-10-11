/**
 * 数据迁移 — 从 localStorage 迁移到新的存储后端
 *
 * 迁移策略：
 * 1. 检测 localStorage 中的旧数据
 * 2. 一次性迁移到新后端
 * 3. 迁移成功后标记完成（保留旧数据作为备份）
 * 4. 失败回滚：保留旧数据 + 记录状态
 *
 * 迁移状态记录在 localStorage（`ct_migration_status`）
 */

import type { StorageBackend } from './types'

/** 需要迁移的键列表 */
const MIGRATION_KEYS = [
  'debates_history',
  'debate_mode',
  'llm_configs',
  'background_tasks',
  'plugin_grants'
]

/** 迁移状态 */
export interface MigrationStatus {
  state: 'idle' | 'migrating' | 'completed' | 'failed'
  startedAt?: number
  completedAt?: number
  error?: string
  migratedKeys: string[]
}

const STATUS_KEY = 'ct_migration_status'

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

  // 已完成迁移，跳过
  if (status.state === 'completed') {
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
    for (const key of MIGRATION_KEYS) {
      const value = localStorage.getItem(key)
      if (value === null) continue

      // 写入新后端
      await backend.set(key, value)
      newStatus.migratedKeys.push(key)
    }

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
