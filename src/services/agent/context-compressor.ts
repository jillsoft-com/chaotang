/**
 * 上下文压缩器 — 防止多轮工具调用后 token 爆炸
 *
 * 策略：
 * 1. 工具结果截断：单个 tool 消息超过 maxToolResultLen 字符时自动截断
 * 2. 历史消息压缩：当总字符数超过阈值时，用摘要模型压缩旧消息
 *    保留 system + 首条 user + 最近 keepRecent 条消息
 */

import type { ChatMessage } from '@/types'
import type { LLMProvider } from '@/services/llm/types'

// ============ 配置 ============

/** 默认压缩阈值（字符数，约 15K tokens） */
export const DEFAULT_COMPRESS_THRESHOLD = 50000

/** 单个工具结果最大长度 */
const MAX_TOOL_RESULT_LEN = 2000

/** 压缩后保留的最近消息数（不含 system + 首条 user） */
const KEEP_RECENT = 6

// ============ 工具函数 ============

/**
 * 计算消息数组的总字符数
 */
export function countMessageChars(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + (m.content?.length || 0), 0)
}

/**
 * 获取压缩阈值（从 localStorage 读取）
 */
export function getCompressThreshold(): number {
  const saved = localStorage.getItem('context_compress_threshold')
  if (saved) {
    const val = parseInt(saved, 10)
    if (val > 10000 && val <= 200000) return val
  }
  return DEFAULT_COMPRESS_THRESHOLD
}

/**
 * 截断过长的工具结果（不依赖 LLM，纯本地操作）
 * 对每条 role='tool' 的消息，如果超过 maxLen 则截断
 */
export function truncateToolResults(messages: ChatMessage[], maxLen = MAX_TOOL_RESULT_LEN): ChatMessage[] {
  return messages.map(m => {
    if (m.role !== 'tool' || !m.content) return m
    if (m.content.length <= maxLen) return m
    // 截断并保留摘要
    const truncated = m.content.slice(0, maxLen)
    const remaining = m.content.length - maxLen
    return {
      ...m,
      content: `${truncated}\n\n...[已截断 ${remaining} 字符，完整结果过长已省略]`
    }
  })
}

/**
 * 压缩上下文消息
 *
 * 当总字符数超过阈值时：
 * 1. 先截断过长的工具结果
 * 2. 如果仍然超阈值，用摘要模型压缩旧消息
 *
 * @param messages 当前完整消息数组
 * @param provider 用于生成摘要的 LLM provider（通常是摘要模型）
 * @param threshold 压缩阈值（字符数）
 * @param onProgress 压缩进行中回调（可选，用于显示进度）
 * @returns 压缩后的消息数组
 */
export async function compressContext(
  messages: ChatMessage[],
  provider: LLMProvider,
  threshold: number = getCompressThreshold(),
  onProgress?: (status: string) => void
): Promise<ChatMessage[]> {
  // 第一步：截断过长的工具结果
  let result = truncateToolResults(messages)
  let totalChars = countMessageChars(result)

  if (totalChars <= threshold) {
    return result
  }

  // 第二步：需要 LLM 压缩旧消息
  // 确保有足够的消息可压缩（至少 system + user + 6 条以上才压缩）
  if (result.length < KEEP_RECENT + 2) {
    return result  // 消息太少，不压缩
  }

  onProgress?.('正在压缩上下文...')

  // 分离消息段：
  // [system] [user(首条)] ... [旧消息 - 待压缩] ... [最近 KEEP_RECENT 条]
  const systemMsg = result[0]  // system
  const firstUserMsg = result[1]  // 首条 user
  const recentMessages = result.slice(-KEEP_RECENT)
  const oldMessages = result.slice(2, -KEEP_RECENT)

  // 构建待压缩内容的文本
  const oldContentText = oldMessages.map(m => {
    const roleLabel = m.role === 'assistant' ? 'AI' : m.role === 'tool' ? '工具结果' : '用户'
    let text = m.content || ''
    // assistant 的 tool_calls 也记录
    if (m.tool_calls && m.tool_calls.length > 0) {
      const toolNames = m.tool_calls.map(tc => tc.function.name).join(', ')
      text += `\n[调用了工具: ${toolNames}]`
    }
    return `[${roleLabel}]: ${text.slice(0, 3000)}`
  }).join('\n\n')

  // 用摘要模型生成压缩摘要
  try {
    const summaryMessages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是一个上下文压缩专家。请将以下对话历史压缩为一份简洁的摘要，保留：
1. 关键发现和重要信息
2. 工具调用的核心结果（文件内容、搜索结果、命令输出中的关键数据）
3. 当前任务进度和状态
4. 任何可能影响后续决策的信息

压缩要求：
- 去掉冗余和重复内容
- 工具结果只保留关键数据点，不需要完整输出
- 保持事实准确性
- 输出中文
- 使用 Markdown 格式，控制在 2000 字以内`
      },
      {
        role: 'user',
        content: `请压缩以下对话历史：\n\n${oldContentText.slice(0, 15000)}`
      }
    ]

    const summary = await provider.chat(summaryMessages) as string

    // 构建压缩后的消息数组
    const compressedMessages: ChatMessage[] = [
      systemMsg,
      firstUserMsg,
      {
        role: 'user',
        content: `[以下为之前对话的压缩摘要]\n\n${summary}\n\n[摘要结束，以下是最近的对话]`
      },
      ...recentMessages
    ]

    const newTotal = countMessageChars(compressedMessages)
    console.log(`[ContextCompressor] 压缩完成: ${totalChars} → ${newTotal} 字符, 原始 ${result.length} → ${compressedMessages.length} 条消息`)

    return compressedMessages
  } catch (error) {
    console.warn('[ContextCompressor] LLM 压缩失败，回退到纯截断模式:', error)
    // 回退：只做截断，不压缩
    return result
  }
}
