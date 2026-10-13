/**
 * 幕僚助理 — 小模型意图分析与 Skill 推荐
 *
 * 定位："幕僚"，只做整理与推荐，不做决策。
 * - 从候选 Skill 中推荐最相关的几项并说明理由
 * - 提取目标、交付物、约束；判断任务类型
 * - 不判定工具权限（程序把关），不决定重试/暂停（调度器把关）
 *
 * 触发时机：仅在关键节点调用（任务入口、节点分派前），不在每轮对话中调用。
 * 成本护栏：单次超时 3s（可配置），每轮最多 1 次调用。
 */

import type { Skill, ToolCallResult } from '@/types'
import type { ChatMessage } from '@/types'
import type { LLMProvider } from '@/services/llm/types'
import { appStorage } from '@/services/storage'
import { llmService } from '@/services/llm-config'
import { createProvider } from '@/services/llm'

// ============ 类型定义 ============

/** 意图分析结果 */
export interface IntentAnalysis {
  /** 提取的目标 */
  goal: string
  /** 交付物列表 */
  deliverables: string[]
  /** 约束条件 */
  constraints: string[]
  /** 任务类型 */
  taskType: 'qa' | 'research' | 'execution' | 'mixed'
  /** 缺失的信息 */
  missingInfo: string[]
}

/** 单个 Skill 推荐 */
export interface SkillRecommendation {
  skillId: string
  reason: string
  priority: 'high' | 'medium' | 'low'
}

/** 幕僚完整返回 */
export interface AdvisorResult {
  intent: IntentAnalysis
  recommendations: SkillRecommendation[]
  reasoning: string
}

/** 幕僚调用度量（用于"开启前后"对比验收） */
export interface AdvisorMetrics {
  timestamp: number
  ministerId: string
  topicPreview: string
  totalSkills: number
  recommendedSkills: number
  finalToolCount: number
  estimatedTokens: number
  latencyMs: number
  fallbackUsed: boolean
  advisorModelId: string
}

// ============ 配置 ============

/** 默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 3000

/** 默认最大推荐 Skill 数 */
const DEFAULT_MAX_RECOMMENDATIONS = 8

// ============ Provider 获取 ============

/**
 * 获取幕僚使用的 LLM Provider（复用摘要模型配置）
 */
function getAdvisorProvider(): { provider: LLMProvider; modelId: string } | null {
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
  // 回退到默认模型
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
 * 健壮的 JSON 响应解析
 * 处理：正常 JSON / markdown 代码块包裹 / 多余文本包裹
 */
export function parseAdvisorResponse(raw: string): AdvisorResult | null {
  if (!raw) return null

  let jsonStr = raw.trim()

  // 1. 尝试提取 markdown 代码块中的 JSON
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim()
  }

  // 2. 尝试提取最外层的 { ... }
  const braceStart = jsonStr.indexOf('{')
  const braceEnd = jsonStr.lastIndexOf('}')
  if (braceStart >= 0 && braceEnd > braceStart) {
    jsonStr = jsonStr.slice(braceStart, braceEnd + 1)
  }

  // 3. 解析 JSON
  try {
    const parsed = JSON.parse(jsonStr)

    // 验证基本结构
    const intent: IntentAnalysis = {
      goal: typeof parsed.intent?.goal === 'string' ? parsed.intent.goal : '',
      deliverables: Array.isArray(parsed.intent?.deliverables) ? parsed.intent.deliverables : [],
      constraints: Array.isArray(parsed.intent?.constraints) ? parsed.intent.constraints : [],
      taskType: parseTaskType(parsed.intent?.taskType),
      missingInfo: Array.isArray(parsed.intent?.missingInfo) ? parsed.intent.missingInfo : [],
    }

    const recommendations: SkillRecommendation[] = []
    if (Array.isArray(parsed.recommendations)) {
      for (const rec of parsed.recommendations) {
        if (rec && typeof rec.skillId === 'string') {
          recommendations.push({
            skillId: rec.skillId,
            reason: typeof rec.reason === 'string' ? rec.reason : '',
            priority: parsePriority(rec.priority),
          })
        }
      }
    }

    return {
      intent,
      recommendations,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    }
  } catch {
    return null
  }
}

function parseTaskType(val: unknown): IntentAnalysis['taskType'] {
  if (val === 'qa' || val === 'research' || val === 'execution' || val === 'mixed') return val
  return 'mixed'
}

function parsePriority(val: unknown): SkillRecommendation['priority'] {
  if (val === 'high' || val === 'medium' || val === 'low') return val
  return 'medium'
}

// ============ 核心函数 ============

/**
 * 幕僚分析：意图分析 + Skill 推荐
 *
 * 只做推荐，不做决策。返回的 skillId 需要由调用方验证权限和可用性。
 *
 * @throws 如果 provider 不可用、超时或响应格式错误
 */
export async function analyzeAndRecommend(params: {
  ministerId: string
  userMessage: string
  availableSkills: Skill[]
  topic: string
}): Promise<AdvisorResult> {
  const { ministerId: _ministerId, userMessage, availableSkills, topic } = params

  if (availableSkills.length === 0) {
    throw new Error('无可用 Skill')
  }

  // 获取 Provider
  const advisor = getAdvisorProvider()
  if (!advisor) {
    throw new Error('幕僚模型不可用：未配置摘要模型或默认模型无 API Key')
  }

  // 构建 Skill 清单（只发 name + description，节省 token）
  const skillList = availableSkills
    .map(s => {
      const toolNames = s.tools.map(t => t.function.name).join(', ')
      return `- ${s.id}: ${s.name} — ${s.description}（工具: ${toolNames}）`
    })
    .join('\n')

  // 构建 Prompt
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `你是朝堂幕僚。分析用户意图并推荐最相关的技能。

规则：
1. 分析用户的目标、交付物和约束
2. 从可用技能中推荐最相关的（不超过 ${DEFAULT_MAX_RECOMMENDATIONS} 个）
3. 说明推荐理由
4. 返回严格 JSON，不要包含其他内容`
    },
    {
      role: 'user',
      content: `可用技能：
${skillList}

用户原话：${userMessage}
当前议题：${topic}

请分析意图并推荐技能，返回 JSON：
{
  "intent": {
    "goal": "一句话目标",
    "deliverables": ["交付物1"],
    "constraints": ["约束1"],
    "taskType": "research|execution|qa|mixed",
    "missingInfo": []
  },
  "recommendations": [
    {"skillId": "技能ID", "reason": "推荐理由", "priority": "high|medium|low"}
  ],
  "reasoning": "整体推理说明"
}`
    }
  ]

  // 超时控制
  const timeoutMs = parseInt(appStorage.getItem('advisor_timeout_ms') || String(DEFAULT_TIMEOUT_MS), 10)

  const callPromise = advisor.provider.chat(messages)
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`幕僚调用超时 (${timeoutMs}ms)`)), timeoutMs)
  })

  const response = await Promise.race([callPromise, timeoutPromise]) as string

  // 解析响应
  const result = parseAdvisorResponse(response)
  if (!result) {
    throw new Error('幕僚响应格式错误')
  }

  // 幻觉过滤：只保留 availableSkills 中存在的 skillId
  const validSkillIds = new Set(availableSkills.map(s => s.id))
  result.recommendations = result.recommendations.filter(r => validSkillIds.has(r.skillId))

  return result
}

// ============ 三期：异常归因 ============

/** 异常归因结果 */
export interface ErrorAttribution {
  /** 错误类别 */
  category: 'tool_error' | 'permission_denied' | 'resource_issue' | 'logic_error' | 'timeout' | 'external_factor'
  /** 错误摘要 */
  summary: string
  /** 根因分析 */
  rootCause: string
  /** 受影响的工具列表 */
  affectedTools: string[]
  /** 建议措施 */
  suggestions: string[]
}

/**
 * 解析异常归因 JSON 响应
 */
export function parseErrorAttribution(raw: string): ErrorAttribution | null {
  if (!raw) return null

  let jsonStr = raw.trim()
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim()
  const braceStart = jsonStr.indexOf('{')
  const braceEnd = jsonStr.lastIndexOf('}')
  if (braceStart >= 0 && braceEnd > braceStart) jsonStr = jsonStr.slice(braceStart, braceEnd + 1)

  try {
    const parsed = JSON.parse(jsonStr)
    const validCategories: ErrorAttribution['category'][] = [
      'tool_error', 'permission_denied', 'resource_issue', 'logic_error', 'timeout', 'external_factor'
    ]
    return {
      category: validCategories.includes(parsed.category) ? parsed.category : 'tool_error',
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      rootCause: typeof parsed.rootCause === 'string' ? parsed.rootCause : '',
      affectedTools: Array.isArray(parsed.affectedTools) ? parsed.affectedTools : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    }
  } catch {
    return null
  }
}

/**
 * 异常归因 — 幕僚将执行失败归类整理
 *
 * 只做归类和建议，不决定重试/暂停/终止（调度器把关）。
 *
 * @throws 如果 provider 不可用、超时或响应格式错误
 */
export async function attributeError(params: {
  taskDescription: string
  failedToolCalls: ToolCallResult[]
  errorMessage: string
}): Promise<ErrorAttribution> {
  const { taskDescription, failedToolCalls, errorMessage } = params

  const provider = getAdvisorProvider()
  if (!provider) {
    throw new Error('幕僚模型不可用')
  }

  // 构建失败工具摘要
  const toolSummary = failedToolCalls
    .filter(tc => tc.status === 'error' || tc.status === 'timeout')
    .map(tc => {
      const argsPreview = typeof tc.arguments === 'object'
        ? JSON.stringify(tc.arguments).slice(0, 100)
        : String(tc.arguments).slice(0, 100)
      return `- ${tc.functionName}(${argsPreview}): ${tc.error || '执行失败'} (${tc.status})`
    })
    .join('\n')

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `你是朝堂幕僚。分析执行失败的原因并归类。

规则：
1. 判断错误类别
2. 分析根因
3. 给出可操作的建议
4. 返回严格 JSON`
    },
    {
      role: 'user',
      content: `任务描述：${taskDescription}
错误信息：${errorMessage}

失败的工具调用：
${toolSummary || '（无工具调用失败记录）'}

请分析错误原因，返回 JSON：
{
  "category": "tool_error|permission_denied|resource_issue|logic_error|timeout|external_factor",
  "summary": "错误摘要",
  "rootCause": "根因分析",
  "affectedTools": ["工具名"],
  "suggestions": ["建议1"]
}`
    }
  ]

  const timeoutMs = parseInt(
    appStorage.getItem('advisor_timeout_ms') || String(DEFAULT_TIMEOUT_MS), 10
  )
  const callPromise = provider.provider.chat(messages)
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`异常归因超时 (${timeoutMs}ms)`)), timeoutMs)
  })

  const response = await Promise.race([callPromise, timeoutPromise]) as string
  const result = parseErrorAttribution(response)
  if (!result) {
    throw new Error('异常归因响应格式错误')
  }
  return result
}

// ============ 三期：汇报检查 ============

/** 汇报检查结果 */
export interface ReportCheck {
  /** 目标是否被覆盖 */
  goalCovered: boolean
  /** 已覆盖的要点 */
  coveredPoints: string[]
  /** 遗漏的要点 */
  missingPoints: string[]
  /** 改进建议 */
  suggestions: string[]
}

/**
 * 解析汇报检查 JSON 响应
 */
export function parseReportCheck(raw: string): ReportCheck | null {
  if (!raw) return null

  let jsonStr = raw.trim()
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim()
  const braceStart = jsonStr.indexOf('{')
  const braceEnd = jsonStr.lastIndexOf('}')
  if (braceStart >= 0 && braceEnd > braceStart) jsonStr = jsonStr.slice(braceStart, braceEnd + 1)

  try {
    const parsed = JSON.parse(jsonStr)
    return {
      goalCovered: typeof parsed.goalCovered === 'boolean' ? parsed.goalCovered : false,
      coveredPoints: Array.isArray(parsed.coveredPoints) ? parsed.coveredPoints : [],
      missingPoints: Array.isArray(parsed.missingPoints) ? parsed.missingPoints : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    }
  } catch {
    return null
  }
}

/**
 * 汇报检查 — 幕僚检查汇报是否漏答目标
 *
 * 只检查和建议，不单独判定"任务完成"（调度器把关）。
 *
 * @throws 如果 provider 不可用、超时或响应格式错误
 */
export async function checkReport(params: {
  goal: string
  requirements: string[]
  reportContent: string
}): Promise<ReportCheck> {
  const { goal, requirements, reportContent } = params

  const provider = getAdvisorProvider()
  if (!provider) {
    throw new Error('幕僚模型不可用')
  }

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `你是朝堂幕僚。检查汇报是否完整回应了原始目标和要求。

规则：
1. 对照目标和要求逐条检查
2. 指出遗漏的要点
3. 给出改进建议
4. 返回严格 JSON`
    },
    {
      role: 'user',
      content: `原始目标：${goal}
用户要求：
${requirements.map(r => `- ${r}`).join('\n') || '（无额外要求）'}

汇报内容：
${reportContent.slice(0, 5000)}

请检查汇报是否完整，返回 JSON：
{
  "goalCovered": true,
  "coveredPoints": ["已覆盖的要点"],
  "missingPoints": ["遗漏的要点"],
  "suggestions": ["改进建议"]
}`
    }
  ]

  const timeoutMs = parseInt(
    appStorage.getItem('advisor_timeout_ms') || String(DEFAULT_TIMEOUT_MS), 10
  )
  const callPromise = provider.provider.chat(messages)
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`汇报检查超时 (${timeoutMs}ms)`)), timeoutMs)
  })

  const response = await Promise.race([callPromise, timeoutPromise]) as string
  const result = parseReportCheck(response)
  if (!result) {
    throw new Error('汇报检查响应格式错误')
  }
  return result
}
