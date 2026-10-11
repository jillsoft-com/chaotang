/**
 * 事件日志记录器 — 审计与导出
 *
 * 记录任务树执行过程中的所有事件，支持：
 * - JSON 格式导出（机器可读）
 * - Markdown 格式导出（人类可读时间线）
 * - 按 runId 管理日志
 *
 * 设计依据：朝堂任务树设计方案（修订版）第七节。
 */

import type { TaskStatus } from './task-tree'
import type { SchedulerEvent } from './task-scheduler'

// ============ 类型 ============

export interface EventLogEntry {
  seq: number
  runId: string
  nodeId?: string
  timestamp: number
  type: string
  data?: any
  prevState?: TaskStatus
  newState?: TaskStatus
}

// ============ 日志记录器 ============

class EventLogger {
  private logs: Map<string, EventLogEntry[]> = new Map()
  private seqCounters: Map<string, number> = new Map()

  /**
   * 记录一条事件
   */
  record(event: SchedulerEvent, prevState?: TaskStatus, newState?: TaskStatus): void {
    const runId = event.runId
    const counter = (this.seqCounters.get(runId) || 0) + 1
    this.seqCounters.set(runId, counter)

    const entry: EventLogEntry = {
      seq: counter,
      runId: event.runId,
      nodeId: event.nodeId,
      timestamp: Date.now(),
      type: event.type,
      data: event.data,
      prevState,
      newState
    }

    const existing = this.logs.get(runId) || []
    existing.push(entry)
    this.logs.set(runId, existing)
  }

  /**
   * 获取某次运行的的所有日志
   */
  getLogs(runId: string): EventLogEntry[] {
    return this.logs.get(runId) || []
  }

  /**
   * 导出为 JSON 字符串
   */
  exportJSON(runId: string): string {
    const logs = this.getLogs(runId)
    return JSON.stringify({
      runId,
      exportedAt: new Date().toISOString(),
      totalEvents: logs.length,
      events: logs
    }, null, 2)
  }

  /**
   * 导出为 Markdown 时间线
   */
  exportMarkdown(runId: string): string {
    const logs = this.getLogs(runId)
    if (logs.length === 0) return '# 事件日志\n\n无记录。'

    const lines: string[] = [
      `# 任务树执行日志`,
      ``,
      `**Run ID**: ${runId}`,
      `**导出时间**: ${new Date().toISOString()}`,
      `**事件总数**: ${logs.length}`,
      ``,
      `## 时间线`,
      ``
    ]

    for (const entry of logs) {
      const time = new Date(entry.timestamp).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
      const icon = this.getTypeIcon(entry.type)
      const nodeInfo = entry.nodeId ? ` [${entry.nodeId.slice(0, 12)}]` : ''
      const stateInfo = entry.prevState && entry.newState
        ? ` (${entry.prevState} → ${entry.newState})`
        : ''

      lines.push(`- **${time}** ${icon} \`${entry.type}\`${nodeInfo}${stateInfo}`)

      // 添加关键事件的详情
      if (entry.data) {
        const detail = this.formatData(entry.type, entry.data)
        if (detail) {
          lines.push(`  > ${detail}`)
        }
      }
    }

    return lines.join('\n')
  }

  /**
   * 清除某次运行的日志
   */
  clear(runId: string): void {
    this.logs.delete(runId)
    this.seqCounters.delete(runId)
  }

  /**
   * 清除所有日志
   */
  clearAll(): void {
    this.logs.clear()
    this.seqCounters.clear()
  }

  // ============ 内部方法 ============

  private getTypeIcon(type: string): string {
    const icons: Record<string, string> = {
      'tree-created': '🌳',
      'node-ready': '✅',
      'node-started': '▶️',
      'node-completed': '🎉',
      'node-failed': '❌',
      'node-paused': '⏸️',
      'node-skipped': '⏭️',
      'tree-completed': '🏁',
      'tree-failed': '💥',
      'guardian-paused': '🛡️',
      'guardian-warning': '⚠️',
      'guardian-retry': '🔄',
      'error': '🔴'
    }
    return icons[type] || '📌'
  }

  private formatData(type: string, data: any): string | null {
    if (!data) return null

    if (type === 'node-completed' || type === 'node-failed') {
      if (data.result?.content) {
        const preview = data.result.content.slice(0, 100)
        return preview.length < data.result.content.length ? `${preview}...` : preview
      }
    }

    if (type === 'guardian-paused' || type === 'guardian-warning') {
      return data.record?.detail || null
    }

    if (type === 'error') {
      return data.reason || data.error || null
    }

    return null
  }
}

/** 全局事件日志记录器单例 */
export const eventLogger = new EventLogger()
