/**
 * 执行监护器 — 纯规则引擎
 *
 * 负责监控任务树执行过程中的异常情况：
 * - 循环检测：连续 3 次相同工具+相同参数 = 疑似循环
 * - 停滞检测：连续 N 轮无有效进展
 * - 全局预算：工具调用数/Token/时间预算监控
 * - 通知去重：同类通知在冷却期内不重复发送
 * - 成本归因：按节点/分支汇总执行成本
 * - 重试判定：只读任务的自动重试与写入任务的人工确认
 *
 * 不依赖 LLM，不依赖 UI，纯确定性逻辑。
 * 设计依据：朝堂任务树设计方案（修订版）第六节。
 */

import type { ToolCallResult } from '@/types'
import type { TaskNode, TaskTreeSnapshot } from './task-tree'

// ============ 配置 ============

export interface GuardianConfig {
  /** 连续同参调用次数阈值（默认 3） */
  loopThreshold: number
  /** 无有效进展轮数阈值（默认 3） */
  stallThreshold: number
  /** 同类通知冷却时间 ms（默认 30s） */
  notificationCooldownMs: number
  /** 只读任务自动重试上限（默认 2） */
  maxAutoRetries: number
  /** 重试退避时间 ms（默认 5000） */
  retryBackoffMs: number
}

const DEFAULT_GUARDIAN_CONFIG: GuardianConfig = {
  loopThreshold: 3,
  stallThreshold: 3,
  notificationCooldownMs: 30000,
  maxAutoRetries: 2,
  retryBackoffMs: 5000
}

// ============ 类型 ============

/** 工具调用指纹 */
export interface ToolFingerprint {
  functionName: string
  normalizedArgs: string
}

/** 监护记录 */
export interface GuardianRecord {
  nodeId: string
  timestamp: number
  type: 'loop_detected' | 'stall_detected' | 'budget_warning' | 'budget_exceeded' | 'auto_retry' | 'retry_blocked'
  detail: string
  evidence: ToolFingerprint[]
  action: 'paused' | 'notified' | 'auto_retried' | 'blocked'
}

/** 节点成本 */
export interface NodeCost {
  nodeId: string
  title: string
  iterations: number
  toolCalls: number
  elapsedMs: number
  estimatedTokens: number
}

/** 监护通知 */
export interface GuardianNotification {
  id: string
  nodeId: string
  type: string
  message: string
  timestamp: number
  dedupKey: string
  shown: boolean
}

// ============ 只读工具白名单 ============

const READ_ONLY_TOOLS = new Set([
  'read_file',
  'read_directory',
  'read_document',
  'search_code',
  'web_search',
  'knowledge_query',
  'calculate',
  'search_memory',
  'summarize_results',
  'git_operation'   // 只读 git 操作（log/diff/status/show）
])

/** 预期重复的例外工具（分页/轮询场景不算循环） */
const EXPECTED_REPEAT_TOOLS = new Set([
  'read_file',       // 可能多次读取同一文件观察变化
  'read_directory',  // 目录轮询
  'search_code'      // 不同条件的搜索
])

// ============ 纯函数 ============

/**
 * 计算工具调用指纹
 * 归一化参数：排序 keys 后 JSON.stringify
 */
export function computeFingerprint(tc: ToolCallResult): ToolFingerprint {
  const normalizedArgs = JSON.stringify(tc.arguments, Object.keys(tc.arguments).sort())
  return {
    functionName: tc.functionName,
    normalizedArgs
  }
}

/**
 * 循环检测：连续 threshold 次相同工具+相同参数
 * 例外：预期重复的工具（read_file/search_code 等）
 */
export function detectLoop(fingerprints: ToolFingerprint[], threshold: number): boolean {
  if (fingerprints.length < threshold) return false

  const tail = fingerprints.slice(-threshold)
  const first = tail[0]

  // 如果是指定的例外工具，不视为循环
  if (EXPECTED_REPEAT_TOOLS.has(first.functionName)) return false

  return tail.every(fp =>
    fp.functionName === first.functionName &&
    fp.normalizedArgs === first.normalizedArgs
  )
}

/**
 * 停滞检测：连续 threshold 次工具调用全部失败
 * 或者连续 threshold 轮无任何工具调用
 */
export function detectStall(recentResults: ToolCallResult[], threshold: number): boolean {
  if (recentResults.length === 0) return false
  if (recentResults.length < threshold) return false

  // 最近 threshold 次全部失败
  const tail = recentResults.slice(-threshold)
  return tail.every(r => r.status === 'error' || r.status === 'timeout')
}

/**
 * 判断是否为只读工具
 */
export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name)
}

/**
 * 判断节点的所有工具调用是否都是只读的
 */
export function isReadOnlyNode(toolCalls: ToolCallResult[]): boolean {
  if (toolCalls.length === 0) return true
  return toolCalls.every(tc => isReadOnlyTool(tc.functionName))
}

/**
 * 是否可以自动重试
 * 条件：只读任务 + 临时失败 + 未超重试上限
 */
export function canAutoRetry(node: TaskNode, config: GuardianConfig): boolean {
  // 超过最大重试次数
  if (node.attempt >= config.maxAutoRetries) return false

  // 只有只读节点可自动重试
  if (!node.readOnly) return false

  // 只有失败或被阻塞的节点可重试
  if (node.status !== 'failed' && node.status !== 'blocked') return false

  return true
}

// ============ Guardian 类 ============

export class ExecutionGuardian {
  private config: GuardianConfig
  /** 每个节点的监护记录 */
  private records: Map<string, GuardianRecord[]> = new Map()
  /** 每个节点的最近工具调用指纹 */
  private fingerprints: Map<string, ToolFingerprint[]> = new Map()
  /** 每个节点的最近工具调用结果 */
  private recentResults: Map<string, ToolCallResult[]> = new Map()
  /** 每个节点的最后有效进展时间 */
  private lastProgressAt: Map<string, number> = new Map()
  /** 已发送的通知（用于去重） */
  private sentNotifications: Map<string, { dedupKey: string; timestamp: number; id: string; shown: boolean }> = new Map()
  /** 通知 ID 计数器 */
  private notifSeq: number = 0

  constructor(config?: Partial<GuardianConfig>) {
    this.config = { ...DEFAULT_GUARDIAN_CONFIG, ...config }
  }

  /**
   * 评估节点执行状态
   * 每次工具调用批次完成后调用，返回监护记录（如有异常）
   */
  evaluate(node: TaskNode, toolCalls: ToolCallResult[]): GuardianRecord | null {
    // 记录指纹
    const fps = this.fingerprints.get(node.id) || []
    for (const tc of toolCalls) {
      fps.push(computeFingerprint(tc))
    }
    this.fingerprints.set(node.id, fps)

    // 记录结果
    const results = this.recentResults.get(node.id) || []
    results.push(...toolCalls)
    this.recentResults.set(node.id, results)

    // 检查有效进展（成功调用非只读工具 = 进展）
    const hasProgress = toolCalls.some(tc =>
      tc.status === 'success' && !isReadOnlyTool(tc.functionName)
    )
    if (hasProgress) {
      this.lastProgressAt.set(node.id, Date.now())
    }

    // 循环检测
    if (detectLoop(fps, this.config.loopThreshold)) {
      const evidence = fps.slice(-this.config.loopThreshold)
      const record = this.addRecord(node.id, {
        type: 'loop_detected',
        detail: `连续 ${this.config.loopThreshold} 次调用 ${evidence[0].functionName} 使用相同参数`,
        evidence,
        action: 'paused'
      })
      this.createNotification(node.id, 'loop', record.detail)
      return record
    }

    // 停滞检测
    if (detectStall(results, this.config.stallThreshold)) {
      const evidence = fps.slice(-this.config.stallThreshold)
      const record = this.addRecord(node.id, {
        type: 'stall_detected',
        detail: `连续 ${this.config.stallThreshold} 次工具调用失败，无有效进展`,
        evidence,
        action: 'paused'
      })
      this.createNotification(node.id, 'stall', record.detail)
      return record
    }

    // 预算检查（单节点）—— 先检查上限，再检查警告
    if (node.usage.toolCalls >= node.budget.maxToolCalls) {
      const record = this.addRecord(node.id, {
        type: 'budget_exceeded',
        detail: `节点工具调用数已达预算上限（${node.usage.toolCalls}/${node.budget.maxToolCalls}）`,
        evidence: [],
        action: 'paused'
      })
      this.createNotification(node.id, 'budget_exceeded', record.detail)
      return record
    }

    if (node.usage.toolCalls >= node.budget.maxToolCalls * 0.8) {
      const record = this.addRecord(node.id, {
        type: 'budget_warning',
        detail: `节点工具调用数已达预算 80%（${node.usage.toolCalls}/${node.budget.maxToolCalls}）`,
        evidence: [],
        action: 'notified'
      })
      this.createNotification(node.id, 'budget_warn', record.detail)
      return record
    }

    return null
  }

  /**
   * 获取待显示的通知（带去重冷却）
   */
  getNotification(nodeId: string): GuardianNotification | null {
    const notif = this.sentNotifications.get(nodeId)
    if (!notif) return null
    if (notif.shown) return null

    // 检查冷却期
    const now = Date.now()
    const recentNotifs = Array.from(this.sentNotifications.values())
      .filter(n => n.dedupKey === notif.dedupKey && n.timestamp > now - this.config.notificationCooldownMs)

    // 冷却期内已有同类通知
    if (recentNotifs.length > 1) {
      return null
    }

    return {
      id: notif.id,
      nodeId,
      type: notif.dedupKey.split(':')[0] || 'unknown',
      message: notif.dedupKey,
      timestamp: notif.timestamp,
      dedupKey: notif.dedupKey,
      shown: false
    }
  }

  /**
   * 用户已确认通知
   */
  acknowledgeNotification(notificationId: string): void {
    for (const [_key, notif] of this.sentNotifications) {
      if (notif.id === notificationId) {
        notif.shown = true
        break
      }
    }
  }

  /**
   * 获取某节点的监护记录
   */
  getRecords(nodeId: string): GuardianRecord[] {
    return this.records.get(nodeId) || []
  }

  /**
   * 获取所有监护记录
   */
  getAllRecords(): GuardianRecord[] {
    const all: GuardianRecord[] = []
    for (const records of this.records.values()) {
      all.push(...records)
    }
    return all.sort((a, b) => a.timestamp - b.timestamp)
  }

  /**
   * 按节点/分支汇总成本
   */
  getCostAttribution(tree: TaskTreeSnapshot): NodeCost[] {
    const costs: NodeCost[] = []

    for (const node of Object.values(tree.nodes)) {
      if (node.id === tree.rootId) continue

      costs.push({
        nodeId: node.id,
        title: node.title,
        iterations: node.usage.iterations,
        toolCalls: node.usage.toolCalls,
        elapsedMs: node.usage.elapsedMs,
        estimatedTokens: (node.usage.inputTokens || 0) + (node.usage.outputTokens || 0)
      })
    }

    return costs
  }

  /**
   * 重试时清除旧记录（保留证据）
   */
  resetNodeRecords(nodeId: string): void {
    // 清除指纹和结果记录，但保留监护记录以供审计
    this.fingerprints.delete(nodeId)
    this.recentResults.delete(nodeId)
    this.lastProgressAt.delete(nodeId)
    this.sentNotifications.delete(nodeId)
  }

  /**
   * 获取某节点的最后有效进展时间
   */
  getLastProgressAt(nodeId: string): number {
    return this.lastProgressAt.get(nodeId) || 0
  }

  /**
   * 获取某节点的最近工具调用指纹
   */
  getRecentFingerprints(nodeId: string): ToolFingerprint[] {
    return this.fingerprints.get(nodeId) || []
  }

  /**
   * 清除所有数据（树执行完毕后调用）
   */
  clear(): void {
    this.records.clear()
    this.fingerprints.clear()
    this.recentResults.clear()
    this.lastProgressAt.clear()
    this.sentNotifications.clear()
    this.notifSeq = 0
  }

  // ============ 内部方法 ============

  private addRecord(nodeId: string, partial: Omit<GuardianRecord, 'nodeId' | 'timestamp'>): GuardianRecord {
    const record: GuardianRecord = {
      nodeId,
      timestamp: Date.now(),
      ...partial
    }

    const existing = this.records.get(nodeId) || []
    existing.push(record)
    this.records.set(nodeId, existing)

    return record
  }

  private createNotification(nodeId: string, type: string, _message: string): void {
    const dedupKey = `${type}:${nodeId}`
    const now = Date.now()

    // 检查冷却期
    const existing = this.sentNotifications.get(nodeId)
    if (existing && existing.dedupKey === dedupKey &&
        now - existing.timestamp < this.config.notificationCooldownMs) {
      return // 冷却期内不重复
    }

    this.notifSeq++
    this.sentNotifications.set(nodeId, {
      dedupKey,
      timestamp: now,
      id: `notif-${this.notifSeq}`,
      shown: false
    })
  }
}

/** 全局监护器单例 */
export const executionGuardian = new ExecutionGuardian()
