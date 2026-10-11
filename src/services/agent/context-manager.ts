/**
 * 上下文管理 — 按模型容量管理上下文
 *
 * 已知模型使用 token 估算，未知模型保留 50,000 字符阈值。
 * 压缩时保留系统约束、任务目标、最近轮次、证据引用。
 * 压缩次数和丢失信息可追溯。
 *
 * 设计依据：朝堂任务树运行时改进说明 R8。
 */

// ============ 类型 ============

export interface ContextBudget {
  /** 模型的最大上下文窗口（token） */
  maxTokens: number
  /** 字符到 token 的估算比例（默认 1 token ≈ 3 字符） */
  charToTokenRatio: number
  /** 模型标识 */
  modelId: string
}

export interface CompressionRecord {
  /** 压缩时间 */
  timestamp: number
  /** 压缩前字符数 */
  beforeChars: number
  /** 压缩后字符数 */
  afterChars: number
  /** 丢弃的信息摘要 */
  discardedSummaries: string[]
  /** 压缩原因 */
  reason: string
}

export interface CompressionResult {
  /** 压缩后的消息列表 */
  compressed: ContextMessage[]
  /** 压缩记录 */
  record: CompressionRecord
}

export interface ContextMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** 是否为关键消息（不可被压缩丢弃） */
  critical?: boolean
  /** 消息来源标记 */
  source?: 'system_constraint' | 'task_goal' | 'evidence_ref' | 'recent_turn' | 'history'
}

// ============ 模型上下文容量配置 ============

/** 已知模型的上下文容量 */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'gpt-4': 8192,
  'gpt-4-turbo': 128000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-3.5-turbo': 16385,
  'claude-3-opus': 200000,
  'claude-3-sonnet': 200000,
  'claude-3-haiku': 200000,
  'claude-3.5-sonnet': 200000,
  'deepseek-chat': 64000,
  'deepseek-coder': 64000,
  'qwen-max': 32000,
  'qwen-plus': 131072,
  'qwen-turbo': 131072,
  'moonshot-v1-8k': 8192,
  'moonshot-v1-32k': 32768,
  'moonshot-v1-128k': 131072,
  'glm-4': 128000,
}

/** 未知模型的默认上下文容量（token） */
const DEFAULT_CONTEXT_TOKENS = 16000

/** 未知模型的字符阈值 */
const DEFAULT_CHAR_THRESHOLD = 50000

/** 系统约束保留比例（占上下文窗口的百分比） */
const SYSTEM_RESERVE_PCT = 0.1

/** 最近轮次保留数 */
const RECENT_TURNS_TO_KEEP = 4

// ============ 上下文管理器 ============

export class ContextManager {
  private compressionHistory: CompressionRecord[] = []
  private budget: ContextBudget

  constructor(modelId: string) {
    const maxTokens = MODEL_CONTEXT_LIMITS[modelId] || DEFAULT_CONTEXT_TOKENS
    this.budget = {
      maxTokens,
      charToTokenRatio: 3,
      modelId
    }
  }

  /**
   * 获取模型上下文预算
   */
  getBudget(): Readonly<ContextBudget> {
    return this.budget
  }

  /**
   * 估算文本的 token 数
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / this.budget.charToTokenRatio)
  }

  /**
   * 获取可用上下文字符数（扣除系统保留）
   */
  getAvailableChars(): number {
    const totalChars = this.budget.maxTokens * this.budget.charToTokenRatio
    return Math.floor(totalChars * (1 - SYSTEM_RESERVE_PCT))
  }

  /**
   * 判断消息列表是否超出上下文窗口
   */
  exceedsContextLimit(messages: ContextMessage[]): boolean {
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0)
    return totalChars > this.getAvailableChars()
  }

  /**
   * 压缩消息列表，保留关键信息
   *
   * 压缩策略：
   * 1. 始终保留 system 消息（系统约束）
   * 2. 始终保留 critical 标记的消息
   * 3. 保留最近 N 轮对话
   * 4. 中间历史消息压缩为摘要
   */
  compress(messages: ContextMessage[], reason: string = '上下文窗口不足'): CompressionResult {
    const availableChars = this.getAvailableChars()
    const beforeChars = messages.reduce((sum, m) => sum + m.content.length, 0)

    // 分类消息
    const systemMessages: ContextMessage[] = []
    const criticalMessages: ContextMessage[] = []
    const recentMessages: ContextMessage[] = []

    // 1. 提取 system 消息
    const nonSystem = messages.filter(m => {
      if (m.role === 'system' || m.source === 'system_constraint') {
        systemMessages.push(m)
        return false
      }
      return true
    })

    // 2. 提取 critical 消息
    const nonCritical = nonSystem.filter(m => {
      if (m.critical || m.source === 'task_goal' || m.source === 'evidence_ref') {
        criticalMessages.push(m)
        return false
      }
      return true
    })

    // 3. 分离最近轮次和历史
    const recentCount = Math.min(RECENT_TURNS_TO_KEEP, nonCritical.length)
    const recentSlice = nonCritical.slice(nonCritical.length - recentCount)
    const historySlice = nonCritical.slice(0, nonCritical.length - recentCount)

    recentMessages.push(...recentSlice)

    // 4. 压缩历史消息
    const discardedSummaries: string[] = []
    let historyCompressed = ''
    if (historySlice.length > 0) {
      const summaries = historySlice.map(m => {
        const preview = m.content.length > 100
          ? m.content.slice(0, 100) + '...'
          : m.content
        return `[${m.role}] ${preview}`
      })
      discardedSummaries.push(...summaries)
      historyCompressed = `[历史摘要 - ${historySlice.length} 条消息已被压缩]\n` +
        summaries.map(s => `- ${s}`).join('\n')
    }

    // 重新组装
    const compressed: ContextMessage[] = [
      ...systemMessages,
      ...(historyCompressed ? [{
        role: 'system' as const,
        content: historyCompressed,
        source: 'history' as const
      }] : []),
      ...criticalMessages,
      ...recentMessages
    ]

    // 如果仍然超出限制，进一步裁剪最近消息
    let totalChars = compressed.reduce((sum, m) => sum + m.content.length, 0)
    while (totalChars > availableChars && compressed.length > systemMessages.length + 1) {
      // 从最近消息中移除最早的一条
      const lastNonSystemIdx = compressed.findIndex(
        (_m, i) => i >= systemMessages.length + (historyCompressed ? 1 : 0) + criticalMessages.length
      )
      if (lastNonSystemIdx === -1) break

      const removed = compressed.splice(lastNonSystemIdx, 1)[0]
      discardedSummaries.push(`[${removed.role}] ${removed.content.slice(0, 50)}...`)
      totalChars = compressed.reduce((sum, m) => sum + m.content.length, 0)
    }

    const afterChars = compressed.reduce((sum, m) => sum + m.content.length, 0)

    const record: CompressionRecord = {
      timestamp: Date.now(),
      beforeChars,
      afterChars,
      discardedSummaries,
      reason
    }

    this.compressionHistory.push(record)

    return { compressed, record }
  }

  /**
   * 获取压缩历史
   */
  getCompressionHistory(): ReadonlyArray<CompressionRecord> {
    return this.compressionHistory
  }

  /**
   * 获取压缩统计
   */
  getCompressionStats(): {
    totalCompressions: number
    totalCharsSaved: number
    lastCompressionTime: number
  } {
    const totalCharsSaved = this.compressionHistory.reduce(
      (sum, r) => sum + (r.beforeChars - r.afterChars), 0
    )
    return {
      totalCompressions: this.compressionHistory.length,
      totalCharsSaved,
      lastCompressionTime: this.compressionHistory.length > 0
        ? this.compressionHistory[this.compressionHistory.length - 1].timestamp
        : 0
    }
  }

  /**
   * 重置压缩历史
   */
  reset(): void {
    this.compressionHistory = []
  }
}

// ============ 辅助函数 ============

/**
 * 获取已知模型的上下文容量
 */
export function getModelContextLimit(modelId: string): number | null {
  return MODEL_CONTEXT_LIMITS[modelId] || null
}

/**
 * 获取默认字符阈值（未知模型）
 */
export function getDefaultCharThreshold(): number {
  return DEFAULT_CHAR_THRESHOLD
}
