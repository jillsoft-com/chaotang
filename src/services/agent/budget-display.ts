/**
 * 预算展示模块 — 实时预算追踪与告警
 *
 * TaskScheduler 在每次工具调用后发出 budget-update 事件。
 * 本模块负责：
 * 1. 追踪各节点和整棵树的预算消耗
 * 2. 达到阈值时发出告警（去重，不重复弹窗）
 * 3. 提供预算摘要供 UI 展示
 *
 * 设计依据：朝堂任务树运行时改进说明 R6。
 */

// ============ 类型 ============

export interface BudgetSnapshot {
  nodeId: string
  nodeUsage: {
    iterations: number
    toolCalls: number
    elapsedMs: number
  }
  treeUsage: {
    iterations: number
    toolCalls: number
    elapsedMs: number
  }
  remaining: {
    toolCalls: number
    iterations: number
  }
  timestamp: number
}

export interface BudgetWarning {
  nodeId: string
  type: 'tree_budget_high' | 'node_iterations_high' | 'tree_tool_calls_exhausted'
  message: string
  timestamp: number
  /** 是否已通知用户 */
  notified: boolean
}

export interface BudgetDisplayState {
  /** 最新的预算快照（按节点 ID 索引） */
  nodeSnapshots: Map<string, BudgetSnapshot>
  /** 最新的整棵树预算 */
  treeUsage: { iterations: number; toolCalls: number; elapsedMs: number }
  /** 剩余预算 */
  remaining: { toolCalls: number; iterations: number }
  /** 告警历史 */
  warnings: BudgetWarning[]
  /** 是否达到告警阈值 */
  hasWarning: boolean
}

// ============ 常量 ============

/** 树级工具调用高水位告警阈值（百分比） */
const TREE_TOOL_CALLS_WARNING_PCT = 0.8
/** 节点迭代次数高水位告警阈值（百分比） */
const NODE_ITERATIONS_WARNING_PCT = 0.8
/** 告警去重窗口 ms */
const WARNING_DEDUP_MS = 30000

// ============ 预算追踪器 ============

export class BudgetTracker {
  private state: BudgetDisplayState = {
    nodeSnapshots: new Map(),
    treeUsage: { iterations: 0, toolCalls: 0, elapsedMs: 0 },
    remaining: { toolCalls: 0, iterations: 0 },
    warnings: [],
    hasWarning: false
  }

  private maxToolCallsPerRun: number
  private maxIterationsPerLeaf: number
  private warningListeners: Array<(warning: BudgetWarning) => void> = []

  constructor(maxToolCallsPerRun: number = 200, maxIterationsPerLeaf: number = 10) {
    this.maxToolCallsPerRun = maxToolCallsPerRun
    this.maxIterationsPerLeaf = maxIterationsPerLeaf
  }

  /**
   * 处理 budget-update 事件
   */
  processBudgetUpdate(snapshot: BudgetSnapshot): BudgetWarning | null {
    this.state.nodeSnapshots.set(snapshot.nodeId, snapshot)
    this.state.treeUsage = { ...snapshot.treeUsage }
    this.state.remaining = { ...snapshot.remaining }

    // 检查告警条件
    const warning = this.checkWarnings(snapshot)
    if (warning) {
      this.state.warnings.push(warning)
      this.state.hasWarning = true
      // 通知监听者
      for (const listener of this.warningListeners) {
        try { listener(warning) } catch { /* 忽略回调异常 */ }
      }
    }

    return warning
  }

  /**
   * 注册告警监听
   */
  onWarning(listener: (warning: BudgetWarning) => void): () => void {
    this.warningListeners.push(listener)
    return () => {
      this.warningListeners = this.warningListeners.filter(l => l !== listener)
    }
  }

  /**
   * 获取当前预算展示状态
   */
  getState(): Readonly<BudgetDisplayState> {
    return this.state
  }

  /**
   * 获取树级预算摘要
   */
  getTreeSummary(): {
    toolCalls: number
    toolCallsMax: number
    toolCallsPct: number
    elapsedMs: number
    iterations: number
  } {
    return {
      toolCalls: this.state.treeUsage.toolCalls,
      toolCallsMax: this.maxToolCallsPerRun,
      toolCallsPct: this.maxToolCallsPerRun > 0
        ? this.state.treeUsage.toolCalls / this.maxToolCallsPerRun
        : 0,
      elapsedMs: this.state.treeUsage.elapsedMs,
      iterations: this.state.treeUsage.iterations
    }
  }

  /**
   * 获取某节点的预算摘要
   */
  getNodeSummary(nodeId: string): BudgetSnapshot | null {
    return this.state.nodeSnapshots.get(nodeId) || null
  }

  /**
   * 获取所有告警历史
   */
  getWarnings(): ReadonlyArray<BudgetWarning> {
    return this.state.warnings
  }

  /**
   * 清除告警状态（用户确认后调用）
   */
  clearWarnings(): void {
    this.state.hasWarning = false
  }

  /**
   * 增加预算上限（暂停后用户决定加额时调用）
   */
  increaseMaxToolCalls(additional: number, reason: string): void {
    this.maxToolCallsPerRun += additional
    this.state.warnings.push({
      nodeId: '__system__',
      type: 'tree_tool_calls_exhausted',
      message: `用户增加预算 ${additional} 次工具调用。原因: ${reason}`,
      timestamp: Date.now(),
      notified: true
    })
    this.state.hasWarning = false
  }

  /**
   * 重置追踪器
   */
  reset(): void {
    this.state = {
      nodeSnapshots: new Map(),
      treeUsage: { iterations: 0, toolCalls: 0, elapsedMs: 0 },
      remaining: { toolCalls: 0, iterations: 0 },
      warnings: [],
      hasWarning: false
    }
  }

  // ============ 内部方法 ============

  private checkWarnings(snapshot: BudgetSnapshot): BudgetWarning | null {
    const now = Date.now()

    // 1. 树级工具调用耗尽（优先级最高）
    if (snapshot.remaining.toolCalls <= 0 && !this.isDuplicateWarning('tree_tool_calls_exhausted', now)) {
      return {
        nodeId: '__tree__',
        type: 'tree_tool_calls_exhausted',
        message: `任务树工具调用预算已耗尽 (${snapshot.treeUsage.toolCalls}/${this.maxToolCallsPerRun})`,
        timestamp: now,
        notified: false
      }
    }

    // 2. 树级工具调用高水位
    const treePct = this.maxToolCallsPerRun > 0
      ? snapshot.treeUsage.toolCalls / this.maxToolCallsPerRun
      : 0

    if (treePct >= TREE_TOOL_CALLS_WARNING_PCT && !this.isDuplicateWarning('tree_budget_high', now)) {
      return {
        nodeId: '__tree__',
        type: 'tree_budget_high',
        message: `任务树已消耗 ${Math.round(treePct * 100)}% 工具调用预算 (${snapshot.treeUsage.toolCalls}/${this.maxToolCallsPerRun})`,
        timestamp: now,
        notified: false
      }
    }

    // 3. 节点迭代次数高水位
    const nodeIterPct = this.maxIterationsPerLeaf > 0
      ? snapshot.nodeUsage.iterations / this.maxIterationsPerLeaf
      : 0

    if (nodeIterPct >= NODE_ITERATIONS_WARNING_PCT && !this.isDuplicateWarning('node_iterations_high', now, snapshot.nodeId)) {
      return {
        nodeId: snapshot.nodeId,
        type: 'node_iterations_high',
        message: `节点 ${snapshot.nodeId} 已使用 ${Math.round(nodeIterPct * 100)}% 迭代预算 (${snapshot.nodeUsage.iterations}/${this.maxIterationsPerLeaf})`,
        timestamp: now,
        notified: false
      }
    }

    return null
  }

  private isDuplicateWarning(type: string, now: number, nodeId?: string): boolean {
    return this.state.warnings.some(w => {
      if (w.type !== type) return false
      if (nodeId && w.nodeId !== nodeId) return false
      return (now - w.timestamp) < WARNING_DEDUP_MS
    })
  }
}

// ============ 格式化辅助函数 ============

export function formatBudgetDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSecs = seconds % 60
  return `${minutes}m${remainingSecs}s`
}

export function formatBudgetPct(pct: number): string {
  return `${Math.round(pct * 100)}%`
}
