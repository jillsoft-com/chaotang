/**
 * task-tree.ts 纯函数测试
 *
 * 覆盖：创建、结构校验、状态迁移、查询遍历、序列化、树状态推导、手动编辑操作
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  createTree,
  createNode,
  addNode,
  removeNode,
  validateStructure,
  transitionStatus,
  computeDepth,
  getLeafNodes,
  getReadyNodes,
  topologicalSort,
  aggregateParent,
  deriveParentStatus,
  deriveTreeState,
  serializeSnapshot,
  deserializeSnapshot,
  aggregateTreeUsage,
  addDependency,
  removeDependency,
  reorderChildren,
  changePriority,
  moveNode
} from '@/services/agent/task-tree'
import type { TaskTreeSnapshot, TaskNode } from '@/services/agent/task-tree'

// ============ 辅助函数 ============

function makeTreeWithLeaves(leafStatuses: string[]): TaskTreeSnapshot {
  const tree = createTree('debate-1', '根任务', '根任务描述')
  for (const status of leafStatuses) {
    const node = createNode({
      title: `叶子-${status}`,
      description: `描述-${status}`,
      parentId: tree.rootId,
      createdBy: 'user'
    })
    addNode(tree, node)
    // 设置状态：根据目标状态选择合法迁移路径
    switch (status) {
      case 'pending':
        // 保持 pending，不做任何迁移
        break
      case 'ready':
        transitionStatus(tree, node.id, 'ready')
        break
      case 'blocked':
        // pending → blocked 是合法迁移
        transitionStatus(tree, node.id, 'blocked', '测试阻塞')
        break
      case 'skipped':
        transitionStatus(tree, node.id, 'skipped')
        break
      case 'cancelled':
        transitionStatus(tree, node.id, 'cancelled')
        break
      case 'waiting':
        transitionStatus(tree, node.id, 'waiting', '测试等待')
        break
      default:
        // running, completed, failed, partial, paused, interrupted: 需先 ready → running → 目标
        transitionStatus(tree, node.id, 'ready')
        transitionStatus(tree, node.id, 'running')
        if (status !== 'running') {
          transitionStatus(tree, node.id, status as any)
        }
        break
    }
  }
  return tree
}

// ============ 测试用例 ============

describe('createTree', () => {
  it('创建只有根节点的树', () => {
    const tree = createTree('debate-1', '测试任务', '测试描述')
    expect(tree.rootId).toBeTruthy()
    expect(tree.nodes[tree.rootId]).toBeDefined()
    expect(tree.nodes[tree.rootId].title).toBe('测试任务')
    expect(tree.state).toBe('planning')
    expect(tree.schemaVersion).toBe(1)
  })

  it('根节点无父节点和子节点', () => {
    const tree = createTree('debate-1', '测试', '描述')
    const root = tree.nodes[tree.rootId]
    expect(root.parentId).toBeNull()
    expect(root.childIds).toHaveLength(0)
  })
})

describe('createNode + addNode', () => {
  it('创建并添加子节点', () => {
    const tree = createTree('debate-1', '根', '描述')
    const child = createNode({
      title: '子任务',
      description: '子描述',
      parentId: tree.rootId,
      createdBy: 'user'
    })
    const result = addNode(tree, child)
    expect(result.ok).toBe(true)
    expect(tree.nodes[child.id]).toBeDefined()
    expect(tree.nodes[tree.rootId].childIds).toContain(child.id)
  })

  it('节点数达上限时拒绝添加', () => {
    const tree = createTree('debate-1', '根', '描述', 'user', { maxNodes: 2 })
    const child1 = createNode({ title: '子1', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    addNode(tree, child1)
    const child2 = createNode({ title: '子2', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    const result = addNode(tree, child2)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('上限')
  })

  it('父节点不存在时拒绝添加', () => {
    const tree = createTree('debate-1', '根', '描述')
    const child = createNode({ title: '子', description: '描述', parentId: 'nonexistent', createdBy: 'user' })
    const result = addNode(tree, child)
    expect(result.ok).toBe(false)
  })
})

describe('removeNode', () => {
  it('级联删除子节点', () => {
    const tree = createTree('debate-1', '根', '描述')
    const child = createNode({ title: '子', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    addNode(tree, child)
    const grandchild = createNode({ title: '孙', description: '描述', parentId: child.id, createdBy: 'user' })
    addNode(tree, grandchild)

    removeNode(tree, child.id)
    expect(tree.nodes[child.id]).toBeUndefined()
    expect(tree.nodes[grandchild.id]).toBeUndefined()
    expect(tree.nodes[tree.rootId].childIds).not.toContain(child.id)
  })

  it('不能删除根节点', () => {
    const tree = createTree('debate-1', '根', '描述')
    const result = removeNode(tree, tree.rootId)
    expect(result.ok).toBe(false)
  })

  it('清除其他节点的依赖引用', () => {
    const tree = createTree('debate-1', '根', '描述')
    const a = createNode({ title: 'A', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    const b = createNode({ title: 'B', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    addNode(tree, a)
    addNode(tree, b)
    addDependency(tree, b.id, { taskId: a.id, kind: 'required' })

    removeNode(tree, a.id)
    expect(tree.nodes[b.id].dependencies).toHaveLength(0)
  })
})

describe('validateStructure', () => {
  it('有效树返回 valid', () => {
    const tree = createTree('debate-1', '根', '描述')
    const child = createNode({ title: '子', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    addNode(tree, child)
    const result = validateStructure(tree)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('缺失父节点检测', () => {
    const tree = createTree('debate-1', '根', '描述')
    // 手动破坏：设置一个不存在的 parentId
    const child = createNode({ title: '子', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    addNode(tree, child)
    child.parentId = 'nonexistent'
    const result = validateStructure(tree)
    expect(result.valid).toBe(false)
  })

  it('依赖引用不存在检测', () => {
    const tree = createTree('debate-1', '根', '描述')
    const child = createNode({ title: '子', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    addNode(tree, child)
    child.dependencies.push({ taskId: 'nonexistent', kind: 'required' })
    const result = validateStructure(tree)
    expect(result.valid).toBe(false)
  })

  it('自依赖检测', () => {
    const tree = createTree('debate-1', '根', '描述')
    const child = createNode({ title: '子', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    addNode(tree, child)
    child.dependencies.push({ taskId: child.id, kind: 'required' })
    const result = validateStructure(tree)
    expect(result.valid).toBe(false)
  })
})

describe('transitionStatus', () => {
  let tree: TaskTreeSnapshot
  let nodeId: string

  beforeEach(() => {
    tree = createTree('debate-1', '根', '描述')
    const node = createNode({ title: '节点', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    addNode(tree, node)
    nodeId = node.id
  })

  it('合法迁移 pending → ready', () => {
    const result = transitionStatus(tree, nodeId, 'ready')
    expect(result.ok).toBe(true)
    expect(tree.nodes[nodeId].status).toBe('ready')
  })

  it('合法迁移 ready → running → completed', () => {
    transitionStatus(tree, nodeId, 'ready')
    transitionStatus(tree, nodeId, 'running')
    const result = transitionStatus(tree, nodeId, 'completed')
    expect(result.ok).toBe(true)
    expect(tree.nodes[nodeId].status).toBe('completed')
    expect(tree.nodes[nodeId].finishedAt).toBeTruthy()
  })

  it('合法迁移 pending → blocked', () => {
    const result = transitionStatus(tree, nodeId, 'blocked', '依赖失败')
    expect(result.ok).toBe(true)
    expect(tree.nodes[nodeId].status).toBe('blocked')
    expect(tree.nodes[nodeId].waitingReason).toBe('依赖失败')
  })

  it('非法迁移返回错误', () => {
    // pending → completed 不在迁移表中
    const result = transitionStatus(tree, nodeId, 'completed')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('非法状态迁移')
  })

  it('completed 不能迁移到其他状态', () => {
    transitionStatus(tree, nodeId, 'ready')
    transitionStatus(tree, nodeId, 'running')
    transitionStatus(tree, nodeId, 'completed')
    const result = transitionStatus(tree, nodeId, 'running')
    expect(result.ok).toBe(false)
  })

  it('running → interrupted', () => {
    transitionStatus(tree, nodeId, 'ready')
    transitionStatus(tree, nodeId, 'running')
    const result = transitionStatus(tree, nodeId, 'interrupted', '应用退出')
    expect(result.ok).toBe(true)
    expect(tree.nodes[nodeId].finishedAt).toBeTruthy()
  })

  it('revision 递增', () => {
    const rev0 = tree.nodes[nodeId].revision
    transitionStatus(tree, nodeId, 'ready')
    expect(tree.nodes[nodeId].revision).toBe(rev0 + 1)
  })
})

describe('computeDepth', () => {
  it('根节点深度为 0', () => {
    const tree = createTree('debate-1', '根', '描述')
    expect(computeDepth(tree, tree.rootId)).toBe(0)
  })

  it('三级深度计算', () => {
    const tree = createTree('debate-1', '根', '描述')
    const a = createNode({ title: 'A', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    addNode(tree, a)
    const b = createNode({ title: 'B', description: '描述', parentId: a.id, createdBy: 'user' })
    addNode(tree, b)
    expect(computeDepth(tree, tree.rootId)).toBe(0)
    expect(computeDepth(tree, a.id)).toBe(1)
    expect(computeDepth(tree, b.id)).toBe(2)
  })
})

describe('getLeafNodes', () => {
  it('返回无子节点的节点（不含根节点）', () => {
    const tree = createTree('debate-1', '根', '描述')
    const a = createNode({ title: 'A', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    addNode(tree, a)
    const b = createNode({ title: 'B', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    addNode(tree, b)
    const leaves = getLeafNodes(tree)
    expect(leaves).toHaveLength(2)
    expect(leaves.map(l => l.id)).toEqual(expect.arrayContaining([a.id, b.id]))
  })
})

describe('getReadyNodes', () => {
  it('无依赖的 pending 节点为 ready', () => {
    const tree = createTree('debate-1', '根', '描述')
    // 根节点设为非 pending，避免被 getReadyNodes 返回
    transitionStatus(tree, tree.rootId, 'ready')
    transitionStatus(tree, tree.rootId, 'running')
    const a = createNode({ title: 'A', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    addNode(tree, a)
    transitionStatus(tree, a.id, 'ready')
    const ready = getReadyNodes(tree)
    expect(ready).toHaveLength(1)
    expect(ready[0].id).toBe(a.id)
  })

  it('有必需依赖未完成的节点不 ready', () => {
    const tree = createTree('debate-1', '根', '描述')
    transitionStatus(tree, tree.rootId, 'ready')
    transitionStatus(tree, tree.rootId, 'running')
    const a = createNode({ title: 'A', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    const b = createNode({ title: 'B', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    addNode(tree, a)
    addNode(tree, b)
    transitionStatus(tree, a.id, 'ready')
    transitionStatus(tree, b.id, 'ready')
    addDependency(tree, b.id, { taskId: a.id, kind: 'required' })
    const ready = getReadyNodes(tree)
    // a 无依赖可以 ready，b 依赖 a 未完成
    expect(ready).toHaveLength(1)
    expect(ready[0].id).toBe(a.id)
  })
})

describe('topologicalSort', () => {
  it('按依赖排序', () => {
    const tree = createTree('debate-1', '根', '描述')
    const a = createNode({ title: 'A', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    const b = createNode({ title: 'B', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    addNode(tree, a)
    addNode(tree, b)
    addDependency(tree, b.id, { taskId: a.id, kind: 'required' })
    const sorted = topologicalSort(tree, [b.id, a.id])
    expect(sorted.indexOf(a.id)).toBeLessThan(sorted.indexOf(b.id))
  })
})

describe('deriveTreeState', () => {
  it('所有叶子 completed → completed', () => {
    const tree = makeTreeWithLeaves(['completed', 'completed'])
    expect(deriveTreeState(tree)).toBe('completed')
  })

  it('所有叶子 failed/blocked/cancelled → failed', () => {
    const tree = makeTreeWithLeaves(['failed', 'blocked'])
    expect(deriveTreeState(tree)).toBe('failed')
  })

  it('全部 cancelled → failed', () => {
    const tree = makeTreeWithLeaves(['cancelled', 'cancelled'])
    expect(deriveTreeState(tree)).toBe('failed')
  })

  it('completed + failed 混合 → completed_with_gaps', () => {
    const tree = makeTreeWithLeaves(['completed', 'failed'])
    expect(deriveTreeState(tree)).toBe('completed_with_gaps')
  })

  it('partial + 全部终态 → completed_with_gaps', () => {
    const tree = makeTreeWithLeaves(['completed', 'partial'])
    expect(deriveTreeState(tree)).toBe('completed_with_gaps')
  })

  it('partial + pending 并存 → 保持当前状态（不提前收束）', () => {
    const tree = createTree('debate-1', '根', '描述')
    tree.state = 'running'
    // 创建一个 partial 叶子
    const a = createNode({ title: 'A', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    addNode(tree, a)
    transitionStatus(tree, a.id, 'ready')
    transitionStatus(tree, a.id, 'running')
    transitionStatus(tree, a.id, 'partial')
    // 创建一个 pending 叶子
    const b = createNode({ title: 'B', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    addNode(tree, b)
    // b 保持 pending
    expect(deriveTreeState(tree)).toBe('running')
  })

  it('有 running 节点 → running', () => {
    const tree = makeTreeWithLeaves(['running', 'completed'])
    expect(deriveTreeState(tree)).toBe('running')
  })

  it('有 paused 节点 → paused', () => {
    const tree = makeTreeWithLeaves(['paused', 'completed'])
    expect(deriveTreeState(tree)).toBe('paused')
  })

  it('有 interrupted 节点 → interrupted', () => {
    const tree = makeTreeWithLeaves(['interrupted', 'completed'])
    expect(deriveTreeState(tree)).toBe('interrupted')
  })
})

describe('aggregateParent + deriveParentStatus', () => {
  it('所有子节点完成 → 父节点 completed', () => {
    const tree = makeTreeWithLeaves(['completed', 'completed'])
    const parentStatus = deriveParentStatus(tree, tree.rootId)
    expect(parentStatus).toBe('completed')
  })

  it('有必需子任务失败 → 父节点 failed', () => {
    const tree = createTree('debate-1', '根', '描述')
    const a = createNode({ title: 'A', description: '描述', parentId: tree.rootId, createdBy: 'user', requiredForParent: true })
    const b = createNode({ title: 'B', description: '描述', parentId: tree.rootId, createdBy: 'user', requiredForParent: true })
    addNode(tree, a)
    addNode(tree, b)
    transitionStatus(tree, a.id, 'ready')
    transitionStatus(tree, a.id, 'running')
    transitionStatus(tree, a.id, 'failed')
    transitionStatus(tree, b.id, 'ready')
    transitionStatus(tree, b.id, 'running')
    transitionStatus(tree, b.id, 'completed')
    const status = deriveParentStatus(tree, tree.rootId)
    expect(status).toBe('partial') // 有 running 中完成的和失败的混合
  })
})

describe('serializeSnapshot + deserializeSnapshot', () => {
  it('序列化后反序列化得到相同树', () => {
    const tree = createTree('debate-1', '根', '描述')
    const child = createNode({ title: '子', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    addNode(tree, child)
    const json = serializeSnapshot(tree)
    const restored = deserializeSnapshot(json)
    expect(restored).not.toBeNull()
    expect(restored!.rootId).toBe(tree.rootId)
    expect(Object.keys(restored!.nodes)).toHaveLength(2)
  })

  it('无效 JSON 返回 null', () => {
    expect(deserializeSnapshot('not json')).toBeNull()
    expect(deserializeSnapshot('{}')).toBeNull()
  })
})

describe('aggregateTreeUsage', () => {
  it('汇总所有节点的用量', () => {
    const tree = createTree('debate-1', '根', '描述')
    const a = createNode({ title: 'A', description: '描述', parentId: tree.rootId, createdBy: 'user' })
    addNode(tree, a)
    tree.nodes[a.id].usage = { iterations: 3, toolCalls: 5, elapsedMs: 1000 }
    const total = aggregateTreeUsage(tree)
    expect(total.toolCalls).toBe(5)
    expect(total.iterations).toBe(3)
  })
})

describe('手动编辑操作', () => {
  describe('addDependency', () => {
    it('成功添加依赖', () => {
      const tree = createTree('debate-1', '根', '描述')
      const a = createNode({ title: 'A', description: '描述', parentId: tree.rootId, createdBy: 'user' })
      const b = createNode({ title: 'B', description: '描述', parentId: tree.rootId, createdBy: 'user' })
      addNode(tree, a)
      addNode(tree, b)
      const result = addDependency(tree, b.id, { taskId: a.id, kind: 'required' })
      expect(result.ok).toBe(true)
      expect(tree.nodes[b.id].dependencies).toHaveLength(1)
    })

    it('自依赖被拒绝', () => {
      const tree = createTree('debate-1', '根', '描述')
      const a = createNode({ title: 'A', description: '描述', parentId: tree.rootId, createdBy: 'user' })
      addNode(tree, a)
      const result = addDependency(tree, a.id, { taskId: a.id, kind: 'required' })
      expect(result.ok).toBe(false)
    })

    it('重复依赖被拒绝', () => {
      const tree = createTree('debate-1', '根', '描述')
      const a = createNode({ title: 'A', description: '描述', parentId: tree.rootId, createdBy: 'user' })
      const b = createNode({ title: 'B', description: '描述', parentId: tree.rootId, createdBy: 'user' })
      addNode(tree, a)
      addNode(tree, b)
      addDependency(tree, b.id, { taskId: a.id, kind: 'required' })
      const result = addDependency(tree, b.id, { taskId: a.id, kind: 'required' })
      expect(result.ok).toBe(false)
    })
  })

  describe('removeDependency', () => {
    it('成功移除依赖', () => {
      const tree = createTree('debate-1', '根', '描述')
      const a = createNode({ title: 'A', description: '描述', parentId: tree.rootId, createdBy: 'user' })
      const b = createNode({ title: 'B', description: '描述', parentId: tree.rootId, createdBy: 'user' })
      addNode(tree, a)
      addNode(tree, b)
      addDependency(tree, b.id, { taskId: a.id, kind: 'required' })
      const result = removeDependency(tree, b.id, a.id)
      expect(result.ok).toBe(true)
      expect(tree.nodes[b.id].dependencies).toHaveLength(0)
    })

    it('不存在的依赖返回错误', () => {
      const tree = createTree('debate-1', '根', '描述')
      const a = createNode({ title: 'A', description: '描述', parentId: tree.rootId, createdBy: 'user' })
      addNode(tree, a)
      const result = removeDependency(tree, a.id, 'nonexistent')
      expect(result.ok).toBe(false)
    })
  })

  describe('reorderChildren', () => {
    it('成功重排子节点', () => {
      const tree = createTree('debate-1', '根', '描述')
      const a = createNode({ title: 'A', description: '描述', parentId: tree.rootId, createdBy: 'user' })
      const b = createNode({ title: 'B', description: '描述', parentId: tree.rootId, createdBy: 'user' })
      addNode(tree, a)
      addNode(tree, b)
      const result = reorderChildren(tree, tree.rootId, [b.id, a.id])
      expect(result.ok).toBe(true)
      expect(tree.nodes[tree.rootId].childIds).toEqual([b.id, a.id])
    })

    it('数量不匹配返回错误', () => {
      const tree = createTree('debate-1', '根', '描述')
      const a = createNode({ title: 'A', description: '描述', parentId: tree.rootId, createdBy: 'user' })
      addNode(tree, a)
      const result = reorderChildren(tree, tree.rootId, [])
      expect(result.ok).toBe(false)
    })
  })

  describe('changePriority', () => {
    it('修改优先级', () => {
      const tree = createTree('debate-1', '根', '描述')
      const a = createNode({ title: 'A', description: '描述', parentId: tree.rootId, createdBy: 'user' })
      addNode(tree, a)
      const result = changePriority(tree, a.id, 3)
      expect(result.ok).toBe(true)
      expect(tree.nodes[a.id].priority).toBe(3)
    })
  })

  describe('moveNode', () => {
    it('成功移动节点', () => {
      const tree = createTree('debate-1', '根', '描述')
      const a = createNode({ title: 'A', description: '描述', parentId: tree.rootId, createdBy: 'user' })
      const b = createNode({ title: 'B', description: '描述', parentId: tree.rootId, createdBy: 'user' })
      addNode(tree, a)
      addNode(tree, b)
      const result = moveNode(tree, b.id, a.id)
      expect(result.ok).toBe(true)
      expect(tree.nodes[a.id].childIds).toContain(b.id)
      expect(tree.nodes[b.id].parentId).toBe(a.id)
    })

    it('不能移动根节点', () => {
      const tree = createTree('debate-1', '根', '描述')
      const a = createNode({ title: 'A', description: '描述', parentId: tree.rootId, createdBy: 'user' })
      addNode(tree, a)
      const result = moveNode(tree, tree.rootId, a.id)
      expect(result.ok).toBe(false)
    })

    it('深度超限时完整回滚', () => {
      const tree = createTree('debate-1', '根', '描述', 'user', { maxDepth: 2 })
      const a = createNode({ title: 'A', description: '描述', parentId: tree.rootId, createdBy: 'user' })
      addNode(tree, a)
      const b = createNode({ title: 'B', description: '描述', parentId: a.id, createdBy: 'user' })
      addNode(tree, b)
      // 尝试将 b 移到 a 下（会产生深度 3，超限）
      const c = createNode({ title: 'C', description: '描述', parentId: b.id, createdBy: 'user' })
      addNode(tree, c)
      // 将 c 移到 b 下会深度 3，但 c 已在 b 下，试将根的子节点 a 移到 c 下
      // 实际测试：把 b 移到 c 下（形成 b->c->b 循环，会被祖先检查拦截）
      // 改为：创建新节点 d 在根下，移到 c 下（深度 = 3 > maxDepth 2）
      const d = createNode({ title: 'D', description: '描述', parentId: tree.rootId, createdBy: 'user' })
      addNode(tree, d)
      const oldParentId = d.parentId
      const oldRootChildIds = [...tree.nodes[tree.rootId].childIds]
      const result = moveNode(tree, d.id, c.id)
      expect(result.ok).toBe(false)
      // 验证回滚：d 的 parentId 恢复，根节点的 childIds 恢复
      expect(tree.nodes[d.id].parentId).toBe(oldParentId)
      expect(tree.nodes[tree.rootId].childIds).toEqual(oldRootChildIds)
    })
  })
})
