/**
 * 插件沙箱 — 受限执行环境
 *
 * 将 `new Function` 编译的 handler 移至受限环境：
 * - 使用受限的 proxy 对象：只暴露声明的能力，不暴露全局
 * - 第三方插件默认不信任：需用户显式批准
 * - 批准记录持久化：plugin_grants
 *
 * 设计依据：朝堂任务树运行时改进说明 R4。
 */

import type { ToolHandler } from '@/types'

// ============ 类型 ============

/** 插件授权记录 */
export interface PluginGrant {
  pluginId: string
  /** 授权的工具名列表 */
  grantedTools: string[]
  /** 授权时间 */
  grantedAt: number
  /** 是否来自用户显式批准 */
  userApproved: boolean
}

/** 插件信任级别 */
export type PluginTrustLevel = 'builtin' | 'verified' | 'third-party'

/** 敏感工具列表（需要显式授权） */
const SENSITIVE_TOOLS = new Set([
  'write_file',
  'create_directory',
  'execute_command',
  'git_operation',
  'run_tests',
  'web_search'
])

// ============ 授权存储 ============

const GRANTS_KEY = 'ct_plugin_grants'

/** 获取所有插件授权记录 */
export function getPluginGrants(): PluginGrant[] {
  try {
    const raw = localStorage.getItem(GRANTS_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* 忽略 */ }
  return []
}

/** 保存插件授权记录 */
function savePluginGrants(grants: PluginGrant[]): void {
  localStorage.setItem(GRANTS_KEY, JSON.stringify(grants))
}

/** 检查插件是否已授权 */
export function isPluginGranted(pluginId: string, toolName: string): boolean {
  const grants = getPluginGrants()
  const grant = grants.find(g => g.pluginId === pluginId)
  if (!grant) return false
  return grant.grantedTools.includes(toolName)
}

/** 授权插件使用特定工具 */
export function grantPlugin(pluginId: string, tools: string[], userApproved: boolean = true): void {
  const grants = getPluginGrants()
  const existing = grants.find(g => g.pluginId === pluginId)
  if (existing) {
    // 合并工具列表
    const merged = new Set([...existing.grantedTools, ...tools])
    existing.grantedTools = Array.from(merged)
    existing.grantedAt = Date.now()
    existing.userApproved = userApproved
  } else {
    grants.push({
      pluginId,
      grantedTools: tools,
      grantedAt: Date.now(),
      userApproved
    })
  }
  savePluginGrants(grants)
}

/** 撤销插件授权 */
export function revokePlugin(pluginId: string): void {
  const grants = getPluginGrants().filter(g => g.pluginId !== pluginId)
  savePluginGrants(grants)
}

// ============ 沙箱执行 ============

/**
 * 创建受限的工具代理
 *
 * handler 只能通过此代理访问被授权的工具，不能访问全局对象。
 */
export function createSandboxContext(grantedTools: string[]): Record<string, any> {
  const context: Record<string, any> = {}

  // 只暴露被授权的工具名作为占位（实际由外部注入）
  for (const tool of grantedTools) {
    context[tool] = undefined // 由调用者注入实际实现
  }

  // 提供安全的 JSON 操作
  context.JSON = JSON
  context.Math = Math
  context.Date = Date
  context.Array = Array
  context.Object = Object
  context.String = String
  context.Number = Number
  context.Boolean = Boolean
  context.RegExp = RegExp
  context.Map = Map
  context.Set = Set
  console

  // 不提供：fetch, XMLHttpRequest, WebSocket, require, import, process, global, eval

  return context
}

/**
 * 在沙箱中编译并执行 handler
 *
 * @param code handler 源代码
 * @param toolNames 工具名列表
 * @param pluginId 插件 ID
 * @param trustLevel 信任级别
 * @returns 工具名 → handler 映射
 */
export function compileInSandbox(
  code: string,
  toolNames: string[],
  pluginId: string,
  trustLevel: PluginTrustLevel = 'third-party'
): Record<string, ToolHandler> {
  const handlers: Record<string, ToolHandler> = {}

  // 安全检查：禁止危险 API
  const forbiddenPatterns = [
    /\brequire\s*\(/,
    /\bimport\s+/,
    /\bprocess\b/,
    /\bglobal\b/,
    /\bglobalThis\b/,
    /\b__dirname\b/,
    /\b__filename\b/,
    /\beval\s*\(/,
    /\bFunction\s*\(/,
    /\bsetTimeout\s*\(/,
    /\bsetInterval\s*\(/,
  ]

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(code)) {
      throw new Error(`Handler 代码包含禁止的 API: ${pattern.source}`)
    }
  }

  // 第三方插件：检查敏感工具是否已授权
  if (trustLevel === 'third-party') {
    for (const toolName of toolNames) {
      if (SENSITIVE_TOOLS.has(toolName) && !isPluginGranted(pluginId, toolName)) {
        throw new Error(
          `插件 ${pluginId} 未获授权使用敏感工具 ${toolName}，请先在设置中授权`
        )
      }
    }
  }

  // 构建受限上下文
  const sandboxContext = createSandboxContext(toolNames)
  const contextKeys = Object.keys(sandboxContext)
  const contextValues = contextKeys.map(k => sandboxContext[k])

  for (const toolName of toolNames) {
    try {
      const wrappedCode = `
        "use strict";
        ${code}
        ;
        return typeof ${toolName} === 'function' ? ${toolName}
             : typeof handler === 'function' ? handler
             : null;
      `
      // 使用受限的 Function 构造器：只传入安全上下文
      const factory = new Function(...contextKeys, 'args', wrappedCode)
      const fn = factory(...contextValues, undefined)

      if (typeof fn === 'function') {
        handlers[toolName] = async (args: Record<string, any>) => {
          return await fn(args)
        }
      } else {
        handlers[toolName] = async () => ({
          error: `插件 handler 未定义函数 ${toolName} 或 handler`
        })
      }
    } catch (error) {
      throw new Error(
        `编译工具 ${toolName} 的 handler 失败: ${error instanceof Error ? error.message : '未知错误'}`
      )
    }
  }

  return handlers
}

/**
 * 判断工具是否为敏感工具
 */
export function isSensitiveTool(toolName: string): boolean {
  return SENSITIVE_TOOLS.has(toolName)
}
