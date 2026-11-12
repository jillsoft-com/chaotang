/**
 * llm/thinking.ts - 推理模型「思考开关」判定测试
 *
 * 锁定的真实缺陷：请求体里从来没带过思考开关，服务端便一直走非思考模式，
 * 不下发 reasoning_content；而模型发起 tool_calls 时正文 content 常常为空，
 * exec-timeline.endThink 又把「文本为空」的思考段整段删掉，
 * 于是执行过程只剩一串工具行（执行命令/文件读取/代码搜索），看不见「已思考」。
 *
 * 另一头，各家网关字段不统一且对未识别字段直接 400，
 * 所以判定必须保守：认不出来就不发，认出来才发对应形态。
 */

import { describe, it, expect } from 'vitest'
import {
  detectThinkingFamilyByModel,
  detectThinkingFamilyByBaseURL,
  resolveThinkingFamily,
  buildThinkingParams,
  hasThinkingParams,
  looksLikeThinkingRejected
} from '@/services/llm/thinking'

describe('detectThinkingFamilyByModel - 按模型名认形态', () => {
  it('通义混合思考系列只认 enable_thinking', () => {
    expect(detectThinkingFamilyByModel('qwen3-235b-a22b')).toBe('enable_thinking')
    expect(detectThinkingFamilyByModel('qwq-32b')).toBe('enable_thinking')
    expect(detectThinkingFamilyByModel('qvq-720b-preview')).toBe('enable_thinking')
  })

  it('DeepSeek 推理系列带开关与力度', () => {
    expect(detectThinkingFamilyByModel('deepseek-v4-pro')).toBe('thinking_effort')
    expect(detectThinkingFamilyByModel('deepseek-r1')).toBe('thinking_effort')
    expect(detectThinkingFamilyByModel('deepseek-chat')).toBe('none')
  })

  it('-thinking 后缀走 thinking.type', () => {
    expect(detectThinkingFamilyByModel('glm-4.5-thinking')).toBe('thinking')
    expect(detectThinkingFamilyByModel('kimi-k2.5-thinking')).toBe('thinking')
  })

  it('OpenAI 推理系列只认 reasoning_effort', () => {
    expect(detectThinkingFamilyByModel('o3-mini')).toBe('reasoning_effort')
    expect(detectThinkingFamilyByModel('gpt-5')).toBe('reasoning_effort')
    // gpt-4o 里的 o 紧跟数字，不构成独立词，不能被误判成推理模型
    expect(detectThinkingFamilyByModel('gpt-4o-mini')).toBe('none')
  })

  it('普通模型一律不发（宁可不发，也不要 400）', () => {
    expect(detectThinkingFamilyByModel('gpt-4o-mini')).toBe('none')
    expect(detectThinkingFamilyByModel('claude-sonnet-4')).toBe('none')
    expect(detectThinkingFamilyByModel('my-gateway')).toBe('none')
    expect(detectThinkingFamilyByModel('')).toBe('none')
  })
})

describe('detectThinkingFamilyByBaseURL - 模型名认不出时按网关兜底', () => {
  it('域名特征映射到各家字段', () => {
    expect(detectThinkingFamilyByBaseURL('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('enable_thinking')
    expect(detectThinkingFamilyByBaseURL('https://api.deepseek.com')).toBe('thinking_effort')
    expect(detectThinkingFamilyByBaseURL('https://api.moonshot.cn/v1')).toBe('thinking')
    expect(detectThinkingFamilyByBaseURL('https://open.bigmodel.cn/api/paas/v4')).toBe('thinking')
    expect(detectThinkingFamilyByBaseURL('https://openrouter.ai/api/v1')).toBe('reasoning_object')
    expect(detectThinkingFamilyByBaseURL('http://localhost:11434/v1')).toBe('none')
  })

  it('OpenAI 官方域名不兜底：同域名下混着 gpt-4o 这类不接 reasoning_effort 的模型', () => {
    expect(detectThinkingFamilyByBaseURL('https://api.openai.com/v1')).toBe('none')
    // 但模型名命中仍然生效
    expect(resolveThinkingFamily('o3-mini', 'https://api.openai.com/v1', 'auto')).toBe('reasoning_effort')
    expect(resolveThinkingFamily('gpt-4o-mini', 'https://api.openai.com/v1', 'auto')).toBe('none')
  })

  it('模型名被代理改写（认不出）时，auto 仍可靠域名命中', () => {
    expect(resolveThinkingFamily('my-gateway', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'auto')).toBe('enable_thinking')
  })

  it('模型名优先于域名：qwen 模型走自建代理也不应被域名带偏', () => {
    expect(resolveThinkingFamily('qwen3-max', 'https://api.openai.com/v1', 'auto')).toBe('enable_thinking')
  })

  it('强制模式：认不出时按最主流的 thinking.type 试一次', () => {
    expect(resolveThinkingFamily('my-gateway', 'http://internal-proxy.local/v1', 'on')).toBe('thinking')
  })

  it('关闭模式压倒一切特征', () => {
    expect(resolveThinkingFamily('deepseek-v4-pro', 'https://api.deepseek.com', 'off')).toBe('none')
  })
})

describe('buildThinkingParams - 生成请求参数', () => {
  it('enable_thinking 只在流式下携带（非流式会被网关直接拒绝）', () => {
    expect(buildThinkingParams('qwen3-max', '', 'auto', true)).toEqual({ enable_thinking: true })
    expect(buildThinkingParams('qwen3-max', '', 'auto', false)).toEqual({})
  })

  it('DeepSeek 形态同时给开关与力度', () => {
    expect(buildThinkingParams('deepseek-v4-pro', '', 'auto', true)).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high'
    })
  })

  it('OpenAI 形态给 reasoning_effort，不发 thinking（会被拒）', () => {
    expect(buildThinkingParams('o3-mini', '', 'auto', true)).toEqual({ reasoning_effort: 'medium' })
  })

  it('OpenRouter 用独立 reasoning 对象，flat reasoning_effort 会被它丢掉', () => {
    expect(resolveThinkingFamily('any-model', 'https://openrouter.ai/api/v1', 'auto')).toBe('reasoning_object')
    expect(buildThinkingParams('any-model', 'https://openrouter.ai/api/v1', 'auto', true)).toEqual({
      reasoning: { enabled: true, effort: 'high' }
    })
  })

  it('认不出来时不给任何参数，保持旧行为', () => {
    expect(buildThinkingParams('gpt-4o-mini', 'https://api.openai.com/v1', 'auto', true)).toEqual({})
  })
})

describe('降级重试判定', () => {
  it('hasThinkingParams 只在真的带参数时为真', () => {
    expect(hasThinkingParams({ model: 'x', thinking: { type: 'enabled' } })).toBe(true)
    expect(hasThinkingParams({ model: 'x', enable_thinking: true })).toBe(true)
    expect(hasThinkingParams({ model: 'x', reasoning_effort: 'medium' })).toBe(true)
    expect(hasThinkingParams({ model: 'x', reasoning: { enabled: true } })).toBe(true)
    expect(hasThinkingParams({ model: 'x', stream: true })).toBe(false)
  })

  it('报错措辞提到思考字段，或网关回了 400，都值得去掉参数重试', () => {
    expect(looksLikeThinkingRejected(400, 'Unrecognized fields: "enable_thinking"')).toBe(true)
    expect(looksLikeThinkingRejected(400, 'This model does not support reasoning_effort')).toBe(true)
    expect(looksLikeThinkingRejected(400, 'invalid api key')).toBe(true)
    // 5xx 与鉴权类错误去掉参数也没用，不该白发一次请求
    expect(looksLikeThinkingRejected(502, 'Bad Gateway')).toBe(false)
    expect(looksLikeThinkingRejected(401, 'Unauthorized')).toBe(false)
  })
})
