import type { ThinkingMode } from './index'

export type { ThinkingMode }

export type LLMProviderType =
  | 'openai' | 'claude' | 'deepseek' | 'ollama'
  | 'qwen' | 'kimi' | 'zhipu' | 'gemini'
  | 'baichuan' | 'yi' | 'spark' | 'doubao' | 'ernie'
  | 'mistral' | 'groq'

export interface LLMConfig {
  id: string
  name: string
  provider: LLMProviderType
  model: string
  apiKey?: string
  baseURL?: string
  temperature?: number
  maxTokens?: number
  isDefault?: boolean
  /** 模型支持图片识别（多模态视觉），如 gpt-4o / qwen-vl / glm-4v */
  supportsVision?: boolean
  /**
   * 思考模式（推理模型）：
   * - auto（默认，不设置即等价于 auto）：命中模型名或网关域名特征时才下发思考开关
   * - on：强制下发思考开关，用于模型名被代理改写、特征认不出的自建网关
   * - off：强制关闭，执行过程只看工具行
   */
  thinkingMode?: ThinkingMode
}

export interface LLMTestResult {
  success: boolean
  message: string
  latency?: number
  model?: string
}
