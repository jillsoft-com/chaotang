export type { LLMProviderType } from './llm'
export type { ToolDefinition, ToolCall, ToolCallResult, ToolHandler, ToolCallStatus, JSONSchema } from './tool'
export type { Skill, SkillConfig, SkillCategory, MinisterSkillBinding } from './skill'
export { SKILL_CATEGORY_LABELS } from './skill'
import type { LLMProviderType } from './llm'
import type { ToolCall, ToolCallResult, ToolCallStatus } from './tool'
import type { Skill } from './skill'

export interface Minister {
  id: string
  name: string
  title: string
  avatar: string
  systemPrompt: string
  llm: LLMConfig
  order: number
  description: string
  skills?: Skill[]           // 角色绑定的技能列表
}

export interface LLMConfig {
  provider: LLMProviderType
  model: string
  apiKey?: string
  baseURL?: string
  temperature?: number
  maxTokens?: number
  llmId?: string
}

export interface Speech {
  id: string
  ministerId: string
  content: string
  timestamp: number
  status: 'pending' | 'streaming' | 'completed' | 'error'
  toolCalls?: ToolCallResult[]   // 本次发言中的工具调用记录
  toolStatuses?: ToolCallStatus[] // 工具调用状态（UI 展示用）
  /** Token 使用统计（估算或 API 返回） */
  tokenUsage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  /** 使用的 LLM 模型标识 */
  model?: string
  /** 响应耗时（毫秒） */
  durationMs?: number
}

/** 朝议执行模式 */
export type DebateMode = 'serial' | 'parallel' | 'agent'

/** 附件（用户上传的文件，注入朝议上下文） */
export interface Attachment {
  id: string
  /** 文件名（含扩展名） */
  fileName: string
  /** 文件完整路径 */
  filePath: string
  /** 文件大小（字节） */
  fileSize: number
  /** 文件类型（扩展名，如 pdf / docx / txt） */
  fileType: string
  /** 提取的文本内容（截断后） */
  content?: string
  /** 添加时间 */
  addedAt: number
}

export interface Debate {
  id: string
  topic: string
  mode: 'court' | 'compare' | 'private'
  compareMode?: 'serial' | 'parallel' | 'blind'
  debateMode?: DebateMode   // 朝议执行模式（串行/并行/Agent）
  speeches: Speech[]
  status: 'idle' | 'running' | 'paused' | 'completed'
  createdAt: number
  completedAt?: number
  imperialDecree?: string
  /** 结构化决策报告（拍板后自动生成） */
  decisionReport?: DecisionReport
  /** 用户自定义标签，用于分类和检索（Sprint A - #10） */
  tags?: string[]
  mentionedMinisters?: string[]
  workingDirectory?: string   // 会话工作目录，输出产物保存到此目录
  /** 附件列表（合同、文档等，注入朝议上下文） */
  attachments?: Attachment[]
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: ToolCall[]       // assistant 返回的工具调用
  tool_call_id?: string         // tool role 对应的调用 ID
  name?: string                 // tool role 的函数名
}

// ============ 决策质量可视化（Sprint A - #1） ============

/** 四象限中的单个条目 */
export interface DecisionEntry {
  id: string
  title: string
  detail: string
  /** 来源角色 ID 列表（minister.id 或 'emperor'），用于追溯谁提出了这条 */
  sources?: string[]
  /** 重要程度 1-5 */
  importance?: number
}

/** 拍板后的结构化决策报告（共识/分歧/风险/假设 四象限） */
export interface DecisionReport {
  /** 共识点：多位角色共同支持的观点、事实或结论 */
  consensus: DecisionEntry[]
  /** 分歧点：角色间存在争议或不同立场的内容 */
  disagreements: DecisionEntry[]
  /** 风险清单：需要注意的潜在问题、障碍或代价 */
  risks: DecisionEntry[]
  /** 待验证假设：尚未确认、需要后续验证的前提、数据或结论 */
  assumptions: DecisionEntry[]
  /** 一句话决策结论（圣旨浓缩版） */
  verdict?: string
  /** 下一步行动建议（按优先级排序） */
  nextSteps?: string[]
  /** 生成时间戳 */
  generatedAt: number
  /** 生成使用的 LLM 标识（provider:model） */
  generatedBy?: string
}
