import type { ChatMessage, ToolDefinition } from '@/types'

export interface LLMChatOptions {
  stream?: boolean
  tools?: ToolDefinition[]
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
}

export interface LLMProvider {
  chat(messages: ChatMessage[], options?: LLMChatOptions): Promise<string | ReadableStream>
  chatStream(messages: ChatMessage[], onChunk: (text: string) => void, options?: LLMChatOptions): Promise<string>
  /** 带工具调用的流式对话：支持 tool_calls 回调 */
  chatStreamWithTools(
    messages: ChatMessage[],
    onChunk: (text: string) => void,
    onToolCalls: (toolCalls: import('@/types').ToolCall[]) => void,
    options?: LLMChatOptions
  ): Promise<string>
}
