import type { LLMProvider, LLMChatOptions } from './types'
import type { ChatMessage, ToolCall } from '@/types'

export class OpenAIProvider implements LLMProvider {
  private apiKey: string
  private baseURL: string
  private model: string

  constructor(apiKey: string, model: string, baseURL = 'https://api.openai.com/v1') {
    this.apiKey = apiKey
    this.model = model
    this.baseURL = baseURL
  }

  private buildRequestBody(messages: ChatMessage[], options?: LLMChatOptions) {
    const body: Record<string, any> = {
      model: this.model,
      messages,
      stream: options?.stream || false
    }
    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools
      body.tool_choice = options.toolChoice || 'auto'
    }
    return body
  }

  async chat(messages: ChatMessage[], options?: LLMChatOptions) {
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(this.buildRequestBody(messages, options))
    })

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`)
    }

    if (options?.stream) {
      return response.body as ReadableStream
    }

    const data = await response.json()
    return data.choices[0].message.content
  }

  async chatStream(messages: ChatMessage[], onChunk: (text: string) => void, options?: LLMChatOptions) {
    console.log('[chatStream] 开始, messages 数量:', messages.length)
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(this.buildRequestBody(messages, { ...options, stream: true }))
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(`API error ${response.status}: ${errorText || response.statusText}`)
    }

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let fullContent = ''
    let buffer = ''
    let dsmlDetected = false  // DSML 标记过滤
    let chunkCount = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunkCount++

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue

        const data = trimmed.slice(6)
        if (data === '[DONE]') continue

        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta?.content
          if (delta && !dsmlDetected) {
            // 检查当前 delta 是否包含 DSML
            const dsmlPos = this.findDSMLStart(delta)
            if (dsmlPos >= 0) {
              dsmlDetected = true
              if (dsmlPos > 0) {
                fullContent += delta.slice(0, dsmlPos)
              }
            } else {
              fullContent += delta
              // 跨 chunk 检测：检查尾部是否包含刚拼合完成的 DSML 标记
              const tailLen = Math.min(fullContent.length, 50)
              const tailStart = fullContent.length - tailLen
              const tail = fullContent.slice(tailStart)
              const crossPos = this.findDSMLStart(tail)
              if (crossPos >= 0 && crossPos < tailLen) {
                dsmlDetected = true
                fullContent = fullContent.slice(0, tailStart + crossPos)
              }
            }
            onChunk(fullContent)
          }
        } catch {
          // skip malformed JSON chunks
        }
      }
    }

    console.log('[chatStream] 完成, chunks:', chunkCount, '内容长度:', fullContent.length,
      'DSML检测:', dsmlDetected, '内容预览:', fullContent.slice(0, 100))
    return fullContent
  }

  /**
   * 带工具调用的流式对话
   * 当 LLM 返回 tool_calls 时，通过 onToolCalls 回调通知调用者
   */
  async chatStreamWithTools(
    messages: ChatMessage[],
    onChunk: (text: string) => void,
    onToolCalls: (toolCalls: ToolCall[]) => void,
    options?: LLMChatOptions
  ): Promise<string> {
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(this.buildRequestBody(messages, { ...options, stream: true }))
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(`API error ${response.status}: ${errorText || response.statusText}`)
    }

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let rawContent = ''       // 原始内容（含 DSML，用于 fallback 解析）
    let cleanContent = ''     // 过滤后的干净内容（用于 UI 展示）
    let fullContent = ''      // 最终返回内容
    let dsmlStarted = false   // DSML 标记已检测到，后续 content 不再累加到 cleanContent
    let buffer = ''
    const toolCallChunks = new Map<number, { id: string; name: string; arguments: string }>()
    let finishReason = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue

        const data = trimmed.slice(6)
        if (data === '[DONE]') continue

        try {
          const parsed = JSON.parse(data)
          const choice = parsed.choices?.[0]
          if (!choice) continue

          if (choice.finish_reason) {
            finishReason = choice.finish_reason
          }

          // 普通文本内容
          const delta = choice.delta?.content
          if (delta) {
            // 始终累加到 rawContent（用于 fallback 解析 DSML）
            rawContent += delta

            // 过滤 DSML 标记：DeepSeek V4 会在 content 中泄漏 DSML 标记
            if (!dsmlStarted) {
              // 先检查当前 delta 中是否有 DSML
              const dsmlPos = this.findDSMLStart(delta)
              if (dsmlPos >= 0) {
                dsmlStarted = true
                if (dsmlPos > 0) {
                  cleanContent += delta.slice(0, dsmlPos)
                }
                onChunk(cleanContent)
              } else {
                cleanContent += delta
                // 跨 chunk 检测：检查 cleanContent 尾部是否包含刚拼合完成的 DSML 标记
                // DSML 标记可能跨越多个流式 chunk，拼接后才能被检测到
                // 缓冲区需足够大以覆盖标记可能在尾部的位置（DSML标记+后续内容≤50字符）
                const tailLen = Math.min(cleanContent.length, 50)
                const tailStart = cleanContent.length - tailLen
                const tail = cleanContent.slice(tailStart)
                const crossDsmlPos = this.findDSMLStart(tail)
                if (crossDsmlPos >= 0 && crossDsmlPos < tailLen) {
                  // 跨 chunk 的 DSML 标记！截断到标记开始位置
                  dsmlStarted = true
                  cleanContent = cleanContent.slice(0, tailStart + crossDsmlPos)
                }
                onChunk(cleanContent)
              }
            }
            // dsmlStarted = true 后，不再往 cleanContent 添加任何内容
          }

          // 工具调用（DeepSeek V4 通过此通道返回正确的 JSON 格式）
          const tcChunks = choice.delta?.tool_calls
          if (tcChunks && Array.isArray(tcChunks)) {
            for (const chunk of tcChunks) {
              const idx = chunk.index
              if (!toolCallChunks.has(idx)) {
                toolCallChunks.set(idx, {
                  id: chunk.id || '',
                  name: chunk.function?.name || '',
                  arguments: ''
                })
              }
              const existing = toolCallChunks.get(idx)!
              if (chunk.id) existing.id = chunk.id
              if (chunk.function?.name) existing.name = chunk.function.name
              if (chunk.function?.arguments) {
                existing.arguments += chunk.function.arguments
              }
            }
          }

          // 调试日志
          if (choice.delta?.tool_calls || choice.finish_reason) {
            console.log('[chatStreamWithTools] chunk:', JSON.stringify({
              finish_reason: choice.finish_reason,
              has_tool_calls: !!choice.delta?.tool_calls,
              tool_calls_count: choice.delta?.tool_calls?.length,
              has_content: !!choice.delta?.content,
              dsml_detected: dsmlStarted
            }))
          }
        } catch {
          // skip malformed JSON chunks
        }
      }
    }

    // 流结束后，如果有 DSML 泄漏但 tool_calls 通道正常返回了数据
    if (dsmlStarted && toolCallChunks.size > 0) {
      console.log('[chatStreamWithTools] DSML 泄漏已过滤，tool_calls 正常解析')
    }

    // 调试：记录流结束时的状态
    console.log('[chatStreamWithTools] 流结束:', JSON.stringify({
      dsmlStarted,
      toolCallChunksSize: toolCallChunks.size,
      finishReason,
      rawContentLen: rawContent.length,
      cleanContentLen: cleanContent.length,
      rawContentPreview: rawContent.slice(0, 200)
    }))

    // 如果有工具调用（通过标准 tool_calls 通道），回调通知
    if (toolCallChunks.size > 0) {
      const toolCalls: ToolCall[] = Array.from(toolCallChunks.values()).map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: tc.arguments
        }
      }))
      // 确保 cleanContent 不含 DSML
      fullContent = cleanContent
      onToolCalls(toolCalls)
    } else {
      if (finishReason === 'tool_calls') {
        console.warn('[chatStreamWithTools] finish_reason=tool_calls 但未解析到工具调用')
      }
      // 回退：解析 rawContent 中的 DSML/XML 格式工具调用
      // 当 API 未通过 tool_calls 通道返回数据时（如本地部署、旧版本 API）
      const fallbackContent = rawContent || cleanContent
      console.log('[chatStreamWithTools] Fallback 解析: rawContent 长度=', rawContent.length, 'cleanContent 长度=', cleanContent.length)
      const xmlToolCalls = this.parseXmlToolCalls(fallbackContent)
      console.log('[chatStreamWithTools] Fallback 解析结果: 找到', xmlToolCalls.length, '个工具调用',
        xmlToolCalls.map(tc => tc.function.name).join(', '))
      if (xmlToolCalls.length > 0) {
        const normalized = this.normalizeToolCallMarkup(fallbackContent)
        fullContent = this.stripXmlToolCalls(normalized)
        onChunk(fullContent)
        onToolCalls(xmlToolCalls)
      } else {
        fullContent = cleanContent
      }
    }

    return fullContent
  }

  /**
   * 检测文本中是否包含 DeepSeek DSML 标记
   * DeepSeek V4 使用 DSML (DeepSeek Structured Markup Language) 作为内部工具调用格式
   * API 服务器会正确解析并通过 tool_calls 返回，但有时会泄漏到 content 中
   * 
   * 支持的标记变体（正则匹配，覆盖所有已知格式）：
   * - <｜DSML｜  (V3.2, 单全角竖线)
   * - <｜｜DSML｜｜ (V4, 双全角竖线)
   * - <‖DSML‖  (双竖线)
   * - <|DSML|   (ASCII 竖线)
   * - 以及任意混合管道字符的组合
   */
  private findDSMLStart(text: string): number {
    // 使用正则匹配所有 DSML 标记变体
    // [pipe_chars]+ = 任意组合的 | (U+007C), ｜ (U+FF5C), ‖ (U+2016)
    const re = /<[|\uFF5C\u2016]+DSML[|\uFF5C\u2016]*/
    const match = re.exec(text)
    return match ? match.index : -1
  }

  /**
   * 预处理：清理 DeepSeek DSML 标记（支持 V3.2 和 V4 格式）
   * 
   * V3.2 格式: <｜DSML｜tool_calls> / </｜DSML｜tool_calls>
   * V4 格式:   <｜｜DSML｜｜ calls> / </｜｜DSML｜｜ calls>
   *            <｜｜DSML｜｜ invoke name="X"> / </｜｜DSML｜｜ invoke>
   *            <｜｜DSML｜｜ parameter name="path" string="true">value</｜｜DSML｜｜ parameter>
   * 
   * 其中 < > 是正常角括号，｜ (U+FF5C) / ‖ (U+2016) / | (U+007C) 是模型内部 token
   * 闭合标签中管道字符替代了 /
   */
  private normalizeToolCallMarkup(content: string): string {
    let r = content
    const pipes = '[|\\uFF5C\\u2016]+'

    // P1: 将所有 DSML 标记统一转换为标准 XML
    //     策略：同标签名首次出现=开标签 <tag>，后续出现=闭标签 </tag>
    const tagSeen = new Map<string, boolean>()
    // 正则匹配所有 DSML 标签：<[pipes]DSML[pipes][space]tagname[rest]>
    const reTag = new RegExp('<' + pipes + 'DSML' + pipes + '\\s+(\\w+)([^>]*)>', 'g')
    r = r.replace(reTag, (_match: string, tagName: string, rest: string) => {
      const hasAttrs = rest.trim().length > 0
      if (hasAttrs) {
        // 有属性 → 一定是开标签，同时标记为已见
        tagSeen.set(tagName, true)
        return `<${tagName}${rest}>`
      }
      // 无属性 → 首次=开标签，后续=闭标签
      if (tagSeen.has(tagName)) {
        return `</${tagName}>`
      }
      tagSeen.set(tagName, true)
      return `<${tagName}>`
    })

    // P2: strip remaining DSML markers without space (e.g. <｜DSML｜tool_calls)
    const reMarker = new RegExp(pipes + 'DSML' + pipes, 'g')
    r = r.replace(reMarker, '')
    // P3: collapse whitespace after <
    r = r.replace(/<\s+([/a-zA-Z])/g, '<$1')
    // P4: fullwidth brackets
    r = r.replace(/\uFF1C/g, '<')
    r = r.replace(/\uFF1E/g, '>')
    return r
  }

  /**
   * 回退解析器：从文本中提取 XML 格式工具调用
   * 支持 JSON 格式和 XML invoke 格式
   */
  private parseXmlToolCalls(content: string): ToolCall[] {
    const normalized = this.normalizeToolCallMarkup(content)
    const toolCalls: ToolCall[] = []
    let idCounter = 0

    // JSON block strategy
    const jsonBlockRegex = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[^]*?\})\s*\}/g
    let match: RegExpExecArray | null
    while ((match = jsonBlockRegex.exec(normalized)) !== null) {
      toolCalls.push({
        id: `xml-tc-${++idCounter}`,
        type: 'function',
        function: { name: match[1], arguments: match[2] }
      })
    }
    if (toolCalls.length > 0) return toolCalls

    // XML invoke strategy - supports with/without closing tags
    const invokeRegex = /<invoke\s+name="([^"]+)">([\s\S]*?)(?:<\/invoke>|$)/g
    while ((match = invokeRegex.exec(normalized)) !== null) {
      const funcName = match[1]
      const inner = match[2]
      const args: Record<string, string> = {}
      const paramRegex = /<parameter\s+name="([^"]+)"[^>]*>([^<]*)/g
      let paramMatch: RegExpExecArray | null
      while ((paramMatch = paramRegex.exec(inner)) !== null) {
        const paramName = paramMatch[1]
        const val = paramMatch[2].trim()
        // 跳过 DSML V4 元数据属性（如 string="true"）
        if (paramName === 'string' || paramName === 'type') continue
        if (val) args[paramName] = val
      }
      if (Object.keys(args).length > 0) {
        toolCalls.push({
          id: `xml-tc-${++idCounter}`,
          type: 'function',
          function: { name: funcName, arguments: JSON.stringify(args) }
        })
      }
    }

    return toolCalls
  }

  /**
   * 从文本中去除 XML 工具调用部分
   * 支持 V3.2/V4 DSML normalize 后的标准 XML 格式
   */
  private stripXmlToolCalls(content: string): string {
    let stripped = content

    // 辅助函数：移除指定标签块（含不完整块）
    const removeBlocks = (openPrefix: string, closeTag: string) => {
      let si = stripped.indexOf(openPrefix)
      while (si !== -1) {
        const ei = stripped.indexOf(closeTag, si)
        if (ei !== -1) {
          stripped = stripped.slice(0, si) + stripped.slice(ei + closeTag.length)
        } else {
          // 不完整的块：截断到下一个标签或末尾
          const nextTag = stripped.indexOf('<', si + 1)
          if (nextTag !== -1) {
            stripped = stripped.slice(0, si) + stripped.slice(nextTag)
          } else {
            stripped = stripped.slice(0, si)
          }
        }
        si = stripped.indexOf(openPrefix)
      }
    }

    // 按优先级依次移除各类工具调用块
    removeBlocks('<' + 'calls>', '</' + 'calls>')
    removeBlocks('<' + 'tool_call', '</' + 'tool_call>')
    removeBlocks('<' + 'invoke', '</' + 'invoke>')
    removeBlocks('<' + 'tool_calls>', '</' + 'tool_calls>')
    removeBlocks('<' + 'function_calls>', '</' + 'function_calls>')

    // Remove JSON blocks
    stripped = stripped.replace(/\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[^]*?\}\s*\}/g, '')

    return stripped.trim()
  }
}
