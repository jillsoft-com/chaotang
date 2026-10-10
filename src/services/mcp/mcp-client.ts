/**
 * MCP (Model Context Protocol) Client 服务
 *
 * 实现 MCP 协议客户端，支持通过 stdio 或 HTTP+SSE 传输连接外部 MCP Server。
 * 将 MCP Server 提供的工具转换为 OpenAI-compatible ToolDefinition，
 * 并注册到 skillRegistry，使大臣可以直接调用 MCP 工具。
 *
 * 协议参考：https://spec.modelcontextprotocol.io/
 */

import type { ToolDefinition, ToolHandler } from '@/types'

// ============ MCP 协议类型 ============

export interface MCPToolDefinition {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, any>
    required?: string[]
  }
}

export interface MCPServerConfig {
  id: string
  name: string
  transport: 'stdio' | 'sse'
  /** stdio 模式：命令和参数 */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** SSE 模式：服务地址 */
  url?: string
  /** 是否自动启动 */
  autoStart?: boolean
}

export interface MCPServerStatus {
  id: string
  name: string
  connected: boolean
  tools: MCPToolDefinition[]
  error?: string
  lastConnected?: number
}

type JsonRpcId = string | number

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: any
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: any
  error?: { code: number; message: string; data?: any }
}

// ============ MCP Client ============

/**
 * MCPClient — 管理单个 MCP Server 连接
 */
class MCPClient {
  private config: MCPServerConfig
  private requestId = 0
  private pendingRequests = new Map<JsonRpcId, {
    resolve: (value: any) => void
    reject: (error: Error) => void
  }>()
  private tools: MCPToolDefinition[] = []
  private connected = false
  private error?: string
  /** SSE 模式下的 EventSource */
  private eventSource: EventSource | null = null
  /** SSE 模式下发送消息的端点 URL */
  private messageEndpoint: string | null = null

  constructor(config: MCPServerConfig) {
    this.config = config
  }

  get status(): MCPServerStatus {
    return {
      id: this.config.id,
      name: this.config.name,
      connected: this.connected,
      tools: this.tools,
      error: this.error,
      lastConnected: this.connected ? Date.now() : undefined
    }
  }

  /**
   * 连接到 MCP Server
   * stdio 模式通过 Electron IPC 桥接，SSE 模式直接 HTTP
   */
  async connect(): Promise<MCPToolDefinition[]> {
    this.error = undefined

    try {
      if (this.config.transport === 'sse') {
        await this.connectSSE()
      } else {
        await this.connectStdio()
      }

      // 初始化握手
      await this.initialize()

      // 获取工具列表
      this.tools = await this.listTools()
      this.connected = true
      console.log(`[MCP] 已连接 "${this.config.name}"，发现 ${this.tools.length} 个工具`)
      return this.tools
    } catch (err) {
      this.error = err instanceof Error ? err.message : '连接失败'
      this.connected = false
      console.warn(`[MCP] 连接 "${this.config.name}" 失败:`, this.error)
      throw err
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
    }
    this.messageEndpoint = null
    this.connected = false
    this.tools = []
    // 清理 pending requests
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('已断开连接'))
    }
    this.pendingRequests.clear()
  }

  /**
   * 调用 MCP 工具
   */
  async callTool(name: string, args: Record<string, any>): Promise<any> {
    if (!this.connected) {
      throw new Error(`MCP Server "${this.config.name}" 未连接`)
    }
    const response = await this.sendRequest('tools/call', { name, arguments: args })
    return response
  }

  // ============ 传输层 ============

  /** SSE 传输：通过 HTTP 连接 */
  private async connectSSE(): Promise<void> {
    const baseUrl = this.config.url
    if (!baseUrl) throw new Error('SSE 模式需要指定 url')

    // 建立 SSE 连接
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('SSE 连接超时（10s）'))
      }, 10000)

      try {
        this.eventSource = new EventSource(`${baseUrl}/sse`)

        this.eventSource.addEventListener('endpoint', (event: MessageEvent) => {
          clearTimeout(timeout)
          // 服务端返回消息端点
          this.messageEndpoint = event.data
          resolve()
        })

        this.eventSource.addEventListener('message', (event: MessageEvent) => {
          try {
            const response: JsonRpcResponse = JSON.parse(event.data)
            this.handleResponse(response)
          } catch { /* 忽略非 JSON 消息 */ }
        })

        this.eventSource.onerror = () => {
          if (!this.connected) {
            clearTimeout(timeout)
            reject(new Error('SSE 连接失败'))
          }
        }
      } catch (err) {
        clearTimeout(timeout)
        reject(err)
      }
    })
  }

  /** stdio 传输：通过 Electron IPC 桥接 */
  private async connectStdio(): Promise<void> {
    if (!window.electronAPI?.executeCommand) {
      throw new Error('stdio 模式需要 Electron 环境')
    }
    // stdio 模式通过 Electron main process 桥接
    // 这里发送一个特殊 IPC 消息启动 MCP 进程
    // 实际实现在 electron/main.cjs 中
    // 暂时标记为已连接，后续在 Electron 端补充桥接逻辑
    this.connected = true
  }

  // ============ JSON-RPC ============

  private async sendRequest(method: string, params?: any): Promise<any> {
    const id = ++this.requestId
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`MCP 请求超时: ${method}`))
      }, 30000)

      this.pendingRequests.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value) },
        reject: (error) => { clearTimeout(timeout); reject(error) }
      })

      this.sendRaw(request)
    })
  }

  private sendRaw(request: JsonRpcRequest): void {
    const body = JSON.stringify(request)

    if (this.config.transport === 'sse' && this.messageEndpoint) {
      // SSE 模式：POST 到消息端点
      fetch(this.messageEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      }).catch(err => {
        console.warn('[MCP] SSE 发送失败:', err)
      })
    }
    // stdio 模式：通过 Electron IPC 发送（后续在 main.cjs 中实现）
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id)
    if (!pending) return
    this.pendingRequests.delete(response.id)

    if (response.error) {
      pending.reject(new Error(response.error.message || 'MCP 错误'))
    } else {
      pending.resolve(response.result)
    }
  }

  // ============ MCP 协议方法 ============

  private async initialize(): Promise<void> {
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'ChaoTang',
        version: '0.3.0'
      }
    })
    // 发送 initialized 通知
    this.sendRaw({
      jsonrpc: '2.0',
      id: 0,
      method: 'notifications/initialized'
    })
  }

  private async listTools(): Promise<MCPToolDefinition[]> {
    const result = await this.sendRequest('tools/list')
    return result?.tools || []
  }
}

// ============ MCP Service（全局管理） ============

class MCPService {
  private clients = new Map<string, MCPClient>()
  private configs: MCPServerConfig[] = []

  constructor() {
    this.loadConfigs()
  }

  /**
   * 获取所有已配置的 Server
   */
  getServers(): MCPServerStatus[] {
    return this.configs.map(c => {
      const client = this.clients.get(c.id)
      return client?.status || {
        id: c.id,
        name: c.name,
        connected: false,
        tools: [],
        error: '未连接'
      }
    })
  }

  /**
   * 添加并连接一个新的 MCP Server
   */
  async addServer(config: MCPServerConfig): Promise<MCPServerStatus> {
    // 保存配置
    if (!this.configs.find(c => c.id === config.id)) {
      this.configs.push(config)
      this.saveConfigs()
    }

    const client = new MCPClient(config)
    this.clients.set(config.id, client)

    await client.connect()
    return client.status
  }

  /**
   * 移除一个 MCP Server
   */
  async removeServer(id: string): Promise<void> {
    const client = this.clients.get(id)
    if (client) {
      await client.disconnect()
      this.clients.delete(id)
    }
    this.configs = this.configs.filter(c => c.id !== id)
    this.saveConfigs()
  }

  /**
   * 连接所有已配置的 Server
   */
  async connectAll(): Promise<void> {
    const results = await Promise.allSettled(
      this.configs.map(async (config) => {
        if (this.clients.has(config.id)) return
        const client = new MCPClient(config)
        this.clients.set(config.id, client)
        await client.connect()
      })
    )
    const failed = results.filter(r => r.status === 'rejected')
    if (failed.length > 0) {
      console.warn(`[MCP] ${failed.length}/${this.configs.length} 个 Server 连接失败`)
    }
  }

  /**
   * 断开所有连接
   */
  async disconnectAll(): Promise<void> {
    await Promise.all(
      Array.from(this.clients.values()).map(c => c.disconnect())
    )
    this.clients.clear()
  }

  /**
   * 获取所有已连接 Server 的工具（转换为 OpenAI ToolDefinition 格式）
   */
  getAllToolDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = []
    for (const [, client] of this.clients) {
      if (!client.status.connected) continue
      for (const mcpTool of client.status.tools) {
        defs.push(this.mcpToolToOpenAI(mcpTool, client.status.id))
      }
    }
    return defs
  }

  /**
   * 获取所有 MCP 工具处理器（functionName → handler 映射）
   */
  getAllHandlers(): Record<string, ToolHandler> {
    const handlers: Record<string, ToolHandler> = {}
    for (const [, client] of this.clients) {
      if (!client.status.connected) continue
      for (const mcpTool of client.status.tools) {
        const fnName = `mcp_${client.status.id}_${mcpTool.name}`
        handlers[fnName] = async (args) => {
          return client.callTool(mcpTool.name, args)
        }
      }
    }
    return handlers
  }

  /**
   * 将 MCP 工具定义转换为 OpenAI ToolDefinition
   */
  private mcpToolToOpenAI(mcpTool: MCPToolDefinition, serverId: string): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: `mcp_${serverId}_${mcpTool.name}`,
        description: `[MCP:${serverId}] ${mcpTool.description || mcpTool.name}`,
        parameters: {
          type: 'object',
          properties: mcpTool.inputSchema.properties || {},
          required: mcpTool.inputSchema.required
        }
      }
    }
  }

  // ============ 持久化 ============

  private loadConfigs(): void {
    try {
      const saved = localStorage.getItem('mcp_servers')
      if (saved) {
        this.configs = JSON.parse(saved)
      }
    } catch { /* 解析失败使用空数组 */ }
  }

  private saveConfigs(): void {
    localStorage.setItem('mcp_servers', JSON.stringify(this.configs))
  }
}

/** 全局 MCP 服务单例 */
export const mcpService = new MCPService()
