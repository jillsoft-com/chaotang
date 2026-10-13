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
import { storeEvidence } from './evidence-store'

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

/**
 * 构建交接包时的返回结果
 */
export interface HandoverWithEvidence {
  handover: HandoverPackage
  /** 存储的证据数量 */
  evidenceCount: number
  /** 证据预览列表（编号 + 来源 + 前 300 字预览，内联到渲染文本中供 LLM 直接查看） */
  evidencePreviews: { id: string; source: string; preview: string }[]
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
    if (cfg && (cfg.apiKey || cfg.provider === 'ollama')) {
      return {
        provider: createProvider({ provider: cfg.provider, model: cfg.model, apiKey: cfg.apiKey, baseURL: cfg.baseURL }),
        modelId: `${cfg.provider}/${cfg.model}`
      }
    }
  }
  const defaultCfg = llmService.getAll().find(c => c.isDefault) || llmService.getAll()[0]
  if (defaultCfg && (defaultCfg.apiKey || defaultCfg.provider === 'ollama')) {
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
  /** 未截断的原始消息（用于证据提取完整原文） */
  originalMessages?: ChatMessage[]
  taskGoal?: string
  /** 会话 ID，用于生成全局唯一证据编号 */
  sessionId?: string
}): Promise<HandoverWithEvidence> {
  const { messages, originalMessages, taskGoal, sessionId = 'default' } = params

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
  const allUserMessages = messages.filter(m => m.role === 'user')
  const recentMessages = messages.slice(-4)

  // 从原始消息中提取工具证据（完整原文），存入独立证据存储
  const evidenceSource = originalMessages || messages
  const toolEvidence: { text: string; source: string; evidenceId: string }[] = []
  for (const m of evidenceSource) {
    if (m.role === 'tool' && m.content) {
      const source = m.name || 'unknown'
      // 存入独立证据存储，保留完整原文，返回全局唯一编号
      const evidenceId = storeEvidence(sessionId, source, m.content)
      // 给 LLM 的摘要版本（前 2000 字）
      toolEvidence.push({
        text: m.content.slice(0, 2000),
        source,
        evidenceId
      })
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

  // 整份 Prompt 总预算控制（小模型输入容量约 15000 字）
  const TOTAL_BUDGET = 15000
  const SYSTEM_PROMPT_CHARS = 200
  const USER_MSGS_CHARS = 3000
  const RECENT_CHARS = 1500
  const OLD_CONTENT_CHARS = 5000
  // 剩余预算分配给工具证据
  const evidenceBudget = Math.max(500, TOTAL_BUDGET - SYSTEM_PROMPT_CHARS - USER_MSGS_CHARS - RECENT_CHARS - OLD_CONTENT_CHARS - 1000)

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
全部用户消息（含中途追加的要求）：
${(() => {
  const MAX_TOTAL = USER_MSGS_CHARS
  let total = 0
  return allUserMessages.map((m, i) => {
    const remaining = MAX_TOTAL - total
    if (remaining <= 0) return `[用户消息${i + 1}]: ...(已截断)`
    const text = (m.content || '').slice(0, Math.min(1000, remaining))
    total += text.length
    return `[用户消息${i + 1}]: ${text}`
  }).join('\n')
})()}
最近对话：
${recentMessages.map(m => `[${m.role}]: ${(m.content || '').slice(0, Math.floor(RECENT_CHARS / recentMessages.length))}`).join('\n')}

待压缩的历史消息：
${oldContentText.slice(0, OLD_CONTENT_CHARS)}

工具证据列表（含来源工具名和证据编号）：
${(() => {
  let total = 0
  const lines: string[] = []
  for (const e of toolEvidence) {
    const perItem = Math.min(500, Math.max(100, Math.floor(evidenceBudget / Math.max(1, toolEvidence.length))))
    const remaining = evidenceBudget - total
    if (remaining <= 0) { lines.push('...(证据已截断)'); break }
    const text = e.text.slice(0, Math.min(perItem, remaining))
    lines.push(`[${e.evidenceId}] (${e.source}): ${text}`)
    total += text.length
  }
  return lines.join('\n') || '（无工具证据）'
})()}

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

  // 拼装后实际总长校验：按实际拼装内容计数，超限时逐段裁剪
  const actualTotal = messages_for_llm.reduce((sum, m) => sum + (m.content?.length || 0), 0)
  if (actualTotal > TOTAL_BUDGET) {
    console.warn(`[HandoverPackage] 拼装后总长超限 (${actualTotal} > ${TOTAL_BUDGET})，尝试逐段裁剪`)
    // 裁剪策略：从最宽松的部分开始裁剪
    // 1. 先裁剪工具证据到最少
    const evidenceSection = messages_for_llm[1].content?.split('工具证据列表（含来源工具名和证据编号）：\n')[1]?.split('\n\n请输出 JSON')[0] || ''
    if (evidenceSection.length > 500) {
      const trimmedEvidence = evidenceSection.slice(0, 500) + '\n...(证据已裁剪)'
      messages_for_llm[1].content = messages_for_llm[1].content?.replace(evidenceSection, trimmedEvidence)
    }
    // 2. 再裁剪历史消息
    const oldSection = messages_for_llm[1].content?.split('待压缩的历史消息：\n')[1]?.split('\n\n工具证据列表')[0] || ''
    if (oldSection.length > 2000) {
      const trimmedOld = oldSection.slice(0, 2000) + '\n...(历史已裁剪)'
      messages_for_llm[1].content = messages_for_llm[1].content?.replace(oldSection, trimmedOld)
    }
    // 3. 再裁剪用户消息
    const userSection = messages_for_llm[1].content?.split('全部用户消息（含中途追加的要求）：\n')[1]?.split('\n最近对话：')[0] || ''
    if (userSection.length > 1500) {
      const trimmedUser = userSection.slice(0, 1500) + '\n...(用户消息已裁剪)'
      messages_for_llm[1].content = messages_for_llm[1].content?.replace(userSection, trimmedUser)
    }
    // 最终检查
    const finalTotal = messages_for_llm.reduce((sum, m) => sum + (m.content?.length || 0), 0)
    if (finalTotal > TOTAL_BUDGET) {
      throw new Error(`交接包 Prompt 总长超限 (${finalTotal} > ${TOTAL_BUDGET})，无法安全构建`)
    }
    console.log(`[HandoverPackage] 裁剪后达标: ${finalTotal} 字符`)
  }

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

  // 必留要求校验：LLM 提取 + 关键词启发式始终合并（不依赖空数组判定）
  // 1. LLM 提取（能理解普通表述的约束）
  try {
    const llmDirectives = await extractDirectivesByLLM(provider.provider, allUserMessages, timeoutMs)
    for (const directive of llmDirectives) {
      if (!result.requiredItems.some(r => r.includes(directive) || directive.includes(r))) {
        result.requiredItems.unshift(directive)
      }
    }
  } catch {
    // LLM 提取失败时静默，关键词回退始终运行
  }
  // 2. 关键词启发式始终运行（捕获 LLM 可能遗漏的显式指令）
  for (const userMsg of allUserMessages) {
    if (!userMsg.content) continue
    const fallbackDirectives = extractUserDirectivesByKeywords(userMsg.content)
    for (const directive of fallbackDirectives) {
      if (!result.requiredItems.some(r => r.includes(directive))) {
        result.requiredItems.unshift(directive)
      }
    }
  }

  // 构建证据预览：完整原文存入独立存储，预览内联到交接包供 LLM 直接查看
  // 总量上限 3000 字，防止长任务使压缩后反而超限
  const MAX_PREVIEW_TOTAL_CHARS = 3000
  const evidencePreviews: { id: string; source: string; preview: string }[] = []
  let previewTotalChars = 0
  for (const e of toolEvidence) {
    const remaining = MAX_PREVIEW_TOTAL_CHARS - previewTotalChars
    if (remaining <= 0) break
    const preview = e.text.slice(0, Math.min(300, remaining))
    evidencePreviews.push({ id: e.evidenceId, source: e.source, preview })
    previewTotalChars += preview.length
  }
  return { handover: result, evidenceCount: toolEvidence.length, evidencePreviews }
}

/**
 * 用 LLM 从用户消息中提取所有约束和要求（替代关键词启发式）
 * 能理解普通表述的约束，如“用 TypeScript 写”“输出格式为 JSON”等
 */
async function extractDirectivesByLLM(
  provider: LLMProvider,
  userMessages: ChatMessage[],
  timeoutMs: number
): Promise<string[]> {
  // 总量上限 5000 字，防止超长用户消息使小模型超载
  const MAX_USER_TEXT_CHARS = 5000
  let userTextTotalChars = 0
  const userTexts = userMessages
    .map((m, i) => {
      const remaining = MAX_USER_TEXT_CHARS - userTextTotalChars
      if (remaining <= 0) return `[消息${i + 1}]: ...(已截断)`
      const text = (m.content || '').slice(0, remaining)
      userTextTotalChars += text.length
      return `[消息${i + 1}]: ${text}`
    })
    .join('\n')

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `你是需求提取专家。从用户消息中提取所有明确的约束、要求和指令。

规则：
1. 包括显式要求（“必须”“不要”）和隐式约束（“用 TypeScript”“输出 JSON”“保持简洁”）
2. 包括格式要求、技术约束、内容限制、风格偏好
3. 每条要求用一句话概括，不超过 30 字
4. 返回 JSON 数组，如 ["要求1", "要求2"]
5. 如果没有额外要求，返回空数组 []`
    },
    {
      role: 'user',
      content: `请从以下用户消息中提取所有约束和要求：\n\n${userTexts}\n\n请输出 JSON 数组：`
    }
  ]

  const callPromise = provider.chat(messages)
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('LLM 提取要求超时')), timeoutMs)
  })

  const response = await Promise.race([callPromise, timeoutPromise]) as string

  // 解析 JSON 数组
  try {
    let jsonStr = response.trim()
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
    if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim()
    const bracketStart = jsonStr.indexOf('[')
    const bracketEnd = jsonStr.lastIndexOf(']')
    if (bracketStart >= 0 && bracketEnd > bracketStart) {
      jsonStr = jsonStr.slice(bracketStart, bracketEnd + 1)
    }
    const parsed = JSON.parse(jsonStr)
    if (Array.isArray(parsed)) {
      return parsed.filter((s: any) => typeof s === 'string' && s.length > 0).slice(0, 10)
    }
  } catch { /* 解析失败，返回空数组 */ }
  return []
}

/**
 * 从用户消息中提取关键指令（关键词启发式，作为 LLM 提取失败时的回退）
 */
function extractUserDirectivesByKeywords(userMessage: string): string[] {
  const directives: string[] = []
  const patterns = [
    /必须(.{2,60})/g,
    /不要(.{2,60})/g,
    /请确保(.{2,60})/g,
    /一定[要得](.{2,60})/g,
    /禁止(.{2,60})/g,
    /remember to (.{2,60})/gi,
    /make sure to (.{2,60})/gi,
    /don't (.{2,60})/gi,
  ]
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(userMessage)) !== null) {
      const directive = match[0].trim()
      if (directive.length >= 4 && directive.length <= 90) {
        directives.push(directive)
      }
    }
  }
  return directives.slice(0, 10) // 最多 10 条
}

// ============ 渲染 ============

/**
 * 将交接包渲染为可注入消息历史的文本
 */
export function renderHandoverPackage(handover: HandoverPackage, evidencePreviews?: { id: string; source: string; preview: string }[]): string {
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

  // 内联证据预览（LLM 可直接查看证据内容，无需调用外部接口）
  if (evidencePreviews && evidencePreviews.length > 0) {
    parts.push(`## 工具证据预览（共 ${evidencePreviews.length} 条，以下为摘要，完整原文已存入独立存储）`)
    for (const ev of evidencePreviews) {
      parts.push(`**[${ev.id}]** (${ev.source}): ${ev.preview}${ev.preview.length >= 300 ? '...' : ''}`)
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
