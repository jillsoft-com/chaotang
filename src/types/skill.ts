/**
 * Skill 系统类型定义
 *
 * Skill 是可插拔的能力模块，定义了角色"会什么"。
 * 一个 Skill 可以组合多个 Function Call（ToolDefinition）。
 */

import type { ToolDefinition } from './tool'

/**
 * Skill 分类
 */
export type SkillCategory =
  | 'information'    // 信息获取类（搜索、查询）
  | 'analysis'       // 分析计算类（数据分析、图表）
  | 'verification'   // 验证核查类（事实核查、交叉验证）
  | 'generation'     // 内容生成类（报告、公文）
  | 'communication'  // 通信类（邮件、消息）
  | 'system'         // 系统类（文件操作、日程管理）

/**
 * Skill 配置
 */
export interface SkillConfig {
  maxCallsPerRound?: number  // 每轮朝议最多调用次数
  timeout?: number           // 单次调用超时时间（ms）
  requireConfirmation?: boolean // 是否需要用户确认才执行
  cacheResults?: boolean     // 是否缓存结果
}

/**
 * Skill 定义 — 角色的一项能力
 */
export interface Skill {
  id: string                 // 唯一标识，如 'web_search'
  name: string               // 显示名称，如 '网络搜索'
  description: string        // 能力描述，供 LLM 理解何时使用
  icon?: string              // 图标 emoji
  category: SkillCategory    // 分类
  tools: ToolDefinition[]    // 该 Skill 包含的 Function Call 工具列表
  config?: SkillConfig       // 可选配置
  enabled: boolean           // 是否启用
}

/**
 * 角色-Skill 绑定记录
 */
export interface MinisterSkillBinding {
  ministerId: string
  skillId: string
  enabled: boolean
  config?: Partial<SkillConfig> // 角色级别的配置覆盖
}

/**
 * Skill 分类元信息（用于 UI 展示）
 */
export const SKILL_CATEGORY_LABELS: Record<SkillCategory, string> = {
  information: '信息获取',
  analysis: '分析计算',
  verification: '验证核查',
  generation: '内容生成',
  communication: '通信',
  system: '系统'
}
