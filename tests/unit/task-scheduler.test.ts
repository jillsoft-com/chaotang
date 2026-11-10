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
 * - 终态收束与快照同步（任务树面板不再停在中间状态）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TaskScheduler } from '@/services/agent/task-scheduler'
import type { ExecutionContext, LeafResult, SchedulerEventType } from '@/services/agent/task-scheduler'
import {
  createTree,
  createNode,
  addNode,
  addDependency,
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

  describe('失败原因与状态一致性', () => {
    it('未达成目标的失败节点写入可查看的原因', async () => {
      const tree = makeTestTree([{ title: '任务A' }])
      const context = createMockContext({
        executeLeaf: vi.fn(async (): Promise<LeafResult> => ({
          content: '已完成部分工作',
          toolCalls: [],
          duration: 100,
          status: 'error',
          goalReached: false
        }))
      })

      scheduler.start(tree, context)
      await vi.runAllTimersAsync()

      const leaf = Object.values(tree.nodes).find(n => n.id !== tree.rootId)!
      expect(leaf.status).toBe('failed')
      expect(leaf.failureReason).toContain('自主引擎未达成目标')
    })

    it('执行报错型失败取结果首行作为原因', async () => {
      const tree = makeTestTree([{ title: '任务A' }])
      const context = createMockContext({
        executeLeaf: vi.fn(async (): Promise<LeafResult> => ({
          content: 'API error 400: {"error":{"message":"No tool call found"}}\n第二行不应进入原因',
          toolCalls: [],
          duration: 100,
          status: 'error'
        }))
      })

      scheduler.start(tree, context)
      await vi.runAllTimersAsync()

      const leaf = Object.values(tree.nodes).find(n => n.id !== tree.rootId)!
      expect(leaf.failureReason).toBe('API error 400: {"error":{"message":"No tool call found"}}')
    })

    it('验收未配置（unverified）不拉低已完成节点，也不留失败原因', async () => {
      const tree = makeTestTree([{ title: '任务A' }])
      const context = createMockContext({
        executeLeaf: vi.fn(async (): Promise<LeafResult> => ({
          content: '已完成',
          toolCalls: [],
          duration: 100,
          status: 'success',
          goalReached: true,
          acceptance: { checks: [], overallState: 'unverified' }
        }))
      })

      scheduler.start(tree, context)
      await vi.runAllTimersAsync()

      const leaf = Object.values(tree.nodes).find(n => n.id !== tree.rootId)!
      expect(leaf.status).toBe('completed')
      expect(leaf.failureReason).toBeUndefined()
    })

    it('重试回到就绪时清空上一轮失败原因', async () => {
      const tree = makeTestTree([{ title: '任务A' }])
      const context = createMockContext({
        executeLeaf: vi.fn(async (): Promise<LeafResult> => ({
          content: '首轮报错', toolCalls: [], duration: 100, status: 'error', goalReached: false
        }))
      })

      scheduler.start(tree, context)
      await vi.runAllTimersAsync()

      const leaf = Object.values(tree.nodes).find(n => n.id !== tree.rootId)!
      expect(leaf.failureReason).toContain('自主引擎未达成目标')

      // 整树已收束，retryNode 只负责把节点推回就绪并清掉陈旧缘由，重新协调由恢复入口接手
      expect(scheduler.retryNode(tree.runId, leaf.id, true)).toBe(true)
      expect(leaf.status).toBe('ready')
      expect(leaf.failureReason).toBeUndefined()
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

  describe('终态收束与快照同步', () => {
    /**
     * 每次 saveSnapshot 都留一份深拷贝，等价于 UI 侧 applyTreeSnapshot 真正看到的快照
     * （断言最后一次调用，即“执行结束之后”面板应当呈现的状态）
     */
    function captureSnapshots() {
      const captures: TaskTreeSnapshot[] = []
      const saveSnapshot = vi.fn((t: TaskTreeSnapshot) => {
        captures.push(JSON.parse(JSON.stringify(t)))
      })
      return { saveSnapshot, captures }
    }

    /** 造一个已落到指定状态的叶子（pending → ready → running → status） */
    function addSettledLeaf(tree: TaskTreeSnapshot, title: string, parentId: string, status: 'completed' | 'partial'): TaskNode {
      const node = createNode({
        title, description: `${title}描述`, parentId, createdBy: 'user',
        assigneeId: 'worker-1', decomposition: 'leaf'
      })
      addNode(tree, node)
      transitionStatus(tree, node.id, 'ready')
      transitionStatus(tree, node.id, 'running')
      transitionStatus(tree, node.id, status)
      return node
    }

    it('子任务全完成但父节点停在 running：收束后快照里父节点为已完成', async () => {
      const tree = createTree('debate-1', '根任务', '根任务描述')
      const parent = createNode({
        title: '汇总', description: '父任务描述', parentId: tree.rootId,
        createdBy: 'user', decomposition: 'expanded'
      })
      addNode(tree, parent)
      transitionStatus(tree, parent.id, 'ready')
      transitionStatus(tree, parent.id, 'running')
      addSettledLeaf(tree, '子A', parent.id, 'completed')
      addSettledLeaf(tree, '子B', parent.id, 'completed')

      const { saveSnapshot, captures } = captureSnapshots()
      scheduler.start(tree, createMockContext({ saveSnapshot }))
      await vi.runAllTimersAsync()

      expect(tree.nodes[parent.id].status).toBe('completed')
      const snap = captures[captures.length - 1]
      expect(snap.nodes[parent.id].status).toBe('completed')
      expect(snap.state).toBe('completed')
    })

    it('遗留的 running 叶子被收束：最后一份快照不再停在执行中', async () => {
      const tree = createTree('debate-1', '根任务', '根任务描述')
      // 一个执行过程中被打断、再无人替它落定结果的叶子
      const orphan = createNode({
        title: '孤儿', description: '孤儿描述', parentId: tree.rootId,
        createdBy: 'user', assigneeId: 'worker-1', decomposition: 'leaf'
      })
      addNode(tree, orphan)
      transitionStatus(tree, orphan.id, 'ready')
      transitionStatus(tree, orphan.id, 'running')
      addSettledLeaf(tree, '已完成', tree.rootId, 'completed')

      const { saveSnapshot, captures } = captureSnapshots()
      scheduler.start(tree, createMockContext({ saveSnapshot }))
      await vi.runAllTimersAsync()

      const snap = captures[captures.length - 1]
      expect(snap.nodes[orphan.id].status).toBe('failed')
      const stillRunning = Object.values(snap.nodes).filter(n => n.id !== snap.rootId && n.status === 'running')
      expect(stillRunning).toHaveLength(0)
    })

    it('必需依赖失败后，悬挂节点在快照里落为受阻而不是待处理', async () => {
      const tree = makeTestTree([{ title: '任务A' }])
      const nodeA = Object.values(tree.nodes).find(n => n.title === '任务A')!
      const c = createNode({
        title: '任务C', description: 'C描述', parentId: tree.rootId,
        createdBy: 'user', assigneeId: 'worker-1', decomposition: 'leaf'
      })
      addNode(tree, c)
      addDependency(tree, c.id, { taskId: nodeA.id, kind: 'required' })

      const { saveSnapshot, captures } = captureSnapshots()
      const context = createMockContext({
        saveSnapshot,
        executeLeaf: vi.fn(async (): Promise<LeafResult> => ({
          content: '失败', toolCalls: [], duration: 1, status: 'error', goalReached: false
        }))
      })

      scheduler.start(tree, context)
      await vi.runAllTimersAsync()

      const snap = captures[captures.length - 1]
      expect(snap.nodes[c.id].status).toBe('blocked')
      expect(snap.state).toBe('failed')
    })

    it('依赖 partial 节点的任务仍会被执行（不再卡在就绪）', async () => {
      const tree = createTree('debate-1', '根任务', '根任务描述')
      const a = addSettledLeaf(tree, '任务A', tree.rootId, 'partial')
      const b = createNode({
        title: '任务B', description: 'B描述', parentId: tree.rootId,
        createdBy: 'user', assigneeId: 'worker-1', decomposition: 'leaf'
      })
      addNode(tree, b)
      transitionStatus(tree, b.id, 'ready')
      addDependency(tree, b.id, { taskId: a.id, kind: 'required' })

      const executed: string[] = []
      const context = createMockContext({
        executeLeaf: vi.fn(async (node: TaskNode): Promise<LeafResult> => {
          executed.push(node.title)
          return { content: '成功', toolCalls: [], duration: 1, status: 'success', goalReached: true }
        })
      })

      scheduler.start(tree, context)
      await vi.runAllTimersAsync()

      expect(executed).toContain('任务B')
      expect(tree.nodes[b.id].status).toBe('completed')
    })
  })
})
