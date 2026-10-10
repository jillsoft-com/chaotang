/**
 * A2A (Agent-to-Agent) 协议 — 跨 Agent 任务派发
 *
 * 实现与外部 Agent（Codex、Hermes、Qoder 等）互派任务。
 * 遵循 Google A2A 协议规范核心概念：
 * - Agent Card：描述 Agent 能力
 * - Task：跨 Agent 任务
 * - Message / Artifact：通信和产出物
 *
 * 协议参考：https://google.github.io/A2A/
 *
 * Sprint C - #21
 */

// ============ 类型 ============

/** A2A Agent 能力描述卡片 */
export interface A2AAgentCard {
  /** Agent 唯一标识 */
  id: string
  /** Agent 名称 */
  name: string
  /** Agent 描述 */
  description: string
  /** 版本 */
  version: string
  /** 支持的能力 */
  capabilities: {
    streaming?: boolean
    pushNotifications?: boolean
    stateTransitionHistory?: boolean
  }
  /** 技能列表 */
  skills: A2ASkill[]
  /** 通信端点 */
  endpoint: string
  /** 认证方式 */
  authentication?: {
    schemes: string[]
  }
}

/** A2A 技能描述 */
export interface A2ASkill {
  id: string
  name: string
  description: string
  tags: string[]
  examples?: string[]
}

/** A2A 任务状态 */
export type A2ATaskState = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled'

/** A2A 任务 */
export interface A2ATask {
  id: string
  /** 来源 Agent */
  sourceAgent: string
  /** 目标 Agent */
  targetAgent: string
  /** 任务描述 */
  description: string
  /** 状态 */
  state: A2ATaskState
  /** 创建时间 */
  createdAt: number
  /** 最后更新时间 */
  updatedAt: number
  /** 消息历史 */
  messages: A2AMessage[]
  /** 产出物 */
  artifacts: A2AArtifact[]
  /** 元数据 */
  metadata?: Record<string, any>
}

/** A2A 消息 */
export interface A2AMessage {
  role: 'user' | 'agent'
  parts: A2APart[]
  metadata?: Record<string, any>
}

/** A2A 消息部件 */
export interface A2APart {
  type: 'text' | 'file' | 'data'
  text?: string
  file?: {
    name: string
    mimeType: string
    uri?: string
    bytes?: string  // base64
  }
  data?: Record<string, any>
}

/** A2A 产出物 */
export interface A2AArtifact {
  name: string
  description?: string
  parts: A2APart[]
  completed: boolean
  metadata?: Record<string, any>
}

/** 远程 Agent 注册信息 */
export interface RemoteAgent {
  card: A2AAgentCard
  /** 最近活跃时间 */
  lastSeen: number
  /** 连接状态 */
  connected: boolean
}

// ============ A2A 协议客户端 ============

class A2AService {
  private remoteAgents = new Map<string, RemoteAgent>()
  private tasks = new Map<string, A2ATask>()
  private localCard: A2AAgentCard

  constructor() {
    // 初始化本地 Agent Card
    this.localCard = {
      id: 'chaotang',
      name: '朝堂 (ChaoTang)',
      description: '多角色辩论式 AI 决策辅助平台，支持六位大臣（丞相/户部/太傅/大将军/御史/总管）从不同立场分析议题并生成结构化决策报告。',
      version: '0.3.0',
      capabilities: {
        streaming: true,
        pushNotifications: false,
        stateTransitionHistory: true
      },
      skills: [
        {
          id: 'debate',
          name: '多角色辩论',
          description: '发起朝议，让多位大臣从不同角度分析议题并生成决策报告',
          tags: ['debate', 'decision', 'analysis'],
          examples: ['技术方案评审', '产品取舍', '投资分析']
        },
        {
          id: 'code-analysis',
          name: '代码分析',
          description: '分析项目代码结构、发现问题、提出重构建议',
          tags: ['code', 'analysis', 'refactor'],
          examples: ['代码审查', '架构评估']
        },
        {
          id: 'document-analysis',
          name: '文档解析',
          description: '解析 PDF/Word/Excel 等文档并提取关键信息',
          tags: ['document', 'pdf', 'analysis'],
          examples: ['合同审查', '财报分析']
        }
      ],
      endpoint: 'http://localhost:0/a2a',
      authentication: {
        schemes: ['none']
      }
    }

    this.loadRemoteAgents()
    this.loadTasks()
  }

  // ============ Agent 管理 ============

  /**
   * 获取本地 Agent Card
   */
  getLocalCard(): A2AAgentCard {
    return this.localCard
  }

  /**
   * 注册一个远程 Agent
   */
  registerAgent(card: A2AAgentCard): void {
    this.remoteAgents.set(card.id, {
      card,
      lastSeen: Date.now(),
      connected: true
    })
    this.saveRemoteAgents()
  }

  /**
   * 发现远程 Agent（通过 URL 获取 Agent Card）
   */
  async discoverAgent(url: string): Promise<A2AAgentCard> {
    try {
      const response = await fetch(`${url}/.well-known/agent.json`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const card: A2AAgentCard = await response.json()
      this.registerAgent(card)
      return card
    } catch (error) {
      throw new Error(`发现 Agent 失败: ${error instanceof Error ? error.message : url}`)
    }
  }

  /**
   * 获取所有已注册的远程 Agent
   */
  getRemoteAgents(): RemoteAgent[] {
    return Array.from(this.remoteAgents.values())
      .sort((a, b) => b.lastSeen - a.lastSeen)
  }

  /**
   * 移除远程 Agent
   */
  removeAgent(agentId: string): void {
    this.remoteAgents.delete(agentId)
    this.saveRemoteAgents()
  }

  // ============ 任务管理 ============

  /**
   * 向远程 Agent 派发任务
   */
  async dispatchTask(params: {
    targetAgentId: string
    description: string
    context?: string
    payload?: Record<string, any>
  }): Promise<A2ATask> {
    const agent = this.remoteAgents.get(params.targetAgentId)
    if (!agent) throw new Error(`Agent 不存在: ${params.targetAgentId}`)

    const task: A2ATask = {
      id: `a2a_task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      sourceAgent: this.localCard.id,
      targetAgent: params.targetAgentId,
      description: params.description,
      state: 'submitted',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [
        {
          role: 'user',
          parts: [
            { type: 'text', text: params.description },
            ...(params.context ? [{ type: 'text' as const, text: params.context }] : [])
          ],
          metadata: params.payload
        }
      ],
      artifacts: []
    }

    this.tasks.set(task.id, task)
    this.saveTasks()

    // 发送任务到远程 Agent
    try {
      const response = await fetch(`${agent.card.endpoint}/tasks/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: task.id,
          message: task.messages[0]
        })
      })

      if (response.ok) {
        const result = await response.json()
        task.state = result.state || 'working'
        if (result.artifacts) {
          task.artifacts = result.artifacts
        }
        if (result.message) {
          task.messages.push(result.message)
        }
      } else {
        task.state = 'failed'
        task.metadata = { error: `HTTP ${response.status}` }
      }
    } catch (error) {
      // 网络不可达，标记为 submitted（本地排队）
      task.metadata = { offline: true, error: error instanceof Error ? error.message : '' }
    }

    task.updatedAt = Date.now()
    this.saveTasks()
    return task
  }

  /**
   * 处理来自远程 Agent 的入站任务
   * 将任务转化为朝堂朝议
   */
  handleInboundTask(params: {
    sourceAgent: string
    description: string
    payload?: Record<string, any>
  }): A2ATask {
    const task: A2ATask = {
      id: `a2a_inbound_${Date.now()}`,
      sourceAgent: params.sourceAgent,
      targetAgent: this.localCard.id,
      description: params.description,
      state: 'working',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [
        {
          role: 'user',
          parts: [{ type: 'text', text: params.description }]
        }
      ],
      artifacts: [],
      metadata: params.payload
    }

    this.tasks.set(task.id, task)
    this.saveTasks()
    return task
  }

  /**
   * 获取所有任务
   */
  getTasks(): A2ATask[] {
    return Array.from(this.tasks.values())
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * 获取指定任务
   */
  getTask(taskId: string): A2ATask | undefined {
    return this.tasks.get(taskId)
  }

  /**
   * 取消任务
   */
  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false
    task.state = 'canceled'
    task.updatedAt = Date.now()
    this.saveTasks()
    return true
  }

  // ============ 持久化 ============

  private loadRemoteAgents(): void {
    try {
      const saved = localStorage.getItem('a2a_remote_agents')
      if (saved) {
        const arr: RemoteAgent[] = JSON.parse(saved)
        for (const agent of arr) {
          agent.connected = false // 启动时默认离线
          this.remoteAgents.set(agent.card.id, agent)
        }
      }
    } catch { /* 解析失败使用空集合 */ }
  }

  private saveRemoteAgents(): void {
    const arr = Array.from(this.remoteAgents.values())
    localStorage.setItem('a2a_remote_agents', JSON.stringify(arr))
  }

  private loadTasks(): void {
    try {
      const saved = localStorage.getItem('a2a_tasks')
      if (saved) {
        const arr: A2ATask[] = JSON.parse(saved)
        for (const task of arr) {
          this.tasks.set(task.id, task)
        }
      }
    } catch { /* 解析失败使用空集合 */ }
  }

  private saveTasks(): void {
    const arr = Array.from(this.tasks.values())
    localStorage.setItem('a2a_tasks', JSON.stringify(arr))
  }
}

/** 全局 A2A 服务单例 */
export const a2aService = new A2AService()
