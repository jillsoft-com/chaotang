/**
 * 插件系统类型定义
 *
 * 自定义工具插件通过 SKILL.md 文件定义，支持 YAML frontmatter 格式。
 */

import type { ToolDefinition, ToolHandler } from '@/types'
import type { SkillCategory } from '@/types'

/** SKILL.md 中 YAML frontmatter 的原始结构 */
export interface PluginManifest {
  id: string
  name: string
  description: string
  icon?: string
  category?: SkillCategory
  version?: string
  author?: string
  tools: PluginToolDefinition[]
  /** 内联 handler 代码（JavaScript） */
  handler?: string
  /** 绑定到哪些角色（ministerId 列表），为空则不自动绑定 */
  bindTo?: string[]
}

/** 插件中的工具定义（YAML 解析后的原始形式） */
export interface PluginToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties?: Record<string, {
      type: string
      description?: string
      enum?: (string | number)[]
      default?: any
      items?: any
    }>
    required?: string[]
  }
}

/** 已加载的插件信息 */
export interface LoadedPlugin {
  /** 插件 manifest */
  manifest: PluginManifest
  /** 插件文件路径 */
  filePath: string
  /** 插件目录路径 */
  dirPath: string
  /** 解析后的 ToolDefinition 列表 */
  toolDefinitions: ToolDefinition[]
  /** 解析后的 handler 函数映射（toolName → handler） */
  handlers: Record<string, ToolHandler>
  /** 加载状态 */
  status: 'loaded' | 'error'
  /** 错误信息 */
  error?: string
  /** 加载时间 */
  loadedAt: number
}

/** 插件目录扫描结果 */
export interface PluginScanResult {
  /** 插件目录路径 */
  pluginDir: string
  /** 发现的插件数量 */
  count: number
  /** 已加载的插件列表 */
  plugins: LoadedPlugin[]
  /** 加载失败的插件 */
  errors: Array<{ filePath: string; error: string }>
}
