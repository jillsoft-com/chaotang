/**
 * 逐层汇总测试
 *
 * 覆盖：
 * - 父节点汇总：子节点全终态时生成 ParentSummary
 * - 子节点未全终态时返回 null
 * - 汇总失败不伪装成完成
 * - 根节点上下文裁剪
 * - 兄弟节点上下文构建
 */

import { describe, it, expect } from 'vitest'
import {
  generateParentSummary,
  buildRootContext,
  buildSiblingContext
} from '@/services/agent/hierarchical-summary'
import type { TaskTreeSnapshot, TaskNode, TaskStatus } from '@/services/agent/task-tree'

function makeNode(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: 'node-1',
    parentId: null,
    childIds: [],
    title: 'Test Node',
    description: 'Test description',
    createdBy: 'user',
    assigneeId: null,
    requiredForParent: true,
    mode: 'action',
    autonomous: false,
    decomposition: 'leaf',
    dependencies: [],
    priority: 1,
    readOnly: false,
    allowedToolNames: [],
    requiresApproval: false,
    acceptance: [],
    status: 'pending',
    verification: 'none',
    unresolvedQuestions: [],
    inputRefs: [],
    evidenceRefs: [],
    budget: { maxIterations: 10, maxToolCalls: 50, timeoutMs: 300000 },
    usage: { iterations: 0, toolCalls: 0, elapsedMs: 0 },
    maxRetries: 2,
    attempt: 0,
    revision: 0,
    createdAt: Date.now(),
    ...overrides
  }
}

function makeTree(): TaskTreeSnapshot {
  const root = makeNode({
    id: 'root',
    title: 'Root Task',
    description: 'Complete the project',
    status: 'running' as TaskStatus,
    childIds: ['child-1', 'child-2', 'child-3']
  })

  return {
    schemaVersion: 1,
    runId: 'run-1',
    debateId: 'debate-1',
    rootId: 'root',
    nodes: { 'root': root },
    planRevision: 0,
    usage: { iterations: 0, toolCalls: 0, elapsedMs: 0 },
    state: 'running',
    limits: {
      maxDepth: 3, maxChildren: 5, maxNodes: 20,
      maxIterationsPerLeaf: 10, maxToolCallsPerRun: 200
    },
    updatedAt: Date.now()
  }
}

describe('generateParentSummary', () => {
  it('子节点全部 completed 生成汇总', () => {
    const tree = makeTree()
    tree.nodes['child-1'] = makeNode({
      id: 'child-1', parentId: 'root', title: 'Task A',
      status: 'completed', resultSummary: 'Done A',
      evidenceRefs: ['ref-1', 'ref-2']
    })
    tree.nodes['child-2'] = makeNode({
      id: 'child-2', parentId: 'root', title: 'Task B',
      status: 'completed', resultSummary: 'Done B',
      evidenceRefs: ['ref-3']
    })
    tree.nodes['child-3'] = makeNode({
      id: 'child-3', parentId: 'root', title: 'Task C',
      status: 'completed', resultSummary: 'Done C'
    })

    const result = generateParentSummary(tree, 'root')
    expect(result).not.toBeNull()
    expect(result!.summary.completed).toHaveLength(3)
    expect(result!.summary.failed).toHaveLength(0)
    expect(result!.evidenceRefs).toContain('ref-1')
    expect(result!.evidenceRefs).toContain('ref-2')
    expect(result!.evidenceRefs).toContain('ref-3')
  })

  it('子节点未全部终态时返回 null', () => {
    const tree = makeTree()
    tree.nodes['child-1'] = makeNode({
      id: 'child-1', parentId: 'root', title: 'Task A',
      status: 'completed'
    })
    tree.nodes['child-2'] = makeNode({
      id: 'child-2', parentId: 'root', title: 'Task B',
      status: 'running'
    })
    tree.nodes['child-3'] = makeNode({
      id: 'child-3', parentId: 'root', title: 'Task C',
      status: 'pending'
    })

    expect(generateParentSummary(tree, 'root')).toBeNull()
  })

  it('混合结果：completed + failed', () => {
    const tree = makeTree()
    tree.nodes['child-1'] = makeNode({
      id: 'child-1', parentId: 'root', title: 'Task A',
      status: 'completed'
    })
    tree.nodes['child-2'] = makeNode({
      id: 'child-2', parentId: 'root', title: 'Task B',
      status: 'failed'
    })
    tree.nodes['child-3'] = makeNode({
      id: 'child-3', parentId: 'root', title: 'Task C',
      status: 'completed'
    })

    const result = generateParentSummary(tree, 'root')
    expect(result).not.toBeNull()
    expect(result!.summary.completed).toHaveLength(2)
    expect(result!.summary.failed).toHaveLength(1)
    expect(result!.summary.conflicts.length).toBeGreaterThan(0)
  })

  it('blocked 和 skipped 计入缺口', () => {
    const tree = makeTree()
    tree.nodes['child-1'] = makeNode({
      id: 'child-1', parentId: 'root', title: 'Task A',
      status: 'completed'
    })
    tree.nodes['child-2'] = makeNode({
      id: 'child-2', parentId: 'root', title: 'Task B',
      status: 'blocked'
    })
    tree.nodes['child-3'] = makeNode({
      id: 'child-3', parentId: 'root', title: 'Task C',
      status: 'skipped'
    })

    const result = generateParentSummary(tree, 'root')
    expect(result!.summary.blocked).toHaveLength(1)
    expect(result!.summary.skipped).toHaveLength(1)
    expect(result!.summary.gaps.length).toBeGreaterThan(0)
  })

  it('汇总失败不伪装成完成', () => {
    const tree = makeTree()
    tree.nodes['child-1'] = makeNode({
      id: 'child-1', parentId: 'root', title: 'Task A',
      status: 'failed'
    })
    tree.nodes['child-2'] = makeNode({
      id: 'child-2', parentId: 'root', title: 'Task B',
      status: 'failed'
    })
    tree.nodes['child-3'] = makeNode({
      id: 'child-3', parentId: 'root', title: 'Task C',
      status: 'failed'
    })

    const result = generateParentSummary(tree, 'root')
    expect(result!.summary.completed).toHaveLength(0)
    expect(result!.summary.failed).toHaveLength(3)
    expect(result!.summaryText).toContain('❌')
    expect(result!.summaryText).not.toContain('✅')
  })

  it('证据引用去重', () => {
    const tree = makeTree()
    tree.nodes['child-1'] = makeNode({
      id: 'child-1', parentId: 'root', title: 'Task A',
      status: 'completed', evidenceRefs: ['ref-1', 'ref-2']
    })
    tree.nodes['child-2'] = makeNode({
      id: 'child-2', parentId: 'root', title: 'Task B',
      status: 'completed', evidenceRefs: ['ref-2', 'ref-3']
    })
    tree.nodes['child-3'] = makeNode({
      id: 'child-3', parentId: 'root', title: 'Task C',
      status: 'completed', evidenceRefs: ['ref-1']
    })

    const result = generateParentSummary(tree, 'root')
    expect(result!.evidenceRefs).toHaveLength(3) // ref-1, ref-2, ref-3
  })

  it('父节点不存在返回 null', () => {
    const tree = makeTree()
    expect(generateParentSummary(tree, 'nonexistent')).toBeNull()
  })

  it('叶子节点（无子节点）返回 null', () => {
    const tree = makeTree()
    tree.nodes['leaf'] = makeNode({ id: 'leaf', title: 'Leaf', childIds: [] })
    expect(generateParentSummary(tree, 'leaf')).toBeNull()
  })
})

describe('buildRootContext', () => {
  it('生成根节点精简上下文', () => {
    const tree = makeTree()
    tree.nodes['child-1'] = makeNode({
      id: 'child-1', parentId: 'root', title: 'Task A',
      status: 'completed', resultSummary: 'Created file A',
      decomposition: 'leaf'
    })
    tree.nodes['child-2'] = makeNode({
      id: 'child-2', parentId: 'root', title: 'Task B',
      status: 'failed', resultSummary: 'Failed to build',
      decomposition: 'leaf'
    })
    tree.nodes['child-3'] = makeNode({
      id: 'child-3', parentId: 'root', title: 'Task C',
      status: 'running',
      decomposition: 'leaf'
    })

    const ctx = buildRootContext(tree, 'root')
    expect(ctx).toContain('Complete the project')
    expect(ctx).toContain('Task A')
    expect(ctx).toContain('Created file A')
    expect(ctx).toContain('Task B')
    expect(ctx).toContain('✅')
    expect(ctx).toContain('❌')
    expect(ctx).toContain('🔄')
  })

  it('展开的子节点附加汇总', () => {
    const tree = makeTree()
    tree.nodes['child-1'] = makeNode({
      id: 'child-1', parentId: 'root', title: 'Task A',
      status: 'completed', decomposition: 'expanded',
      childIds: ['sub-1', 'sub-2']
    })
    tree.nodes['child-2'] = makeNode({
      id: 'child-2', parentId: 'root', title: 'Task B',
      status: 'completed', decomposition: 'leaf'
    })
    tree.nodes['child-3'] = makeNode({
      id: 'child-3', parentId: 'root', title: 'Task C',
      status: 'completed', decomposition: 'leaf'
    })
    tree.nodes['sub-1'] = makeNode({
      id: 'sub-1', parentId: 'child-1', title: 'Sub A1',
      status: 'completed', resultSummary: 'Sub result 1'
    })
    tree.nodes['sub-2'] = makeNode({
      id: 'sub-2', parentId: 'child-1', title: 'Sub A2',
      status: 'failed', resultSummary: 'Sub failed'
    })

    const ctx = buildRootContext(tree, 'root')
    expect(ctx).toContain('子任务汇总')
    expect(ctx).toContain('Sub A1')
    expect(ctx).toContain('Sub A2')
  })
})

describe('buildSiblingContext', () => {
  it('只包含已完成的兄弟节点摘要', () => {
    const tree = makeTree()
    tree.nodes['child-1'] = makeNode({
      id: 'child-1', parentId: 'root', title: 'Task A',
      status: 'completed', resultSummary: 'Done A'
    })
    tree.nodes['child-2'] = makeNode({
      id: 'child-2', parentId: 'root', title: 'Task B',
      status: 'running'
    })
    tree.nodes['child-3'] = makeNode({
      id: 'child-3', parentId: 'root', title: 'Task C',
      status: 'failed', resultSummary: 'Failed C'
    })

    const ctx = buildSiblingContext(tree, 'child-2')
    expect(ctx).toContain('Task A')
    expect(ctx).toContain('Done A')
    // 失败的兄弟不包含（只有 completed 的才包含）
    expect(ctx).not.toContain('Task C')
  })

  it('超长摘要被截断', () => {
    const tree = makeTree()
    const longSummary = 'A'.repeat(1000)
    tree.nodes['child-1'] = makeNode({
      id: 'child-1', parentId: 'root', title: 'Task A',
      status: 'completed', resultSummary: longSummary
    })
    tree.nodes['child-2'] = makeNode({
      id: 'child-2', parentId: 'root', title: 'Task B',
      status: 'pending'
    })
    tree.nodes['child-3'] = makeNode({
      id: 'child-3', parentId: 'root', title: 'Task C',
      status: 'pending'
    })

    const ctx = buildSiblingContext(tree, 'child-2', 200)
    expect(ctx.length).toBeLessThan(longSummary.length)
    expect(ctx).toContain('已截断')
  })

  it('无已完成兄弟返回空字符串', () => {
    const tree = makeTree()
    tree.nodes['child-1'] = makeNode({
      id: 'child-1', parentId: 'root', title: 'Task A',
      status: 'pending'
    })
    tree.nodes['child-2'] = makeNode({
      id: 'child-2', parentId: 'root', title: 'Task B',
      status: 'running'
    })
    tree.nodes['child-3'] = makeNode({
      id: 'child-3', parentId: 'root', title: 'Task C',
      status: 'pending'
    })

    expect(buildSiblingContext(tree, 'child-2')).toBe('')
  })
})
