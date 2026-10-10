/**
 * Token 估算与费用计算工具
 *
 * 由于流式响应无法直接获取 usage 数据，这里通过字符数估算 token。
 * 中文约 1.5 字符/token，英文约 4 字符/token，混合文本取中间值 ~2.5 字符/token。
 */

/** 估算文本的 token 数 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  // 统计中文字符占比
  const chineseChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  const totalChars = text.length
  const chineseRatio = chineseChars / totalChars

  // 中文 ~1.5 chars/token，英文 ~4 chars/token
  const avgCharsPerToken = chineseRatio * 1.5 + (1 - chineseRatio) * 4
  return Math.max(1, Math.ceil(totalChars / avgCharsPerToken))
}

/** 模型价格表（每百万 token 的美元价格） */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-4': { input: 30, output: 60 },
  'o1': { input: 15, output: 60 },
  'o1-mini': { input: 3, output: 12 },
  'o3-mini': { input: 1.1, output: 4.4 },
  // Claude
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-opus': { input: 15, output: 75 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  // DeepSeek
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
  'deepseek-coder': { input: 0.14, output: 0.28 },
  // Qwen
  'qwen-max': { input: 2, output: 6 },
  'qwen-plus': { input: 0.8, output: 2 },
  'qwen-turbo': { input: 0.3, output: 0.6 },
  'qwen-long': { input: 0.5, output: 2 },
  // Kimi
  'moonshot-v1-128k': { input: 8.4, output: 8.4 },
  'moonshot-v1-32k': { input: 3.5, output: 3.5 },
  'moonshot-v1-8k': { input: 1.7, output: 1.7 },
  // GLM
  'glm-4-plus': { input: 7, output: 7 },
  'glm-4': { input: 14, output: 14 },
  'glm-4-flash': { input: 0, output: 0 },
  // Gemini
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.15, output: 0.6 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  // 其他常见模型
  'doubao-pro': { input: 1.1, output: 2.8 },
  'doubao-lite': { input: 0.3, output: 0.6 },
  'ernie-4.0': { input: 4.2, output: 4.2 },
  'ernie-3.5': { input: 1.7, output: 1.7 },
}

/** 根据模型名称匹配价格（模糊匹配前缀） */
function getModelPricing(model: string): { input: number; output: number } | null {
  const lowerModel = model.toLowerCase()
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (lowerModel.includes(key)) return pricing
  }
  return null
}

/** 估算费用（美元） */
export function estimateCost(
  promptTokens: number,
  completionTokens: number,
  model: string
): number {
  const pricing = getModelPricing(model)
  if (!pricing) return 0
  const inputCost = (promptTokens / 1_000_000) * pricing.input
  const outputCost = (completionTokens / 1_000_000) * pricing.output
  return inputCost + outputCost
}

/** 格式化费用显示 */
export function formatCost(costUsd: number): string {
  if (costUsd <= 0) return '—'
  if (costUsd < 0.001) return '< $0.001'
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`
  if (costUsd < 1) return `$${costUsd.toFixed(3)}`
  return `$${costUsd.toFixed(2)}`
}

/** 格式化 token 数量 */
export function formatTokens(count: number): string {
  if (count <= 0) return '0'
  if (count < 1000) return String(count)
  if (count < 10000) return `${(count / 1000).toFixed(1)}K`
  return `${(count / 1000).toFixed(0)}K`
}

/** 格式化耗时 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60000)
  const secs = Math.round((ms % 60000) / 1000)
  return `${mins}m${secs}s`
}
