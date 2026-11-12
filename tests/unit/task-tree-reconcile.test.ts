/**
 * task-tree.ts reconcileNodesAfterChat - 会话追问回合状态回写测试
 *
 * 锁定真实缺陷：会话区追问/@提及回合（runMinisterTurn 与降级路径）执行完工具并成功，
 * 但不经过任务树调度器——节点停在上次中断留下的 interrupted/failed，
 * 面板显示「已中断/重试」而会话气泡显示「执行完成」，两侧不一致。
 *
 * 注意：interrupted/failed → completed 不是状态机合法迁移，回写走模仿
 * transitionStatus 终态副作用的直写路径，这里同时断言副作用字段。
 */

import { describe, it, expect } from 'vitest'
import {
  createTree,
  createNode,
  addNode,
  transitionStatus,
  reconcileNodesAfterChat
} from '@/services/agent/task-tree'
import type { TaskTreeSnapshot, TaskNode } from '@/services/agent/task-tree'

/** 在根下挂一个叶子并落到指定状态（走合法迁移路径） */
function addLeaf(
  tree: TaskTreeSnapshot,
  status: string,
  opts: { assigneeId?: string; parentId?: string; resultSummary?: string; failureReason?: string } = {}
): TaskNode {
  const node = createNode({
    title: `叶子-${status}`,
    description: '描述',
    parentId: opts.parentId ?? tree.rootId,
    createdBy: 'user',
    assigneeId: opts.assigneeId ?? 'backend'
  })
  addNode(tree, node)
  if (opts.resultSummary !== undefined) node.resultSummary = opts.resultSummary
  if (status === 'pending') return node
  // blocked/cancelled/skipped 从 pending 直达（running→blocked 不是合法迁移）
  if (status === 'blocked' || status === 'cancelled' || status === 'skipped') {
    transitionStatus(tree, node.id, status as any, status === 'blocked' ? '必需依赖未达成' : undefined)
    return node
  }
  transitionStatus(tree, node.id, 'ready')
  if (status === 'ready') return node
  transitionStatus(tree, node.id, 'running')
  if (status === 'running') return node
  transitionStatus(tree, node.id, status as any, status === 'failed' || status === 'interrupted' ? '上次执行失败' : undefined)
  return node
}

describe('reconcileNodesAfterChat - 会话回合状态回写', () => {
  it('interrupted 叶子回写为 completed，终态副作用与 transitionStatus 对齐', () => {
    const tree = createTree('debate-1', '根', '描述')
    const leaf = addLeaf(tree, 'interrupted', { assigneeId: 'backend' })
    leaf.startedAt = 123
    leaf.resultSummary = '接口已完成'
    const revBefore = leaf.revision

    const changed = reconcileNodesAfterChat(tree, 'backend')

    // 根节点也随父链重推（pending → completed），计入变化数
    expect(changed).toBe(2)
    expect(leaf.status).toBe('completed')
    expect(leaf.revision).toBe(revBefore + 1)
    expect(leaf.finishedAt).toBeTypeOf('number')
    expect(leaf.startedAt).toBe(123) // 已有 startedAt 不被覆盖
    expect(leaf.failureReason).toBeUndefined()
    expect(leaf.waitingReason).toBeUndefined()
    expect(leaf.resultSummary).toContain('接口已完成')
    expect(leaf.resultSummary).toContain('（状态由会话追问回合回写为已完成）')
    // 全部叶子完成 → 树态收为 completed
    expect(tree.state).toBe('completed')
  })

  it('failed 叶子同样回写，无 startedAt 时补终态时间', () => {
    const tree = createTree('debate-1', '根', '描述')
    const leaf = addLeaf(tree, 'failed', { assigneeId: 'finance' })

    expect(reconcileNodesAfterChat(tree, 'finance')).toBe(2) // 叶子 + 根
    expect(leaf.status).toBe('completed')
    expect(leaf.startedAt).toBe(leaf.finishedAt)
  })

  it('不动其他执行者的节点与非 interrupted/failed 状态', () => {
    const tree = createTree('debate-1', '根', '描述')
    const other = addLeaf(tree, 'interrupted', { assigneeId: 'censor' })
    const blocked = addLeaf(tree, 'blocked', { assigneeId: 'backend' })
    const done = addLeaf(tree, 'completed', { assigneeId: 'backend' })

    const changed = reconcileNodesAfterChat(tree, 'backend')

    expect(changed).toBe(0)
    expect(other.status).toBe('interrupted')
    expect(blocked.status).toBe('blocked')
    expect(done.status).toBe('completed')
    expect(tree.state).toBe('planning') // no-op：不落树态不改任何字段
  })

  it('无可回写节点时返回 0 且不修改 updatedAt', () => {
    const tree = createTree('debate-1', '根', '描述')
    addLeaf(tree, 'completed', { assigneeId: 'backend' })
    const before = tree.updatedAt

    expect(reconcileNodesAfterChat(tree, 'backend')).toBe(0)
    expect(tree.updatedAt).toBe(before)
  })

  it('assigneeId 为空串直接拒绝', () => {
    const tree = createTree('debate-1', '根', '描述')
    addLeaf(tree, 'interrupted')
    expect(reconcileNodesAfterChat(tree, '')).toBe(0)
  })

  it('子节点全部回写后父节点重推为 completed', () => {
    const tree = createTree('debate-1', '根', '描述')
    const parent = createNode({ title: '父', description: '描述', parentId: tree.rootId, createdBy: 'user', assigneeId: 'backend' })
    addNode(tree, parent)
    transitionStatus(tree, parent.id, 'ready')
    transitionStatus(tree, parent.id, 'running')
    transitionStatus(tree, parent.id, 'interrupted', '中断')
    const c1 = addLeaf(tree, 'interrupted', { assigneeId: 'backend', parentId: parent.id })
    const c2 = addLeaf(tree, 'completed', { assigneeId: 'backend', parentId: parent.id })

    const changed = reconcileNodesAfterChat(tree, 'backend')

    expect(c1.status).toBe('completed')
    expect(parent.status).toBe('completed')
    expect(parent.failureReason).toBeUndefined()
    expect(changed).toBe(3) // 1 个叶子 + 父节点 + 根节点
    expect(tree.state).toBe('completed')
  })

  it('兄弟节点仍有未终态时父节点不落定', () => {
    const tree = createTree('debate-1', '根', '描述')
    const parent = createNode({ title: '父', description: '描述', parentId: tree.rootId, createdBy: 'user', assigneeId: 'backend' })
    addNode(tree, parent)
    addLeaf(tree, 'interrupted', { assigneeId: 'backend', parentId: parent.id })
    addLeaf(tree, 'pending', { assigneeId: 'backend', parentId: parent.id })

    const changed = reconcileNodesAfterChat(tree, 'backend')

    expect(changed).toBe(1) // 只有叶子被回写
    expect(parent.status).toBe('pending')
  })

  it('混合终态（一完成一取消）父节点落 partial 而非 completed', () => {
    const tree = createTree('debate-1', '根', '描述')
    const parent = createNode({ title: '父', description: '描述', parentId: tree.rootId, createdBy: 'user', assigneeId: 'backend' })
    addNode(tree, parent)
    transitionStatus(tree, parent.id, 'ready')
    transitionStatus(tree, parent.id, 'running')
    transitionStatus(tree, parent.id, 'interrupted', '中断')
    addLeaf(tree, 'failed', { assigneeId: 'backend', parentId: parent.id })
    addLeaf(tree, 'cancelled', { assigneeId: 'chancellor', parentId: parent.id })

    const changed = reconcileNodesAfterChat(tree, 'backend')

    expect(changed).toBe(3) // 叶子 + 父节点（partial）+ 根节点
    expect(parent.status).toBe('partial')
    // 有 partial 叶子 → 有缺口地完成
    expect(tree.state).toBe('completed_with_gaps')
  })

  it('必需子任务无法回写（blocked）时父节点落 failed', () => {
    const tree = createTree('debate-1', '根', '描述')
    const parent = createNode({ title: '父', description: '描述', parentId: tree.rootId, createdBy: 'user', assigneeId: 'backend' })
    addNode(tree, parent)
    transitionStatus(tree, parent.id, 'ready')
    transitionStatus(tree, parent.id, 'running')
    transitionStatus(tree, parent.id, 'interrupted', '中断')
    const requiredBlocked = addLeaf(tree, 'blocked', { assigneeId: 'chancellor', parentId: parent.id })
    requiredBlocked.requiredForParent = true
    addLeaf(tree, 'failed', { assigneeId: 'backend', parentId: parent.id })

    reconcileNodesAfterChat(tree, 'backend')

    expect(parent.status).toBe('failed')
  })

  it('根节点随最上层父链一并重推', () => {
    const tree = createTree('debate-1', '根', '描述')
    const root = tree.nodes[tree.rootId]
    root.status = 'interrupted'
    addLeaf(tree, 'interrupted', { assigneeId: 'backend' })

    const changed = reconcileNodesAfterChat(tree, 'backend')

    expect(changed).toBe(2) // 叶子 + 根
    expect(root.status).toBe('completed')
    expect(tree.state).toBe('completed')
  })
})
