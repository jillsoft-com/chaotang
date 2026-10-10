/**
 * SandboxConfig — 沙箱配置管理
 *
 * 管理沙箱隔离的用户配置，持久化到 localStorage。
 */

import type { SandboxConfig } from './types'
import { DEFAULT_SANDBOX_CONFIG } from './types'

const STORAGE_KEY = 'sandbox_config'

/** 获取沙箱配置 */
export function getSandboxConfig(): SandboxConfig {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      return { ...DEFAULT_SANDBOX_CONFIG, ...parsed }
    }
  } catch {
    // 解析失败，使用默认值
  }
  return { ...DEFAULT_SANDBOX_CONFIG }
}

/** 保存沙箱配置 */
export function saveSandboxConfig(config: Partial<SandboxConfig>): void {
  const current = getSandboxConfig()
  const merged = { ...current, ...config }
  // 校验值域
  merged.maxMemoryMB = Math.max(128, Math.min(2048, merged.maxMemoryMB))
  merged.maxTimeout = Math.max(10000, Math.min(300000, merged.maxTimeout))
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
}

/** 重置为默认配置 */
export function resetSandboxConfig(): void {
  localStorage.removeItem(STORAGE_KEY)
}
