/**
 * ToolExecutor — 工具执行引擎
 *
 * 负责：
 * 1. 注册工具处理器（ToolHandler）
 * 2. 执行 LLM 返回的 ToolCall
 * 3. 超时控制和安全限制
 * 4. 工具调用事件通知（供 UI 监听）
 */

import type { ToolCall, ToolCallResult, ToolHandler, ToolCallStatus, ToolDefinition } from '@/types'

/** 工具注册条目 */
interface RegisteredTool {
  definition: ToolDefinition
  handler: ToolHandler
  displayName: string // 中文显示名
  timeout: number     // 超时时间（ms）
}

/** 工具调用事件类型 */
export type ToolEventType = 'calling' | 'executing' | 'completed' | 'error' | 'timeout'

/** 工具调用事件回调 */
export type ToolEventCallback = (status: ToolCallStatus) => void

/** 默认超时 30 秒 */
const DEFAULT_TIMEOUT = 30000

export class ToolExecutor {
  private tools = new Map<string, RegisteredTool>()
  private eventListeners: ToolEventCallback[] = []

  /**
   * 注册一个工具
   */
  register(definition: ToolDefinition, handler: ToolHandler, options?: {
    displayName?: string
    timeout?: number
  }): void {
    this.tools.set(definition.function.name, {
      definition,
      handler,
      displayName: options?.displayName || definition.function.name,
      timeout: options?.timeout || DEFAULT_TIMEOUT
    })
  }

  /**
   * 注销一个工具
   */
  unregister(name: string): void {
    this.tools.delete(name)
  }

  /**
   * 获取所有已注册的工具定义（发给 LLM）
   */
  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition)
  }

  /**
   * 获取指定名称的工具定义
   */
  getToolDefinition(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition
  }

  /**
   * 检查工具是否已注册
   */
  hasTool(name: string): boolean {
    return this.tools.has(name)
  }

  /**
   * 添加事件监听器
   */
  onToolEvent(callback: ToolEventCallback): () => void {
    this.eventListeners.push(callback)
    return () => {
      this.eventListeners = this.eventListeners.filter(cb => cb !== callback)
    }
  }

  /**
   * 触发工具事件
   */
  private emitEvent(status: ToolCallStatus): void {
    for (const listener of this.eventListeners) {
      listener(status)
    }
  }

  /**
   * 执行单个工具调用
   */
  async execute(toolCall: ToolCall): Promise<ToolCallResult> {
    const toolName = toolCall.function.name
    const registered = this.tools.get(toolName)

    // 解析参数
    let args: Record<string, any> = {}
    try {
      args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {}
    } catch {
      return {
        toolCallId: toolCall.id,
        functionName: toolName,
        arguments: {},
        result: null,
        status: 'error',
        duration: 0,
        error: `参数解析失败: ${toolCall.function.arguments}`
      }
    }

    // 工具不存在
    if (!registered) {
      return {
        toolCallId: toolCall.id,
        functionName: toolName,
        arguments: args,
        result: null,
        status: 'error',
        duration: 0,
        error: `工具未注册: ${toolName}`
      }
    }

    // 通知：开始调用
    this.emitEvent({
      toolCallId: toolCall.id,
      functionName: toolName,
      status: 'calling',
      displayName: registered.displayName
    })

    const startTime = Date.now()

    // 带超时的执行
    try {
      const result = await this.executeWithTimeout(
        registered.handler,
        args,
        registered.timeout
      )

      const duration = Date.now() - startTime

      // 通知：执行完成
      const summary = this.buildResultSummary(registered.displayName, result)
      this.emitEvent({
        toolCallId: toolCall.id,
        functionName: toolName,
        status: 'completed',
        displayName: registered.displayName,
        summary
      })

      return {
        toolCallId: toolCall.id,
        functionName: toolName,
        arguments: args,
        result,
        status: 'success',
        duration
      }
    } catch (error) {
      const duration = Date.now() - startTime
      const isTimeout = error instanceof Error && error.message === 'TOOL_TIMEOUT'
      const status = isTimeout ? 'timeout' : 'error'
      const errorMessage = isTimeout
        ? `工具执行超时（${registered.timeout}ms）`
        : (error instanceof Error ? error.message : '未知错误')

      // 通知：执行失败
      this.emitEvent({
        toolCallId: toolCall.id,
        functionName: toolName,
        status,
        displayName: registered.displayName,
        summary: errorMessage
      })

      return {
        toolCallId: toolCall.id,
        functionName: toolName,
        arguments: args,
        result: null,
        status,
        duration,
        error: errorMessage
      }
    }
  }

  /**
   * 批量执行工具调用（并行）
   */
  async executeBatch(toolCalls: ToolCall[]): Promise<ToolCallResult[]> {
    return Promise.all(toolCalls.map(tc => this.execute(tc)))
  }

  /**
   * 带超时控制的执行包装
   */
  private executeWithTimeout(
    handler: ToolHandler,
    args: Record<string, any>,
    timeout: number
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('TOOL_TIMEOUT'))
      }, timeout)

      handler(args)
        .then(result => {
          clearTimeout(timer)
          resolve(result)
        })
        .catch(error => {
          clearTimeout(timer)
          reject(error)
        })
    })
  }

  /**
   * 构建结果摘要（供 UI 展示）
   */
  private buildResultSummary(_displayName: string, result: any): string {
    if (result === null || result === undefined) return '无结果'
    if (typeof result === 'string') {
      return result.length > 80 ? result.slice(0, 80) + '...' : result
    }
    if (typeof result === 'object') {
      const str = JSON.stringify(result)
      return str.length > 80 ? str.slice(0, 80) + '...' : str
    }
    return String(result)
  }
}

/** 全局 ToolExecutor 单例 */
export const toolExecutor = new ToolExecutor()
