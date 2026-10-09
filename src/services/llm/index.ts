import type { LLMProvider } from './types'
import type { LLMConfig } from '@/types'
import { OpenAIProvider } from './openai'

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  claude: 'https://api.anthropic.com/v1',
  deepseek: 'https://api.deepseek.com',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  kimi: 'https://api.moonshot.cn/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  baichuan: 'https://api.baichuan-ai.com/v1',
  yi: 'https://api.lingyiwanwu.com/v1',
  spark: 'https://spark-api-open.xf-yun.com/v1',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  ernie: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop',
  mistral: 'https://api.mistral.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  ollama: 'http://localhost:11434/v1'
}

export function createProvider(config: LLMConfig): LLMProvider {
  const baseURL = config.baseURL || PROVIDER_BASE_URLS[config.provider] || PROVIDER_BASE_URLS.openai

  return new OpenAIProvider(
    config.apiKey || '',
    config.model,
    baseURL
  )
}
