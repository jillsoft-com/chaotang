/**
 * 推理模型「思考开关」判定
 *
 * 为什么要这一层：
 * 执行过程看不见「已思考」，根因往往不在 UI，而是请求体里根本没带思考开关——
 * 服务端处于非思考模式时不下发 reasoning_content，而模型发起 tool_calls 时正文通道 content
 * 又常常是空的。exec-timeline.endThink 会把「文本为空」的思考段整段删掉，
 * 时间线于是塌成一片连续的工具行（执行命令 / 文件读取 / 代码搜索），看不到决策过程。
 *
 * 各家 OpenAI 兼容网关的字段并不统一，且多数网关对未识别字段直接 400，
 * 所以这里只做「有把握才发」：命中模型名特征或网关域名特征才带上参数，
 * 其余一律不发（返回空对象），由 openai.ts 在 400 时再自动降级重试一次兜底。
 */

/** 思考模式（auto/on/off）定义在 types 层，此处只引用，避开 types → services 的反向依赖 */
import type { ThinkingMode } from '@/types'

export type { ThinkingMode }

/** 参数形态：各家网关的思考开关写法 */
export type ThinkingFamily = 'enable_thinking' | 'thinking' | 'thinking_effort' | 'reasoning_effort' | 'reasoning_object' | 'none'

/**
 * 按模型名判定形态。顺序即优先级：先专属后缀（-thinking / -reasoner），
 * 再具体厂商系列，最后才交给域名特征。
 */
export function detectThinkingFamilyByModel(model: string): ThinkingFamily | 'none' {
  const m = (model || '').toLowerCase()
  if (!m) return 'none'

  // 通义 QwQ / QVQ / Qwen3 混合思考系列：只认 enable_thinking（该网关不认 thinking.type）
  if (/^qwen3|^qwq|^qvq|qwen[-_ ]?3/.test(m)) return 'enable_thinking'
  // DeepSeek 推理系列：thinking.type + reasoning_effort
  if (/deepseek[-_ ]?(v4|r1)|deepseek.*reason|reasoner/.test(m)) return 'thinking_effort'
  // 显式思考版后缀：GLM / Kimi / 豆包等都以 -thinking 结尾，统一 thinking.type
  if (/-thinking\b|think$/.test(m)) return 'thinking'
  // OpenAI 推理系列：只认 reasoning_effort，发 thinking 会 400
  if (/\b(o1|o3|o4)(?:-|mini|preview|$)/.test(m) || /gpt-5/.test(m)) return 'reasoning_effort'
  return 'none'
}

/** 模型名认不出来时，退一步按网关域名特征判定（自建代理常被模型名坑到，这里是主要救命通道） */
export function detectThinkingFamilyByBaseURL(baseURL: string): ThinkingFamily | 'none' {
  const u = (baseURL || '').toLowerCase()
  if (!u) return 'none'
  if (/dashscope|aliyuncs/.test(u)) return 'enable_thinking'
  if (/api\.deepseek/.test(u)) return 'thinking_effort'
  if (/moonshot|bigmodel|zhipu|ark\.cn-beijing|volces/.test(u)) return 'thinking'
  // OpenRouter 用独立的 reasoning 对象，发 flat reasoning_effort 会被丢弃
  if (/openrouter/.test(u)) return 'reasoning_object'
  // OpenAI 官方域名不兜底：同一域名下既有 o 系列也有 gpt-4o 这类不接 reasoning_effort 的模型，
  // 只能靠模型名判定，否则每次请求都先白吃一个 400 再降级重试
  return 'none'
}

/**
 * 决定最终形态：
 * - off 永远不发；
 * - on 用户明确要思考，模型名认不出时用域名特征，再认不出就按最主流的 thinking.type 试；
 * - auto 只在特征命中时发，宁可不发也不要 400。
 */
export function resolveThinkingFamily(model: string, baseURL: string, mode: ThinkingMode): ThinkingFamily {
  if (mode === 'off') return 'none'
  const byModel = detectThinkingFamilyByModel(model)
  if (byModel !== 'none') return byModel
  const byURL = detectThinkingFamilyByBaseURL(baseURL)
  if (byURL !== 'none') return byURL
  return mode === 'on' ? 'thinking' : 'none'
}

/**
 * 生成请求体里的思考参数。
 * 通义系的 enable_thinking 在非流式下会直接被网关拒绝（要求必须 stream），
 * 所以该形态只在流式请求时携带。
 */
export function buildThinkingParams(
  model: string,
  baseURL: string,
  mode: ThinkingMode,
  stream: boolean
): Record<string, any> {
  const family = resolveThinkingFamily(model, baseURL, mode)
  switch (family) {
    case 'enable_thinking':
      return stream ? { enable_thinking: true } : {}
    case 'thinking':
      return { thinking: { type: 'enabled' } }
    case 'thinking_effort':
      // DeepSeek 思考版：开关 + 力度，力度取 high，避免默认值过于保守
      return { thinking: { type: 'enabled' }, reasoning_effort: 'high' }
    case 'reasoning_effort':
      return { reasoning_effort: 'medium' }
    case 'reasoning_object':
      return { reasoning: { enabled: true, effort: 'high' } }
    default:
      return {}
  }
}

/** 参数是否真的带了思考开关——没带就谈不上「因它被拒而降级重试」 */
export function hasThinkingParams(body: Record<string, any>): boolean {
  return body.enable_thinking !== undefined || body.thinking !== undefined
    || body.reasoning_effort !== undefined || body.reasoning !== undefined
}

/**
 * 判断一次失败是否像是「思考参数不被接受」：
 * 网关报错措辞五花八门，这里既认关键词也认状态码，命中才值得去掉参数重试一次。
 */
export function looksLikeThinkingRejected(status: number, errorText: string): boolean {
  const t = (errorText || '').toLowerCase()
  if (/enable_thinking|reasoning_effort|thinking|reasoner/.test(t)
    && /(unknown|unrecognized|unsupported|invalid|not support|doesn't support|do not support|extra inputs|unexpected|illegal)/.test(t)) {
    return true
  }
  return status === 400
}
