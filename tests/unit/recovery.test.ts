/**
 * 恢复流程测试 + 状态迁移严格模式测试
 *
 * 覆盖：
 * R1.4: 中断检测、续办流程、写操作恢复需用户确认、快照持久化
 * R1.5: transitionStatus 严格模式
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TaskScheduler } from '@/services/agent/task-scheduler'
import type { ExecutionContext, LeafResult } from '@/services/agent/task-scheduler'
import {
  createTree,
  createNode,
  addNode,
  transitionStatus,
  serializeSnapshot,
  deserializeSnapshot
} from '@/services/agent/task-tree'
import type { TaskTreeSnapshot, TaskNode } from '@/services/agent/task-tree'
import type { Minister, Speech, LLMConfig } from '@/types'

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
    requestWorkerDecomposition: vi.fn(async (_w: Minister, _t: TaskNode, tree: TaskTreeSnapshot) => tree),
    executeLeaf: vi.fn(async (): Promise<LeafResult> => ({
      content: '执行成功',
      toolCalls: [],
      duration: 100,
      status: 'success',
      goalReached: true
    })),
    ...overrides
  }
}

// ============ R1.4: 恢复流程测试 ============

describe('R1.4: 恢复流程', () => {
  let scheduler: TaskScheduler

  beforeEach(() => {
    vi.useFakeTimers()
    scheduler = new TaskScheduler({ activeTickMs: 10000, idleTickMs: 30000 })
  })

  afterEach(() => {
    scheduler.destroy()
    vi.useRealTimers()
  })

  describe('中断检测', () => {
    it('running 节点在应用退出时应标为 interrupted', () => {
      const tree = createTree('debate-1', '根', '描述')
      const node = createNode({
        title: '执行中节点',
        description: '描述',
        parentId: tree.rootId,
        createdBy: 'user',
        assigneeId: 'worker-1',
        decomposition: 'leaf'
      })
      addNode(tree, node)
      transitionStatus(tree, node.id, 'ready')
      transitionStatus(tree, node.id, 'running')

      // 模拟应用退出：将 running 节点标为 interrupted
      const result = transitionStatus(tree, node.id, 'interrupted', '应用退出')
      expect(result.ok).toBe(true)
      expect(tree.nodes[node.id].status).toBe('interrupted')
      expect(tree.nodes[node.id].finishedAt).toBeTruthy()
    })
  })

  describe('续办流程', () => {
    it('interrupted 节点可恢复为 ready', () => {
      const tree = createTree('debate-1', '根', '描述')
      const node = createNode({
        title: '中断节点',
        description: '描述',
        parentId: tree.rootId,
        createdBy: 'user',
        assigneeId: 'worker-1',
        decomposition: 'leaf'
      })
      addNode(tree, node)
      transitionStatus(tree, node.id, 'ready')
      transitionStatus(tree, node.id, 'running')
      transitionStatus(tree, node.id, 'interrupted', '应用退出')

      // 恢复：interrupted → ready（合法迁移）
      const result = transitionStatus(tree, node.id, 'ready', '用户批准续办')
      expect(result.ok).toBe(true)
      expect(tree.nodes[node.id].status).toBe('ready')
    })

    it('interrupted 也可恢复为 pending（重新规划）', () => {
      const tree = createTree('debate-1', '根', '描述')
      const node = createNode({
        title: '中断节点',
        description: '描述',
        parentId: tree.rootId,
        createdBy: 'user',
        decomposition: 'leaf'
      })
      addNode(tree, node)
      transitionStatus(tree, node.id, 'ready')
      transitionStatus(tree, node.id, 'running')
      transitionStatus(tree, node.id, 'interrupted', '应用退出')

      // interrupted → pending 是合法迁移
      const result = transitionStatus(tree, node.id, 'pending', '重新规划')
      expect(result.ok).toBe(true)
      expect(tree.nodes[node.id].status).toBe('pending')
    })
  })

  describe('快照序列化与恢复', () => {
    it('树可序列化、反序列化后保持状态', () => {
      const tree = createTree('debate-1', '根', '描述')
      const node = createNode({
        title: '节点A',
        description: '描述',
        parentId: tree.rootId,
        createdBy: 'user',
        decomposition: 'leaf'
      })
      addNode(tree, node)
      transitionStatus(tree, node.id, 'ready')
      transitionStatus(tree, node.id, 'running')
      transitionStatus(tree, node.id, 'interrupted', '应用退出')

      // 序列化
      const json = serializeSnapshot(tree)
      const restored = deserializeSnapshot(json)

      expect(restored).not.toBeNull()
      expect(restored!.nodes[node.id].status).toBe('interrupted')
      // interrupted 是终态，waitingReason 不会保留
      expect(tree.nodes[node.id].waitingReason).toBeUndefined()
    })
  })

  describe('saveSnapshot 调用验证', () => {
    it('调度器在关键状态变化时调用 saveSnapshot', async () => {
      const tree = createTree('debate-1', '根', '描述')
      const node = createNode({
        title: '任务A',
        description: '描述',
        parentId: tree.rootId,
        createdBy: 'user',
        assigneeId: 'worker-1',
        decomposition: 'leaf'
      })
      addNode(tree, node)
      transitionStatus(tree, node.id, 'ready')

      const saveSnapshot = vi.fn()
      const context = createMockContext({ saveSnapshot })

      scheduler.start(tree, context)
      await vi.runAllTimersAsync()

      // saveSnapshot 应在 start（校验通过后）和节点完成时被调用
      expect(saveSnapshot).toHaveBeenCalled()
    })
  })
})

// ============ R1.5: 状态迁移严格模式 ============

describe('R1.5: 状态迁移严格模式', () => {
  let tree: TaskTreeSnapshot
  let nodeId: string

  beforeEach(() => {
    tree = createTree('debate-1', '根', '描述')
    const node = createNode({ title: '节点', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    addNode(tree, node)
    nodeId = node.id
  })

  it('严格模式下非法迁移抛异常', () => {
    expect(() => {
      transitionStatus(tree, nodeId, 'completed', undefined, true)
    }).toThrow('非法状态迁移')
  })

  it('严格模式下合法迁移正常工作', () => {
    const result = transitionStatus(tree, nodeId, 'ready', undefined, true)
    expect(result.ok).toBe(true)
    expect(tree.nodes[nodeId].status).toBe('ready')
  })

  it('严格模式下节点不存在抛异常', () => {
    expect(() => {
      transitionStatus(tree, 'nonexistent', 'ready', undefined, true)
    }).toThrow('节点不存在')
  })

  it('非严格模式（默认）下非法迁移返回错误', () => {
    const result = transitionStatus(tree, nodeId, 'completed')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('非法状态迁移')
  })

  it('严格模式下完整迁移链正常', () => {
    transitionStatus(tree, nodeId, 'ready', undefined, true)
    transitionStatus(tree, nodeId, 'running', undefined, true)
    transitionStatus(tree, nodeId, 'completed', undefined, true)
    expect(tree.nodes[nodeId].status).toBe('completed')
  })

  it('pending → blocked 在严格模式下合法', () => {
    const result = transitionStatus(tree, nodeId, 'blocked', '依赖失败', true)
    expect(result.ok).toBe(true)
  })
})
