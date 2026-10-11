/**
 * 任务调度器 — 事件驱动 + 定时兜底
 *
 * 负责跨角色任务的协调执行：
 * - 从任务树中找到就绪节点，按优先级串行执行
 * - 支持渐进拆解（Worker 按需细化子任务）
 * - 状态事件立即协调，定时 tick 巡检超时和等待条件
 * - 每次关键状态变化保存快照
 *
 * 设计依据：朝堂任务树与执行监护设计方案（修订版）第五、六节。
 */

import type { Minister, Speech, ToolCall, ToolCallResult, LLMConfig } from '@/types'
import type {
  TaskTreeSnapshot,
  TaskNode,
  TaskStatus
} from './task-tree'
import {
  getReadyNodes,
  transitionStatus,
  validateStructure,
  aggregateTreeUsage,
  deriveTreeState,
  computeDepth,
  addDependency,
  removeDependency,
  reorderChildren,
  changePriority,
  moveNode,
  serializeSnapshot,
  deserializeSnapshot
} from './task-tree'
import { ExecutionGuardian } from './execution-guardian'
import type { GuardianConfig, GuardianRecord, NodeCost } from './execution-guardian'
import { eventLogger } from './event-logger'
import { ResourceLockManager } from './resource-lock'
import { generateParentSummary, buildSiblingContext } from './hierarchical-summary'
import { depthEvaluator } from './depth-evaluator'

// ============ 树编辑类型 ============

export type TreeEdit =
  | { type: 'add-dependency'; nodeId: string; dep: { taskId: string; kind: 'required' | 'advisory' } }
  | { type: 'remove-dependency'; nodeId: string; depTaskId: string }
  | { type: 'reorder-children'; parentId: string; newOrder: string[] }
  | { type: 'change-priority'; nodeId: string; priority: 0 | 1 | 2 | 3 }
  | { type: 'move-node'; nodeId: string; newParentId: string }

// ============ 类型定义 ============

export interface SchedulerConfig {
  /** 活跃任务巡检间隔 ms（默认 10s） */
  activeTickMs: number
  /** 等待状态巡检间隔 ms（默认 30s） */
  idleTickMs: number
  /** 全树最大工具调用数 */
  maxToolCallsPerRun: number
  /** 并发策略：1 = 串行，'readonly-parallel' = 只读任务并行 */
  concurrency: 1 | 'readonly-parallel'
  /** 监护器配置 */
  guardian?: Partial<GuardianConfig>
}

const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  activeTickMs: 10000,
  idleTickMs: 30000,
  maxToolCallsPerRun: 200,
  concurrency: 'readonly-parallel'
}

/** 叶子节点执行上下文 */
export interface LeafExecContext {
  /** 已完成的兄弟任务摘要 */
  previousResultsSummary: string
  /** 全局目标 */
  goal: string
}

/** 叶子节点执行结果 */
export interface LeafResult {
  content: string
  toolCalls: ToolCallResult[]
  duration: number
  status: 'success' | 'error'
  goalReached?: boolean
  /** LLM 输出中明确表明任务过于复杂需要更深拆解的信号 */
  complexitySignal?: boolean
}

/** 执行上下文（由 coordinator 传入） */
export interface ExecutionContext {
  ministers: Minister[]
  resolveLLM: (llm: LLMConfig) => LLMConfig
  createSpeech: (ministerId: string) => Speech
  getReactiveSpeech: (id: string) => Speech
  shouldContinue: () => boolean
  workingDirectory?: string
  onBeforeToolExecute?: (toolCall: ToolCall) => Promise<boolean>
  agentsMdHint?: string
  memoryHint?: string
  /** 保存快照到 Debate */
  saveSnapshot: (tree: TaskTreeSnapshot) => void
  /** 请求 Worker 拆解（返回更新后的树） */
  requestWorkerDecomposition: (
    worker: Minister,
    task: TaskNode,
    tree: TaskTreeSnapshot
  ) => Promise<TaskTreeSnapshot>
  /** 请求叶子节点执行 */
  executeLeaf: (
    node: TaskNode,
    context: LeafExecContext,
    abortSignal?: AbortSignal
  ) => Promise<LeafResult>
}

/** 调度器事件类型 */
export type SchedulerEventType =
  | 'tree-created'
  | 'node-ready'
  | 'node-analyzing'
  | 'node-expanded'
  | 'node-started'
  | 'node-checkpoint'
  | 'node-completed'
  | 'node-failed'
  | 'node-paused'
  | 'node-skipped'
  | 'tree-updated'
  | 'tree-completed'
  | 'tree-failed'
  | 'guardian-paused'
  | 'guardian-warning'
  | 'guardian-retry'
  | 'budget-update'
  | 'error'

export interface SchedulerEvent {
  type: SchedulerEventType
  runId: string
  nodeId?: string
  seq: number
  data?: any
}

type SchedulerEventCallback = (event: SchedulerEvent) => void

// ============ 调度器 ============

export class TaskScheduler {
  private config: SchedulerConfig
  private listeners: SchedulerEventCallback[] = []
  private activeTrees: Map<string, {
    tree: TaskTreeSnapshot
    context: ExecutionContext
    abortController: AbortController
    tickTimer: ReturnType<typeof setInterval> | null
    running: boolean
    seq: number
    guardian: ExecutionGuardian
    /** 当前正在执行的节点 ID（并行场景下可能有多个） */
    runningNodes: Set<string>
    /** 文件变化检测缓存：filePath -> latestContent (null=不存在, ''=读取中, string=内容) */
    fileWatchCache: Map<string, string | null>
    /** 文件基线快照：filePath -> baselineContent (首次检查时的内容) */
    fileWatchBaseline: Map<string, string | null>
    /** 协调互斥锁：防止多个 coordinate() 并发执行 */
    coordinating: boolean
    /** 资源读写锁管理器 */
    resourceLocks: ResourceLockManager
  }> = new Map()

  constructor(config?: Partial<SchedulerConfig>) {
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config }
  }

  /** 添加事件监听 */
  onEvent(callback: SchedulerEventCallback): () => void {
    this.listeners.push(callback)
    return () => {
      this.listeners = this.listeners.filter(cb => cb !== callback)
    }
  }

  private emit(event: Omit<SchedulerEvent, 'seq'> & { seq?: number }): void {
    const entry = this.activeTrees.get(event.runId)
    const seq = event.seq ?? (entry ? ++entry.seq : 0)
    const fullEvent: SchedulerEvent = { ...event, seq } as SchedulerEvent

    // 记录到事件日志
    eventLogger.record(fullEvent)

    for (const listener of this.listeners) {
      try { listener(fullEvent) } catch { /* 回调异常不影响主流程 */ }
    }
  }

  /**
   * 启动任务树执行
   */
  start(tree: TaskTreeSnapshot, context: ExecutionContext): void {
    const abortController = new AbortController()
    const entry: {
      tree: TaskTreeSnapshot
      context: ExecutionContext
      abortController: AbortController
      tickTimer: ReturnType<typeof setInterval> | null
      running: boolean
      seq: number
      guardian: ExecutionGuardian
      runningNodes: Set<string>
      fileWatchCache: Map<string, string | null>
      fileWatchBaseline: Map<string, string | null>
      coordinating: boolean
      resourceLocks: ResourceLockManager
    } = {
      tree,
      context,
      abortController,
      tickTimer: null,
      running: true,
      seq: 0,
      guardian: new ExecutionGuardian(this.config.guardian),
      runningNodes: new Set<string>(),
      fileWatchCache: new Map<string, string | null>(),
      fileWatchBaseline: new Map<string, string | null>(),
      coordinating: false,
      resourceLocks: new ResourceLockManager()
    }
    this.activeTrees.set(tree.runId, entry)

    // 校验树结构
    const validation = validateStructure(tree)
    if (!validation.valid) {
      this.emit({
        type: 'error',
        runId: tree.runId,
        data: { phase: 'validate', errors: validation.errors }
      })
      // 不执行无效的树
      return
    }

    this.emit({ type: 'tree-created', runId: tree.runId, data: { tree } })

    // 启动定时巡检
    const tickInterval = this.hasWaitingNodes(tree)
      ? this.config.idleTickMs
      : this.config.activeTickMs

    entry.tickTimer = setInterval(() => {
      this.tick(tree.runId)
    }, tickInterval)

    // 立即触发首次协调
    this.coordinate(tree.runId)
  }

  /** 暂停整棵树 */
  pause(runId: string): void {
    const entry = this.activeTrees.get(runId)
    if (!entry || !entry.running) return

    entry.abortController.abort()
    entry.tree.state = 'paused'
    entry.context.saveSnapshot(entry.tree)
    this.emit({ type: 'tree-updated', runId, data: { state: 'paused' } })
  }

  /** 继续执行 */
  resume(runId: string): void {
    const entry = this.activeTrees.get(runId)
    if (!entry) return

    if (entry.tree.state !== 'paused') return

    entry.abortController = new AbortController()
    entry.tree.state = 'running'
    entry.context.saveSnapshot(entry.tree)
    this.emit({ type: 'tree-updated', runId, data: { state: 'running' } })

    // 重新触发协调
    this.coordinate(runId)
  }

  /** 取消整棵树 */
  cancel(runId: string): void {
    const entry = this.activeTrees.get(runId)
    if (!entry) return

    entry.abortController.abort()
    entry.running = false

    // 释放所有资源锁
    entry.resourceLocks.releaseAll('__cancel__')

    // 将所有未完成节点标记为 cancelled
    for (const node of Object.values(entry.tree.nodes)) {
      if (!['completed', 'failed', 'cancelled', 'skipped'].includes(node.status)) {
        transitionStatus(entry.tree, node.id, 'cancelled', '用户取消')
      }
    }

    entry.tree.state = 'cancelled'
    entry.context.saveSnapshot(entry.tree)
    this.cleanup(runId)
    this.emit({ type: 'tree-updated', runId, data: { state: 'cancelled' } })
  }

  /**
   * 重试失败/暂停的节点
   */
  retryNode(runId: string, nodeId: string, userConfirmed: boolean = false): boolean {
    const entry = this.activeTrees.get(runId)
    if (!entry) return false

    const { tree, context, guardian } = entry
    const node = tree.nodes[nodeId]
    if (!node) return false

    // 只允许重试失败/暂停/被阻塞的节点
    if (!['failed', 'paused', 'blocked'].includes(node.status)) return false

    // 写入任务需要用户确认
    if (!node.readOnly && !userConfirmed) return false

    // 递增尝试次数
    node.attempt++
    transitionStatus(tree, node.id, 'ready', `重试 (第 ${node.attempt} 次)`)
    guardian.resetNodeRecords(nodeId)
    context.saveSnapshot(tree)

    this.emit({
      type: 'guardian-retry',
      runId,
      nodeId,
      data: { attempt: node.attempt }
    })

    // 触发协调
    this.coordinate(runId)
    return true
  }

  /**
   * 获取某节点的成本
   */
  getNodeCost(runId: string, nodeId: string): NodeCost | null {
    const entry = this.activeTrees.get(runId)
    if (!entry) return null

    const node = entry.tree.nodes[nodeId]
    if (!node) return null

    return {
      nodeId: node.id,
      title: node.title,
      iterations: node.usage.iterations,
      toolCalls: node.usage.toolCalls,
      elapsedMs: node.usage.elapsedMs,
      estimatedTokens: (node.usage.inputTokens || 0) + (node.usage.outputTokens || 0)
    }
  }

  /**
   * 获取整棵树的成本归因
   */
  getTreeCost(runId: string): NodeCost[] {
    const entry = this.activeTrees.get(runId)
    if (!entry) return []
    return entry.guardian.getCostAttribution(entry.tree)
  }

  /**
   * 应用树编辑（暂停协调 -> 应用 -> 校验 -> 恢复）
   */
  editTree(runId: string, edits: TreeEdit[]): { ok: boolean; errors: string[] } {
    const entry = this.activeTrees.get(runId)
    if (!entry) return { ok: false, errors: ['树不存在'] }

    // 深拷贝副本：编辑在副本上进行，全部成功后才写回原树
    const workingCopy = deserializeSnapshot(serializeSnapshot(entry.tree))
    if (!workingCopy) return { ok: false, errors: ['内部错误：无法备份树'] }
    const errors: string[] = []

    for (const edit of edits) {
      let result: { ok: boolean; error?: string }
      switch (edit.type) {
        case 'add-dependency':
          result = addDependency(workingCopy, edit.nodeId, edit.dep)
          break
        case 'remove-dependency':
          result = removeDependency(workingCopy, edit.nodeId, edit.depTaskId)
          break
        case 'reorder-children':
          result = reorderChildren(workingCopy, edit.parentId, edit.newOrder)
          break
        case 'change-priority':
          result = changePriority(workingCopy, edit.nodeId, edit.priority)
          break
        case 'move-node':
          result = moveNode(workingCopy, edit.nodeId, edit.newParentId)
          break
        default:
          result = { ok: false, error: `未知编辑类型` }
      }
      if (!result.ok) {
        errors.push(result.error || '操作失败')
      }
    }

    // 任一编辑失败 → 原树不动，直接返回
    if (errors.length > 0) return { ok: false, errors }

    // 校验副本结构
    const validation = validateStructure(workingCopy)
    if (!validation.valid) return { ok: false, errors: validation.errors }

    // 全部成功：将副本内容写回原树（保持引用不变）
    entry.tree.nodes = workingCopy.nodes
    entry.tree.rootId = workingCopy.rootId
    entry.tree.updatedAt = workingCopy.updatedAt
    entry.tree.planRevision++
    entry.context.saveSnapshot(entry.tree)
    this.emit({ type: 'tree-updated', runId, data: { tree: entry.tree, edits } })

    // 触发重新协调
    this.coordinate(runId)

    return { ok: true, errors: [] }
  }

  /**
   * 获取某节点的监护记录
   */
  getGuardianRecords(runId: string, nodeId?: string): GuardianRecord[] {
    const entry = this.activeTrees.get(runId)
    if (!entry) return []
    if (nodeId) return entry.guardian.getRecords(nodeId)
    return entry.guardian.getAllRecords()
  }

  /**
   * 导出事件日志
   */
  exportEventLog(runId: string, format: 'json' | 'markdown' = 'markdown'): string {
    return format === 'json' ? eventLogger.exportJSON(runId) : eventLogger.exportMarkdown(runId)
  }

  /**
   * 获取事件日志条目
   */
  getEventLogs(runId: string) {
    return eventLogger.getLogs(runId)
  }

  /**
   * 销毁（清除所有定时器）
   */
  destroy(): void {
    for (const [runId] of this.activeTrees) {
      this.cleanup(runId)
    }
    this.activeTrees.clear()
  }

  // ============ 内部方法 ============

  /**
   * 定时巡检：检查超时、等待条件、漏掉的状态变化
   */
  private tick(runId: string): void {
    const entry = this.activeTrees.get(runId)
    if (!entry || !entry.running) return

    // 检查等待中的节点：时间条件是否到期
    for (const node of Object.values(entry.tree.nodes)) {
      if (node.status === 'waiting' && node.wakeCondition?.type === 'time') {
        if (Date.now() >= node.wakeCondition.notBefore) {
          transitionStatus(entry.tree, node.id, 'ready', '等待时间已到')
          entry.context.saveSnapshot(entry.tree)
          this.coordinate(runId) // 立即触发协调
        }
      }
      // 检查文件变化唤醒条件
      if (node.status === 'waiting' && node.wakeCondition?.type === 'file_change') {
        const fileChanged = this.checkFileChanged(runId, node.wakeCondition.path, node.wakeCondition.event)
        if (fileChanged) {
          transitionStatus(entry.tree, node.id, 'ready', `文件已${node.wakeCondition.event === 'created' ? '创建' : '修改'}`)
          entry.context.saveSnapshot(entry.tree)
          this.coordinate(runId)
        }
      }
    }

    // 检查运行中的节点：是否超时
    for (const node of Object.values(entry.tree.nodes)) {
      if (node.status === 'running' && node.startedAt) {
        const elapsed = Date.now() - node.startedAt
        if (elapsed > node.budget.timeoutMs) {
          transitionStatus(entry.tree, node.id, 'paused', `超时: ${Math.round(elapsed / 1000)}s`)
          entry.context.saveSnapshot(entry.tree)
          this.emit({
            type: 'node-paused',
            runId,
            nodeId: node.id,
            data: { reason: 'timeout', elapsed }
          })
        }
      }
    }

    // 检查全树预算
    aggregateTreeUsage(entry.tree)
    if (entry.tree.usage.toolCalls >= entry.tree.limits.maxToolCallsPerRun) {
      this.pause(runId)
      this.emit({
        type: 'error',
        runId,
        data: { reason: 'budget_exceeded', usage: entry.tree.usage }
      })
    }

    // 如果当前没有在协调，检查是否有 ready 节点
    const readyNodes = getReadyNodes(entry.tree)
    if (readyNodes.length > 0) {
      this.coordinate(runId)
    }
  }

  /**
   * 核心协调循环：找 ready 节点，执行或拆解
   */
  private async coordinate(runId: string): Promise<void> {
    const entry = this.activeTrees.get(runId)
    if (!entry || !entry.running) return

    // 协调互斥：如果已有 coordinate 正在执行，跳过本次
    if (entry.coordinating) return
    entry.coordinating = true
    try {
      await this.coordinateInner(runId)
    } finally {
      entry.coordinating = false
    }
  }

  private async coordinateInner(runId: string): Promise<void> {
    const entry = this.activeTrees.get(runId)
    if (!entry || !entry.running) return

    // 暂停/取消时不执行
    if (entry.abortController.signal.aborted) return
    if (entry.tree.state === 'paused' || entry.tree.state === 'cancelled') return

    const { tree, context } = entry

    // 1. 校验树结构
    const validation = validateStructure(tree)
    if (!validation.valid) {
      this.emit({
        type: 'error',
        runId,
        data: { phase: 'coordinate', errors: validation.errors }
      })
      return
    }

    // 2. 更新 pending → ready（依赖已满足的）
    this.updateReadyNodes(tree)

    // 3. 找 ready 节点
    const readyNodes = getReadyNodes(tree)

    if (readyNodes.length === 0) {
      // 没有就绪节点：检查树是否完成
      const newState = deriveTreeState(tree)
      if (newState !== tree.state) {
        tree.state = newState
        context.saveSnapshot(tree)
        this.emit({ type: 'tree-updated', runId, data: { state: newState } })
      }
      if (['completed', 'completed_with_gaps', 'failed', 'cancelled'].includes(newState)) {
        this.emit({
          type: newState === 'failed' ? 'tree-failed' : 'tree-completed',
          runId,
          data: { state: newState, usage: tree.usage }
        })
        this.cleanup(runId)
      }
      return
    }

    // 4. 并发策略：只读节点可并行，写节点串行 + 资源锁
    const parallelMode = this.config.concurrency === 'readonly-parallel'
    const resourcePath = context.workingDirectory || '__global__'

    // 过滤掉已在执行中的节点
    const availableNodes = readyNodes.filter(n => !entry.runningNodes.has(n.id))

    if (availableNodes.length === 0) {
      // 所有 ready 节点都在执行中，等待完成
      return
    }

    if (!context.shouldContinue()) {
      this.pause(runId)
      return
    }

    if (parallelMode) {
      // 分离只读节点和写节点
      const readOnlyNodes = availableNodes.filter(n => n.readOnly)
      const writeNodes = availableNodes.filter(n => !n.readOnly)

      // 资源锁检查：如果有写节点正在执行，读节点需等待

      if (readOnlyNodes.length > 0 && writeNodes.length === 0 && !entry.resourceLocks.isLocked(resourcePath)) {
        // 纯只读场景：并行执行所有（获取共享读锁）
        const promises = readOnlyNodes.map(node => {
          entry.runningNodes.add(node.id)
          entry.resourceLocks.acquire(resourcePath, 'read', node.id)
          // 实际工具过滤在 coordinator.executeLeafNode 中进行（基于 node.readOnly 标志）
          const executeOrDecompose = node.decomposition === 'unexamined' && computeDepth(tree, node.id) < tree.limits.maxDepth
            ? this.tryDecompose(runId, node)
            : this.executeNode(runId, node)
          return executeOrDecompose.finally(() => {
            entry.runningNodes.delete(node.id)
            entry.resourceLocks.release(resourcePath, node.id)
          })
        })
        await Promise.all(promises)
      } else if (writeNodes.length > 0) {
        // 有写节点：尝试获取排他写锁
        const node = writeNodes[0]
        const lockResult = entry.resourceLocks.acquire(resourcePath, 'write', node.id)
        if (!lockResult.acquired) {
          // 无法获取写锁：延迟执行，等待当前锁释放
          return
        }
        entry.runningNodes.add(node.id)
        try {
          if (node.decomposition === 'unexamined' && computeDepth(tree, node.id) < tree.limits.maxDepth) {
            await this.tryDecompose(runId, node)
          } else {
            await this.executeNode(runId, node)
          }
        } finally {
          entry.runningNodes.delete(node.id)
          entry.resourceLocks.release(resourcePath, node.id)
        }
      }
    } else {
      // 串行模式：取第一个 ready 节点
      const node = availableNodes[0]
      entry.runningNodes.add(node.id)
      try {
        if (node.decomposition === 'unexamined' && computeDepth(tree, node.id) < tree.limits.maxDepth) {
          await this.tryDecompose(runId, node)
        } else {
          await this.executeNode(runId, node)
        }
      } finally {
        entry.runningNodes.delete(node.id)
      }
    }

    // 6. 执行完毕后，递归协调下一个
    if (entry.running && !entry.abortController.signal.aborted) {
      // 使用 setTimeout 避免递归过深
      setTimeout(() => this.coordinate(runId), 0)
    }
  }

  /**
   * 尝试拆解节点
   */
  private async tryDecompose(runId: string, node: TaskNode): Promise<void> {
    const entry = this.activeTrees.get(runId)
    if (!entry) return

    const { tree, context } = entry

    // 标记为分析中
    transitionStatus(tree, node.id, 'running', '分析中')
    this.emit({ type: 'node-analyzing', runId, nodeId: node.id, data: { node } })

    try {
      // 查找执行者
      const worker = context.ministers.find(m => m.id === node.assigneeId)
      if (!worker) {
        // 无执行者：直接标记为叶子
        node.decomposition = 'leaf'
        transitionStatus(tree, node.id, 'ready')
        context.saveSnapshot(tree)
        return
      }

      // 调用 Worker 的 LLM 进行拆解
      const updatedTree = await context.requestWorkerDecomposition(worker, node, tree)

      // 合并更新
      Object.assign(tree.nodes, updatedTree.nodes)

      if (node.childIds.length > 0) {
        node.decomposition = 'expanded'
        // 不将父节点标为 completed：保持 running，由 updateParentStatus 在子节点全部完成后推导
        this.emit({
          type: 'node-expanded',
          runId,
          nodeId: node.id,
          data: { childIds: node.childIds, tree }
        })
      } else {
        node.decomposition = 'leaf'
        transitionStatus(tree, node.id, 'ready')
      }

      tree.planRevision++
      context.saveSnapshot(tree)
      this.emit({ type: 'tree-updated', runId, data: { tree } })
    } catch (error) {
      // 拆解失败：降级为叶子执行
      node.decomposition = 'leaf'
      transitionStatus(tree, node.id, 'ready')
      context.saveSnapshot(tree)
      this.emit({
        type: 'error',
        runId,
        nodeId: node.id,
        data: { phase: 'decompose', error: error instanceof Error ? error.message : '未知错误' }
      })
    }
  }

  /**
   * 执行叶子节点
   */
  private async executeNode(runId: string, node: TaskNode): Promise<void> {
    const entry = this.activeTrees.get(runId)
    if (!entry) return

    const { tree, context } = entry

    // 标记为运行中
    transitionStatus(tree, node.id, 'running', '执行中')
    context.saveSnapshot(tree)

    this.emit({ type: 'node-started', runId, nodeId: node.id, data: { node } })

    try {
      // 构建前序结果摘要
      const previousResults = this.buildPreviousResultsSummary(tree, node)

      const leafContext: LeafExecContext = {
        previousResultsSummary: previousResults,
        goal: tree.nodes[tree.rootId].description
      }

      // 执行叶子节点
      const result = await context.executeLeaf(
        node,
        leafContext,
        entry.abortController.signal
      )

      // 更新节点状态
      node.resultSummary = result.content.length > 500
        ? result.content.slice(0, 500) + '...(已截断)'
        : result.content
      node.usage.iterations += 1 // 简化：一次执行算一轮
      node.usage.toolCalls += result.toolCalls.length
      node.usage.elapsedMs += result.duration

      // 收集证据引用
      for (const tc of result.toolCalls) {
        if (tc.status === 'success') {
          node.evidenceRefs.push(tc.toolCallId)
        }
      }

      // 发出 budget-update 事件（每次工具调用后）
      aggregateTreeUsage(tree)
      this.emit({
        type: 'budget-update',
        runId,
        nodeId: node.id,
        data: {
          nodeUsage: { ...node.usage },
          treeUsage: { ...tree.usage },
          remaining: {
            toolCalls: tree.limits.maxToolCallsPerRun - tree.usage.toolCalls,
            iterations: node.budget.maxIterations - node.usage.iterations
          }
        }
      })

      // 监护器评估：循环检测、停滞检测、预算检查
      const guardianRecord = entry.guardian.evaluate(node, result.toolCalls)
      if (guardianRecord) {
        if (guardianRecord.action === 'paused') {
          // 循环或停滞触发 -> 暂停节点
          transitionStatus(tree, node.id, 'paused', guardianRecord.detail)
          context.saveSnapshot(tree)
          this.emit({
            type: 'guardian-paused',
            runId,
            nodeId: node.id,
            data: { record: guardianRecord }
          })
          if (node.parentId) {
            this.updateParentStatus(tree, node.parentId)
          }
          return
        }
        if (guardianRecord.type === 'budget_warning') {
          this.emit({
            type: 'guardian-warning',
            runId,
            nodeId: node.id,
            data: { record: guardianRecord }
          })
        }
      }

      const newStatus: TaskStatus = result.status === 'success' ? 'completed' : 'failed'
      transitionStatus(tree, node.id, newStatus, result.goalReached === false ? '自主引擎未达成目标' : undefined)

      // R10: 仅当 LLM 输出明确表明需要更深拆解时才记录
      // 条件：
      // 1. 节点为叶子且执行失败
      // 2. LLM 输出中包含复杂度信号（明确表明任务过于复杂/需要拆解）
      // 3. 节点深度达到 maxDepth
      if (newStatus === 'failed' && node.decomposition === 'leaf' && node.childIds.length === 0 && result.complexitySignal === true) {
        const nodeDepth = computeDepth(tree, node.id)
        if (nodeDepth >= tree.limits.maxDepth) {
          depthEvaluator.recordCase({
            debateId: tree.debateId,
            runId,
            maxDepthReached: nodeDepth,
            depthLimit: tree.limits.maxDepth,
            reason: 'leaf_too_complex',
            nodeContext: {
              nodeId: node.id,
              nodeTitle: node.title,
              childCount: 0,
              description: node.description.slice(0, 200)
            }
          })
        }
      }

      // 更新验证等级
      if (result.status === 'success') {
        // 有工具证据的视为 tool_evidence
        node.verification = result.toolCalls.length > 0 ? 'tool_evidence' : 'model_claim'
      }

      context.saveSnapshot(tree)

      // 更新父节点
      if (node.parentId) {
        this.updateParentStatus(tree, node.parentId)
      }

      this.emit({
        type: newStatus === 'completed' ? 'node-completed' : 'node-failed',
        runId,
        nodeId: node.id,
        data: { result, status: newStatus }
      })
    } catch (error) {
      // 执行失败
      transitionStatus(tree, node.id, 'failed', error instanceof Error ? error.message : '未知错误')
      context.saveSnapshot(tree)

      if (node.parentId) {
        this.updateParentStatus(tree, node.parentId)
      }

      this.emit({
        type: 'node-failed',
        runId,
        nodeId: node.id,
        data: { error: error instanceof Error ? error.message : '未知错误' }
      })
    }
  }

  /**
   * 更新 pending 节点为 ready（当所有必需依赖已满足时）
   */
  private updateReadyNodes(tree: TaskTreeSnapshot): void {
    const newlyBlocked: string[] = []
    for (const node of Object.values(tree.nodes)) {
      if (node.status !== 'pending') continue

      const requiredDeps = node.dependencies.filter(d => d.kind === 'required')
      const allRequiredDone = requiredDeps.every(dep => {
        const depNode = tree.nodes[dep.taskId]
        return depNode && (depNode.status === 'completed' || depNode.status === 'partial')
      })

      const anyRequiredFailed = requiredDeps.some(dep => {
        const depNode = tree.nodes[dep.taskId]
        return depNode && (depNode.status === 'failed' || depNode.status === 'blocked')
      })

      if (allRequiredDone) {
        transitionStatus(tree, node.id, 'ready')
      } else if (anyRequiredFailed) {
        transitionStatus(tree, node.id, 'blocked', '必需依赖失败')
        if (node.parentId) newlyBlocked.push(node.parentId)
      }
    }

    // blocked 节点可能使父节点的所有子节点都到达终态，需更新父节点
    for (const parentId of new Set(newlyBlocked)) {
      this.updateParentStatus(tree, parentId)
    }
  }

  /**
   * 根据子节点状态更新父节点
   */
  private updateParentStatus(tree: TaskTreeSnapshot, parentId: string): void {
    const parent = tree.nodes[parentId]
    if (!parent) return

    // 所有子节点都有最终状态
    const allChildrenTerminal = parent.childIds.every(id => {
      const child = tree.nodes[id]
      return child && ['completed', 'failed', 'skipped', 'cancelled', 'partial', 'blocked'].includes(child.status)
    })

    if (allChildrenTerminal && parent.childIds.length > 0) {
      // 生成父节点汇总
      const hierSummary = generateParentSummary(tree, parentId)
      if (hierSummary) {
        parent.resultSummary = hierSummary.summaryText
      }

      // 检查是否有必需子任务失败
      const hasRequiredFailure = parent.childIds.some(id => {
        const child = tree.nodes[id]
        return child && child.requiredForParent && ['failed', 'blocked'].includes(child.status)
      })

      if (hasRequiredFailure) {
        transitionStatus(tree, parentId, 'failed', '必需子任务失败')
      } else {
        // 检查是否有非必需子任务失败（混合结果）
        const hasAnyFailure = parent.childIds.some(id => {
          const child = tree.nodes[id]
          return child && ['failed', 'blocked', 'cancelled'].includes(child.status)
        })
        if (hasAnyFailure) {
          transitionStatus(tree, parentId, 'partial', '部分子任务失败')
        } else {
          transitionStatus(tree, parentId, 'completed', '所有子任务完成')
        }
      }

      // 递归更新祖父
      if (parent.parentId) {
        this.updateParentStatus(tree, parent.parentId)
      }
    }
  }

  /**
   * 构建前序任务的结果摘要（使用逐层汇总，不注入全文）
   */
  private buildPreviousResultsSummary(tree: TaskTreeSnapshot, currentNode: TaskNode): string {
    return buildSiblingContext(tree, currentNode.id, 500)
  }

  /**
   * 检查树中是否有等待中的节点
   */
  private hasWaitingNodes(tree: TaskTreeSnapshot): boolean {
    return Object.values(tree.nodes).some(n => n.status === 'waiting')
  }

  /**
   * 检查文件是否发生变化（异步轮询式）
   *
   * 采用双映射策略：
   * - fileWatchBaseline: 首次检查时存储的基线快照
   * - fileWatchCache: 最新一次读取的内容
   *
   * 返回值：当前缓存中的最新状态是否与基线不同
   * 每次调用都会触发新的异步读取，结果在下次 tick 时可用
   */
  private checkFileChanged(runId: string, filePath: string, event: 'created' | 'modified'): boolean {
    try {
      if (!window.electronAPI?.readFile) return false

      const entry = this.activeTrees.get(runId)
      if (!entry) return false
      const cache = entry.fileWatchCache as Map<string, string | null>
      const baseline = entry.fileWatchBaseline as Map<string, string | null>

      const currentCached = cache.get(filePath)
      const baselineContent = baseline.get(filePath)

      // 判断是否已变化：根据事件类型分别处理
      let changed = false
      if (baselineContent !== undefined && currentCached !== undefined && currentCached !== '') {
        if (event === 'created') {
          // created: 基线时不存在(null)，现在存在(非null)
          if (baselineContent === null && currentCached !== null) {
            changed = true
          }
        } else {
          // modified: 基线存在且内容变化
          if (baselineContent !== null && currentCached !== null && baselineContent !== currentCached) {
            changed = true
          }
        }
      }

      // 触发下一次异步读取（结果在下次 tick 时可用）
      if (currentCached === undefined) {
        // 首次检查：触发异步读取
        cache.set(filePath, '')
        window.electronAPI.readFile(filePath).then((result: any) => {
          const content = result.success ? (result.content || '\x00__EMPTY__') : null
          cache.set(filePath, content)
          baseline.set(filePath, content) // 首次读取作为基线
        }).catch(() => {
          cache.set(filePath, null)
          baseline.set(filePath, null)
        })
      } else if (currentCached !== '') {
        // 已有缓存，触发重新读取以检测变化
        cache.set(filePath, '') // 标记为正在读取
        window.electronAPI.readFile(filePath).then((result: any) => {
          cache.set(filePath, result.success ? (result.content || '\x00__EMPTY__') : null)
        }).catch(() => {
          cache.set(filePath, currentCached) // 失败时保留旧缓存
        })
      }

      return changed
    } catch {
      return false
    }
  }

  /**
   * 清理已结束的任务树
   */
  private cleanup(runId: string): void {
    const entry = this.activeTrees.get(runId)
    if (!entry) return

    entry.running = false
    if (entry.tickTimer) {
      clearInterval(entry.tickTimer)
      entry.tickTimer = null
    }
    entry.guardian.clear()
    // 释放所有资源锁
    for (const nodeId of Object.keys(entry.tree.nodes)) {
      entry.resourceLocks.releaseAll(nodeId)
    }
    // 保留 entry 以供查询，但不占定时器
  }

  /**
   * 获取资源锁管理器（调试/测试用）
   */
  getResourceLocks(runId: string): ResourceLockManager | null {
    const entry = this.activeTrees.get(runId)
    return entry ? entry.resourceLocks : null
  }
}

/** 全局调度器单例 */
export const taskScheduler = new TaskScheduler()
