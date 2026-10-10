/**
 * 多模态增强 — 图像分析、文档增强、语音合成
 *
 * 扩展现有 browser / document 能力，增加：
 * 1. 图像分析：将 base64 图片发送给多模态 LLM 进行描述/OCR
 * 2. 文档增强：Markdown → HTML 渲染提示
 * 3. 语音合成（TTS）：使用浏览器 Web Speech API
 *
 * Sprint D - #16
 */

import type { LLMConfig } from '@/types'
import { createProvider } from '@/services/llm'

// ============ 图像分析 ============

export interface ImageAnalysisResult {
  description: string
  ocrText?: string
  objects?: string[]
  colors?: string[]
}

/**
 * 分析图像内容（需要多模态 LLM 支持）
 * @param imageBase64 base64 编码的图片数据
 * @param prompt 分析提示词
 * @param llmConfig LLM 配置（需要支持视觉的模型）
 */
export async function analyzeImage(
  imageBase64: string,
  prompt: string = '请描述这张图片的内容，包括主要对象、文字和颜色。',
  llmConfig: LLMConfig
): Promise<ImageAnalysisResult> {
  const provider = createProvider(llmConfig)

  // 构建包含图片的消息
  const messages = [
    {
      role: 'user' as const,
      content: `${prompt}\n\n[图片数据: base64, ${imageBase64.length} bytes]`
    }
  ]

  try {
    const response = await provider.chatStream(messages, () => {})
    return {
      description: response,
      ocrText: extractOCRText(response),
      objects: extractObjects(response),
      colors: extractColors(response)
    }
  } catch (error) {
    return {
      description: `[图像分析失败] ${error instanceof Error ? error.message : '未知错误'}`
    }
  }
}

/**
 * 从分析结果中提取 OCR 文本
 */
function extractOCRText(text: string): string | undefined {
  const match = text.match(/(?:文字|text|OCR)[：:]\s*([\s\S]+?)(?=\n\n|$)/i)
  return match?.[1]?.trim()
}

/**
 * 从分析结果中提取对象列表
 */
function extractObjects(text: string): string[] | undefined {
  const match = text.match(/(?:对象|objects?|物体)[：:]\s*([\s\S]+?)(?=\n\n|$)/i)
  if (!match) return undefined
  return match[1].split(/[,，、\n]/).map(s => s.trim()).filter(Boolean)
}

/**
 * 从分析结果中提取颜色
 */
function extractColors(text: string): string[] | undefined {
  const match = text.match(/(?:颜色|colors?)[：:]\s*([\s\S]+?)(?=\n\n|$)/i)
  if (!match) return undefined
  return match[1].split(/[,，、\n]/).map(s => s.trim()).filter(Boolean)
}

// ============ 语音合成 (TTS) ============

export interface TTSOptions {
  /** 语速 0.5-2.0，默认 1.0 */
  rate?: number
  /** 音调 0-2，默认 1.0 */
  pitch?: number
  /** 音量 0-1，默认 1.0 */
  volume?: number
  /** 语言，默认 'zh-CN' */
  lang?: string
  /** 语音名称（可选） */
  voice?: string
}

/**
 * 检查浏览器是否支持 TTS
 */
export function isTTSAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/**
 * 获取可用的语音列表
 */
export function getAvailableVoices(): SpeechSynthesisVoice[] {
  if (!isTTSAvailable()) return []
  return window.speechSynthesis.getVoices()
}

/**
 * 朗读文本
 */
export function speak(text: string, options?: TTSOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isTTSAvailable()) {
      reject(new Error('当前浏览器不支持语音合成'))
      return
    }

    // 停止当前朗读
    window.speechSynthesis.cancel()

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = options?.rate ?? 1.0
    utterance.pitch = options?.pitch ?? 1.0
    utterance.volume = options?.volume ?? 1.0
    utterance.lang = options?.lang ?? 'zh-CN'

    // 设置语音
    if (options?.voice) {
      const voices = getAvailableVoices()
      const selected = voices.find(v => v.name === options.voice)
      if (selected) utterance.voice = selected
    }

    utterance.onend = () => resolve()
    utterance.onerror = (e) => reject(new Error(`语音合成失败: ${e.error}`))

    window.speechSynthesis.speak(utterance)
  })
}

/**
 * 停止朗读
 */
export function stopSpeaking(): void {
  if (isTTSAvailable()) {
    window.speechSynthesis.cancel()
  }
}

/**
 * 暂停朗读
 */
export function pauseSpeaking(): void {
  if (isTTSAvailable()) {
    window.speechSynthesis.pause()
  }
}

/**
 * 恢复朗读
 */
export function resumeSpeaking(): void {
  if (isTTSAvailable()) {
    window.speechSynthesis.resume()
  }
}

// ============ 文档增强 ============

/**
 * 将 Markdown 转换为增强格式（用于圣旨播报等场景）
 */
export function enhanceMarkdown(markdown: string): string {
  // 提取关键句子（用于 TTS 播报）
  const sentences = markdown
    .replace(/#+\s/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .split(/[。！？\n]/)
    .map(s => s.trim())
    .filter(s => s.length > 5 && s.length < 200)

  return sentences.slice(0, 10).join('。') + '。'
}

/**
 * 生成语音播报文本（从圣旨/决策报告）
 */
export function generateSpeechText(
  title: string,
  content: string,
  style: 'formal' | 'casual' = 'formal'
): string {
  const enhanced = enhanceMarkdown(content)

  if (style === 'formal') {
    return `圣旨宣读。\n${title}。\n${enhanced}\n宣读完毕。`
  }
  return `${title}。${enhanced}`
}
