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
}

/** 朝议执行模式 */
export type DebateMode = 'serial' | 'parallel' | 'agent'

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
  mentionedMinisters?: string[]
  workingDirectory?: string   // 会话工作目录，输出产物保存到此目录
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: ToolCall[]       // assistant 返回的工具调用
  tool_call_id?: string         // tool role 对应的调用 ID
  name?: string                 // tool role 的函数名
}
