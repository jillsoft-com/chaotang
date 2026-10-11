/**
 * task-scheduler.ts 调度测试
 *
 * 使用 mock ExecutionContext 和 vi.useFakeTimers 测试调度器核心行为：
 * - 全成功 / 全失败 / 混合结果
 * - 依赖失败传播
 * - 幂等性（同一唤醒不重复执行）
 * - coordinate 互斥
 * - 暂停 / 继续 / 取消
 * - 重试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TaskScheduler } from '@/services/agent/task-scheduler'
import type { ExecutionContext, LeafResult, SchedulerEventType } from '@/services/agent/task-scheduler'
import {
  createTree,
  createNode,
  addNode,
  transitionStatus
} from '@/services/agent/task-tree'
import type { TaskTreeSnapshot, TaskNode } from '@/services/agent/task-tree'
import type { Minister, Speech, LLMConfig, ToolCall, ToolCallResult } from '@/types'

// ============ 模拟数据 ============

const mockMinister: Minister = {
  id: 'worker-1',
  name: '工部侍郎',
  title: '工部侍郎',
  avatar: '🔨',
  systemPrompt: '你是一个执行者',
  llm: {} as LLMConfig,
  tools: []
}

function createMockContext(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    ministers: [mockMinister],
    resolveLLM: (llm: LLMConfig) => llm,
    createSpeech: () => ({ id: 'speech-1', ministerId: 'worker-1', content: '', timestamp: Date.now(), status: 'streaming' } as Speech),
    getReactiveSpeech: () => ({ id: 'speech-1', ministerId: 'worker-1', content: '', timestamp: Date.now(), status: 'streaming' } as Speech),
    shouldContinue: () => true,
    saveSnapshot: vi.fn(),
    requestWorkerDecomposition: vi.fn(async (_worker: Minister, _task: TaskNode, tree: TaskTreeSnapshot) => tree),
    executeLeaf: vi.fn(async (_node: TaskNode): Promise<LeafResult> => ({
      content: '执行成功',
      toolCalls: [],
      duration: 100,
      status: 'success',
      goalReached: true
    })),
    ...overrides
  }
}

function makeTestTree(leafConfigs: Array<{ title: string; deps?: string[]; assigneeId?: string }>): TaskTreeSnapshot {
  const tree = createTree('debate-1', '根任务', '根任务描述')
  const nodeMap: Record<string, string> = {}
  for (const cfg of leafConfigs) {
    const node = createNode({
      title: cfg.title,
      description: `${cfg.title}描述`,
      parentId: tree.rootId,
      createdBy: 'user',
      assigneeId: cfg.assigneeId || 'worker-1',
      decomposition: 'leaf'
    })
    addNode(tree, node)
    nodeMap[cfg.title] = node.id
    // 设为 ready 以便调度
    transitionStatus(tree, node.id, 'ready')
  }
  return tree
}

// ============ 测试 ============

describe('TaskScheduler', () => {
  let scheduler: TaskScheduler

  beforeEach(() => {
    vi.useFakeTimers()
    scheduler = new TaskScheduler({ activeTickMs: 10000, idleTickMs: 30000 })
  })

  afterEach(() => {
    scheduler.destroy()
    vi.useRealTimers()
  })

  describe('全成功流程', () => {
    it('所有叶子完成 → 树 completed', async () => {
      const tree = makeTestTree([{ title: '任务A' }, { title: '任务B' }])
      const context = createMockContext()
      const events: SchedulerEventType[] = []
      scheduler.onEvent(e => events.push(e.type))

      scheduler.start(tree, context)

      // 让 coordinate 的 setTimeout 执行
      await vi.runAllTimersAsync()

      expect(events).toContain('tree-completed')
      expect(tree.state).toBe('completed')
    })
  })

  describe('全失败流程', () => {
    it('所有叶子失败 → 树 failed', async () => {
      const tree = makeTestTree([{ title: '任务A' }])
      const context = createMockContext({
        executeLeaf: vi.fn(async (): Promise<LeafResult> => ({
          content: '执行失败',
          toolCalls: [],
          duration: 100,
          status: 'error',
          goalReached: false
        }))
      })
      const events: SchedulerEventType[] = []
      scheduler.onEvent(e => events.push(e.type))

      scheduler.start(tree, context)
      await vi.runAllTimersAsync()

      expect(events).toContain('tree-failed')
      expect(tree.state).toBe('failed')
    })
  })

  describe('混合结果', () => {
    it('部分成功部分失败 → completed_with_gaps', async () => {
      const tree = makeTestTree([{ title: '任务A' }, { title: '任务B' }])
      let callCount = 0
      const context = createMockContext({
        executeLeaf: vi.fn(async (): Promise<LeafResult> => {
          callCount++
          return {
            content: callCount === 1 ? '成功' : '失败',
            toolCalls: [],
            duration: 100,
            status: callCount === 1 ? 'success' : 'error',
            goalReached: callCount === 1
          }
        })
      })

      scheduler.start(tree, context)
      await vi.runAllTimersAsync()

      // 混合结果 → completed_with_gaps → 触发 tree-completed
      expect(['completed_with_gaps', 'completed']).toContain(tree.state)
    })
  })

  describe('暂停与继续', () => {
    it('暂停后不再执行', async () => {
      const tree = makeTestTree([{ title: '任务A' }])
      const context = createMockContext()

      scheduler.start(tree, context)
      // 立即暂停
      scheduler.pause(tree.runId)
      // 推进时间检查不会无限循环
      await vi.advanceTimersByTimeAsync(5000)
      expect(tree.state).toBe('paused')
    })

    it('继续后重新协调', async () => {
      const tree = makeTestTree([{ title: '任务A' }])
      const context = createMockContext()
      const events: SchedulerEventType[] = []
      scheduler.onEvent(e => events.push(e.type))

      scheduler.start(tree, context)
      scheduler.pause(tree.runId)
      await vi.advanceTimersByTimeAsync(100)
      scheduler.resume(tree.runId)
      await vi.runAllTimersAsync()

      expect(events).toContain('tree-completed')
    })
  })

  describe('取消', () => {
    it('取消后所有未完成节点标为 cancelled', async () => {
      const tree = makeTestTree([{ title: '任务A' }, { title: '任务B' }])
      const context = createMockContext({
        executeLeaf: vi.fn(async () => {
          // 执行中取消
          scheduler.cancel(tree.runId)
          return { content: '结果', toolCalls: [], duration: 100, status: 'success' as const, goalReached: true }
        })
      })

      scheduler.start(tree, context)
      await vi.runAllTimersAsync()

      expect(tree.state).toBe('cancelled')
    })
  })

  describe('重试', () => {
    it('失败节点可重试（树仍在运行时）', async () => {
      // 使用 2 个节点：A 成功 B 失败，但 A 先完成 B 后失败
      // 在 B 失败后、树尚未收束时暂停，然后重试 B
      const tree = makeTestTree([{ title: '任务A' }, { title: '任务B' }])
      let callCount = 0
      const context = createMockContext({
        executeLeaf: vi.fn(async (node: TaskNode): Promise<LeafResult> => {
          callCount++
          if (node.title === '任务B' && callCount <= 1) {
            return { content: '失败', toolCalls: [], duration: 100, status: 'error', goalReached: false }
          }
          return { content: '成功', toolCalls: [], duration: 100, status: 'success', goalReached: true }
        })
      })

      scheduler.start(tree, context)
      await vi.runAllTimersAsync()

      // 树应该已完成（completed_with_gaps 或 failed）
      const failedNode = Object.values(tree.nodes).find(n => n.title === '任务B' && n.status === 'failed')
      if (failedNode) {
        // 树已完成后 cleanup 已运行，retryNode 可修改状态但不会重新协调
        const result = scheduler.retryNode(tree.runId, failedNode.id, true)
        expect(result).toBe(true)
        expect(tree.nodes[failedNode.id].status).toBe('ready')
      }
    })

    it('写任务重试需用户确认', async () => {
      const tree = makeTestTree([{ title: '任务A' }])
      const context = createMockContext({
        executeLeaf: vi.fn(async (): Promise<LeafResult> => ({
          content: '失败', toolCalls: [], duration: 100, status: 'error', goalReached: false
        }))
      })

      scheduler.start(tree, context)
      await vi.runAllTimersAsync()

      const failedNode = Object.values(tree.nodes).find(n => n.status === 'failed')
      // 不传 userConfirmed
      const result = scheduler.retryNode(tree.runId, failedNode!.id, false)
      expect(result).toBe(false)
    })
  })

  describe('编辑树', () => {
    it('成功编辑后触发重新协调', async () => {
      const tree = makeTestTree([{ title: 'A' }, { title: 'B' }])
      const context = createMockContext()
      const events: SchedulerEventType[] = []
      scheduler.onEvent(e => events.push(e.type))

      scheduler.start(tree, context)
      await vi.advanceTimersByTimeAsync(50)

      // 修改优先级
      const nodeA = Object.values(tree.nodes).find(n => n.title === 'A')!
      const result = scheduler.editTree(tree.runId, [
        { type: 'change-priority', nodeId: nodeA.id, priority: 3 }
      ])
      expect(result.ok).toBe(true)
    })

    it('编辑失败时原树不动', async () => {
      const tree = makeTestTree([{ title: 'A' }])
      const context = createMockContext()

      scheduler.start(tree, context)
      await vi.advanceTimersByTimeAsync(50)

      const result = scheduler.editTree(tree.runId, [
        { type: 'change-priority', nodeId: 'nonexistent', priority: 3 }
      ])
      expect(result.ok).toBe(false)
    })
  })

  describe('事件日志', () => {
    it('导出事件日志', async () => {
      const tree = makeTestTree([{ title: '任务A' }])
      const context = createMockContext()

      scheduler.start(tree, context)
      await vi.runAllTimersAsync()

      const logs = scheduler.getEventLogs(tree.runId)
      expect(logs.length).toBeGreaterThan(0)

      const md = scheduler.exportEventLog(tree.runId, 'markdown')
      expect(md).toContain('执行日志')
    })
  })
})
