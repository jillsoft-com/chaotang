/**
 * 结构化交接包 — 上下文压缩的升级版
 *
 * 当上下文超出模型容量时，用幕僚模型将旧消息压缩为结构化摘要，
 * 保留：目标 / 不可丢的用户要求 / 已完成事项 / 证据引用 / 未解决问题 / 下一步。
 * 原始证据保留引用编号（如 [E1]），不内联全文，节省 token。
 *
 * 失败时调用方回退到自由格式摘要（context-compressor 原有逻辑）。
 */

import type { ChatMessage } from '@/types'
import type { LLMProvider } from '@/services/llm/types'
import { appStorage } from '@/services/storage'
import { llmService } from '@/services/llm-config'
import { createProvider } from '@/services/llm'

// ============ 类型定义 ============

/** 结构化交接包 */
export interface HandoverPackage {
  /** 原始目标 */
  goal: string
  /** 不可丢弃的用户要求 */
  requiredItems: string[]
  /** 已完成事项 */
  completedItems: string[]
  /** 证据引用（文件路径、工具结果摘要等） */
  evidenceRefs: string[]
  /** 未解决问题 */
  unresolvedIssues: string[]
  /** 下一步建议 */
  nextSteps: string[]
}

/** 构建交接包时的证据提取结果 */
export interface HandoverWithEvidence {
  handover: HandoverPackage
  /** 从原始消息中提取的证据列表（编号与交接包中的 [E1] 等对应） */
  extractedEvidence: string[]
}

// ============ 配置 ============

/** 默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 3000

// ============ Provider 获取 ============

/**
 * 获取交接包使用的 LLM Provider（复用摘要模型配置）
 */
function getHandoverProvider(): { provider: LLMProvider; modelId: string } | null {
  const summaryId = appStorage.getItem('summary_model_id')
  if (summaryId) {
    const cfg = llmService.getById(summaryId)
    if (cfg?.apiKey) {
      return {
        provider: createProvider({ provider: cfg.provider, model: cfg.model, apiKey: cfg.apiKey, baseURL: cfg.baseURL }),
        modelId: `${cfg.provider}/${cfg.model}`
      }
    }
  }
  const defaultCfg = llmService.getAll().find(c => c.isDefault) || llmService.getAll()[0]
  if (defaultCfg?.apiKey) {
    return {
      provider: createProvider({ provider: defaultCfg.provider, model: defaultCfg.model, apiKey: defaultCfg.apiKey, baseURL: defaultCfg.baseURL }),
      modelId: `${defaultCfg.provider}/${defaultCfg.model}`
    }
  }
  return null
}

// ============ 响应解析 ============

/**
 * 解析交接包 JSON 响应
 * 处理：正常 JSON / markdown 代码块包裹 / 多余文本
 */
export function parseHandoverResponse(raw: string): HandoverPackage | null {
  if (!raw) return null

  let jsonStr = raw.trim()

  // 1. 提取 markdown 代码块中的 JSON
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim()
  }

  // 2. 提取最外层的 { ... }
  const braceStart = jsonStr.indexOf('{')
  const braceEnd = jsonStr.lastIndexOf('}')
  if (braceStart >= 0 && braceEnd > braceStart) {
    jsonStr = jsonStr.slice(braceStart, braceEnd + 1)
  }

  // 3. 解析 JSON
  try {
    const parsed = JSON.parse(jsonStr)

    return {
      goal: typeof parsed.goal === 'string' ? parsed.goal : '',
      requiredItems: Array.isArray(parsed.requiredItems) ? parsed.requiredItems : [],
      completedItems: Array.isArray(parsed.completedItems) ? parsed.completedItems : [],
      evidenceRefs: Array.isArray(parsed.evidenceRefs) ? parsed.evidenceRefs : [],
      unresolvedIssues: Array.isArray(parsed.unresolvedIssues) ? parsed.unresolvedIssues : [],
      nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps : [],
    }
  } catch {
    return null
  }
}

// ============ 核心函数 ============

/**
 * 构建结构化交接包
 *
 * 将旧消息压缩为结构化摘要，保留关键信息。
 * 消息数太少（< 4 条）时跳过压缩，返回 null。
 *
 * @throws 如果 provider 不可用或超时
 */
export async function buildHandoverPackage(params: {
  messages: ChatMessage[]
  taskGoal?: string
}): Promise<HandoverPackage> {
  const { messages, taskGoal } = params

  if (messages.length < 4) {
    throw new Error('消息数量不足以构建交接包')
  }

  // 获取 Provider
  const provider = getHandoverProvider()
  if (!provider) {
    throw new Error('幕僚模型不可用：未配置摘要模型或默认模型无 API Key')
  }

  // 提取关键信息
  const systemMsg = messages.find(m => m.role === 'system')
  const firstUserMsg = messages.find(m => m.role === 'user')
  const recentMessages = messages.slice(-4)

  // 收集工具结果作为证据线索
  const toolEvidence: string[] = []
  for (const m of messages) {
    if (m.role === 'tool' && m.content) {
      const preview = m.content.slice(0, 200)
      toolEvidence.push(preview)
    }
  }

  // 构建旧消息文本（待压缩部分）
  const oldMessages = messages.slice(2, -4)
  const oldContentText = oldMessages.map(m => {
    const roleLabel = m.role === 'assistant' ? 'AI' : m.role === 'tool' ? '工具结果' : '用户'
    let text = m.content || ''
    if (m.tool_calls && m.tool_calls.length > 0) {
      const toolNames = m.tool_calls.map(tc => tc.function.name).join(', ')
      text += `\n[调用了工具: ${toolNames}]`
    }
    return `[${roleLabel}]: ${text.slice(0, 2000)}`
  }).join('\n\n')

  // 构建 Prompt
  const messages_for_llm: ChatMessage[] = [
    {
      role: 'system',
      content: `你是朝堂幕僚。将对话历史压缩为结构化交接包。

规则：
1. 精确保留用户明确提出的要求（不可丢弃）
2. 已完成事项要附带证据引用编号（如 [E1]、[E2]）
3. 证据引用从下方证据列表中提取，用编号标记
4. 未解决问题要具体可操作
5. 返回严格 JSON，不要包含其他内容`
    },
    {
      role: 'user',
      content: `任务目标：${taskGoal || '（未明确指定）'}

系统指令摘要：${systemMsg?.content?.slice(0, 500) || '无'}
首条用户消息：${firstUserMsg?.content?.slice(0, 500) || '无'}
最近对话：
${recentMessages.map(m => `[${m.role}]: ${m.content?.slice(0, 500) || ''}`).join('\n')}

待压缩的历史消息：
${oldContentText.slice(0, 10000)}

工具证据列表：
${toolEvidence.slice(0, 10).map((e, i) => `[E${i + 1}]: ${e}`).join('\n') || '（无工具证据）'}

请输出 JSON：
{
  "goal": "一句话目标",
  "requiredItems": ["不可丢弃的要求1"],
  "completedItems": ["已完成事项1（证据: [E1]）"],
  "evidenceRefs": ["[E1] 证据描述"],
  "unresolvedIssues": ["未解决问题1"],
  "nextSteps": ["下一步建议1"]
}`
    }
  ]

  // 超时控制
  const timeoutMs = parseInt(
    appStorage.getItem('advisor_timeout_ms') || String(DEFAULT_TIMEOUT_MS),
    10
  )

  const callPromise = provider.provider.chat(messages_for_llm)
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`交接包构建超时 (${timeoutMs}ms)`)), timeoutMs)
  })

  const response = await Promise.race([callPromise, timeoutPromise]) as string

  // 解析响应
  const result = parseHandoverResponse(response)
  if (!result) {
    throw new Error('交接包响应格式错误')
  }

  return result
}

// ============ 渲染 ============

/**
 * 将交接包渲染为可注入消息历史的文本
 */
export function renderHandoverPackage(handover: HandoverPackage): string {
  const parts: string[] = []

  parts.push('[以下为之前对话的结构化交接包]')
  parts.push('')

  if (handover.goal) {
    parts.push(`## 目标`)
    parts.push(handover.goal)
    parts.push('')
  }

  if (handover.requiredItems.length > 0) {
    parts.push(`## 不可丢弃的用户要求`)
    for (const item of handover.requiredItems) {
      parts.push(`- ${item}`)
    }
    parts.push('')
  }

  if (handover.completedItems.length > 0) {
    parts.push(`## 已完成事项`)
    for (const item of handover.completedItems) {
      parts.push(`- ${item}`)
    }
    parts.push('')
  }

  if (handover.evidenceRefs.length > 0) {
    parts.push(`## 证据引用`)
    for (const ref of handover.evidenceRefs) {
      parts.push(`- ${ref}`)
    }
    parts.push('')
  }

  if (handover.unresolvedIssues.length > 0) {
    parts.push(`## 未解决问题`)
    for (const issue of handover.unresolvedIssues) {
      parts.push(`- ${issue}`)
    }
    parts.push('')
  }

  if (handover.nextSteps.length > 0) {
    parts.push(`## 下一步`)
    for (const step of handover.nextSteps) {
      parts.push(`- ${step}`)
    }
    parts.push('')
  }

  parts.push('[交接包结束，以下是最近的对话]')

  return parts.join('\n')
}
