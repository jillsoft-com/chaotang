import type { LLMConfig, LLMTestResult } from '@/types/llm'
import { ref } from 'vue'

class LLMService {
  private configs = ref<LLMConfig[]>([])

  constructor() {
    this.loadConfigs()
  }

  private loadConfigs() {
    const saved = localStorage.getItem('llm_configs')
    if (saved) {
      this.configs.value = JSON.parse(saved)
    } else {
      this.configs.value = [
        {
          id: 'default-openai',
          name: 'OpenAI GPT-4o Mini',
          provider: 'openai',
          model: 'gpt-4o-mini',
          isDefault: true
        }
      ]
      this.saveConfigs()
    }
  }

  private saveConfigs() {
    localStorage.setItem('llm_configs', JSON.stringify(this.configs.value))
  }

  getAll(): LLMConfig[] {
    return [...this.configs.value]
  }

  getById(id: string): LLMConfig | undefined {
    return this.configs.value.find(c => c.id === id)
  }

  add(config: Omit<LLMConfig, 'id'>): LLMConfig {
    const newConfig: LLMConfig = {
      ...config,
      id: `llm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    }
    this.configs.value.push(newConfig)
    this.saveConfigs()
    return newConfig
  }

  update(id: string, config: Partial<LLMConfig>): void {
    const index = this.configs.value.findIndex(c => c.id === id)
    if (index !== -1) {
      this.configs.value[index] = { ...this.configs.value[index], ...config }
      this.saveConfigs()
    }
  }

  delete(id: string): void {
    this.configs.value = this.configs.value.filter(c => c.id !== id)
    this.saveConfigs()
  }

  setDefault(id: string): void {
    this.configs.value.forEach(c => {
      c.isDefault = c.id === id
    })
    this.saveConfigs()
  }

  async fetchModels(config: Pick<LLMConfig, 'provider' | 'apiKey' | 'baseURL'>): Promise<{ success: boolean; models: string[]; message: string }> {
    let baseURL = config.baseURL
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }

    const providerBaseURLs: Record<string, string> = {
      openai: 'https://api.openai.com/v1',
      claude: 'https://api.anthropic.com/v1',
      deepseek: 'https://api.deepseek.com/v1',
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

    baseURL = baseURL || providerBaseURLs[config.provider] || providerBaseURLs.openai

    if (config.provider === 'claude' && config.apiKey) {
      headers['x-api-key'] = config.apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`
    }

    try {
      const response = await fetch(`${baseURL}/models`, {
        method: 'GET',
        headers
      })

      if (!response.ok) {
        return { success: false, models: [], message: `API 错误: ${response.status} - ${response.statusText}` }
      }

      const data = await response.json()

      if (data.data && Array.isArray(data.data)) {
        const models = data.data
          .map((m: any) => m.id || m.name)
          .filter(Boolean)
          .sort()
        return { success: true, models, message: `获取到 ${models.length} 个模型` }
      }

      return { success: false, models: [], message: '响应格式不支持' }
    } catch (error) {
      return { success: false, models: [], message: `获取失败: ${error instanceof Error ? error.message : '未知错误'}` }
    }
  }

  async test(config: LLMConfig): Promise<LLMTestResult> {
    const startTime = Date.now()

    try {
      const messages = [
        { role: 'user' as const, content: '请回复"测试成功"' }
      ]

      let baseURL = config.baseURL
      let headers: Record<string, string> = {
        'Content-Type': 'application/json'
      }

      const providerBaseURLs: Record<string, string> = {
        openai: 'https://api.openai.com/v1',
        claude: 'https://api.anthropic.com/v1',
        deepseek: 'https://api.deepseek.com/v1',
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
        ollama: 'http://localhost:11434/api'
      }

      baseURL = baseURL || providerBaseURLs[config.provider] || providerBaseURLs.openai

      // Claude 使用不同的认证方式
      if (config.provider === 'claude' && config.apiKey) {
        headers['x-api-key'] = config.apiKey
        headers['anthropic-version'] = '2023-06-01'
      } else if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`
      }

      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model,
          messages,
          max_tokens: config.maxTokens || 100,
          temperature: config.temperature || 0.7
        })
      })

      const latency = Date.now() - startTime

      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        return {
          success: false,
          message: `API 错误: ${response.status} - ${error.error?.message || response.statusText}`,
          latency
        }
      }

      const data = await response.json()
      
      if (data.choices && data.choices.length > 0) {
        return {
          success: true,
          message: '连接成功，LLM 可用',
          latency,
          model: data.model || config.model
        }
      } else {
        return {
          success: false,
          message: '响应格式错误',
          latency
        }
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        message: `连接失败: ${error instanceof Error ? error.message : '未知错误'}`,
        latency
      }
    }
  }
}

export const llmService = new LLMService()
