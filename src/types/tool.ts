/**
 * Function Call 工具定义 — OpenAI-compatible tools schema
 *
 * 定义了 LLM 工具调用的完整类型体系：
 * - ToolDefinition：工具描述（发给 LLM 的 JSON Schema）
 * - ToolCall：LLM 返回的工具调用请求
 * - ToolCallResult：工具执行后的结果
 */

/**
 * JSON Schema 类型（简化版，满足 OpenAI tools 需求）
 */
export interface JSONSchema {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array' | 'integer'
  description?: string
  properties?: Record<string, JSONSchema>
  required?: string[]
  items?: JSONSchema
  enum?: (string | number)[]
  default?: any
}

/**
 * 工具定义 — 描述一个可调用的工具（发给 LLM）
 */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: JSONSchema
  }
}

/**
 * LLM 返回的工具调用请求
 */
export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string // JSON 字符串
  }
}

/**
 * 工具执行结果
 */
export interface ToolCallResult {
  toolCallId: string
  functionName: string
  arguments: Record<string, any>
  result: any
  status: 'success' | 'error' | 'timeout'
  duration: number // 执行耗时（ms）
  error?: string
}

/**
 * 工具处理器函数类型
 */
export type ToolHandler = (args: Record<string, any>) => Promise<any>

/**
 * 工具调用状态（用于 UI 展示）
 */
export interface ToolCallStatus {
  toolCallId: string
  functionName: string
  status: 'calling' | 'executing' | 'completed' | 'error' | 'timeout'
  displayName: string // 中文显示名
  summary?: string // 结果摘要
  /** 文件变更 diff 数据（write_file 时捕获） */
  diffData?: {
    filePath: string
    oldContent: string
    newContent: string
    isNew: boolean  // true=新建文件, false=修改已有文件
  }
}
