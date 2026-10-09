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
}

export interface LLMTestResult {
  success: boolean
  message: string
  latency?: number
  model?: string
}
