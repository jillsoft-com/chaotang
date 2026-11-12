/**
 * task-tree.ts captureRetryContext - 重试现场留存测试
 *
 * 锁定的真实缺陷：重试是「节点级重跑」——executeLeafNode 会重建 messages 数组，
 * 上一轮的思考与工具调用一条都不带；而 transitionStatus 迁入 ready 时会清空
 * failureReason（面板不应挂陈旧失败缘由），resultSummary 又被本轮结果覆盖。
 * 于是重试等于让模型蒙着眼回到工位：不知道上次为何失败、做到哪一步，
 * 容易重复劳动或再踩同一个坑。回退前必须把现场另存到 node.retryContext。
 */

import { describe, it, expect } from 'vitest'
import {
  createTree,
  createNode,
  addNode,
  transitionStatus,
  captureRetryContext
} from '@/services/agent/task-tree'

/** 造一个已落到失败态、带缘由与成果摘要的叶子 */
function makeFailedNode(tree: ReturnType<typeof createTree>) {
  const node = createNode({
    title: '实现登录接口',
    description: '描述',
    parentId: tree.rootId,
    createdBy: 'user',
    assigneeId: 'backend'
  })
  addNode(tree, node)
  transitionStatus(tree, node.id, 'ready')
  transitionStatus(tree, node.id, 'running')
  node.resultSummary = '已创建 src/auth.ts，接口尚未联调'
  transitionStatus(tree, node.id, 'failed', '验收失败:\n[command] npm test: 2 failed')
  return node
}

describe('captureRetryContext - 重试现场留存', () => {
  it('失败缘由与成果摘要都被留存', () => {
    const tree = createTree('debate-1', '根', '描述')
    const node = makeFailedNode(tree)

    node.attempt++
    captureRetryContext(node)

    expect(node.retryContext).toContain('已尝试 1 次')
    expect(node.retryContext).toContain('上次失败缘由：验收失败:')
    expect(node.retryContext).toContain('npm test: 2 failed')
    expect(node.retryContext).toContain('上次留下的成果摘要：')
    expect(node.retryContext).toContain('已创建 src/auth.ts')
  })

  it('关键回归：迁入 ready 会清空 failureReason，但留存下来的 retryContext 不受影响', () => {
    const tree = createTree('debate-1', '根', '描述')
    const node = makeFailedNode(tree)

    node.attempt++
    captureRetryContext(node)
    const r = transitionStatus(tree, node.id, 'ready', '重试 (第 1 次)')

    expect(r.ok).toBe(true)
    // 面板不该继续挂陈旧失败缘由
    expect(node.failureReason).toBeUndefined()
    // 但重试上下文必须活着，这正是另存的意义
    expect(node.retryContext).toContain('npm test: 2 failed')
  })

  it('中断态无失败缘由时补上成因', () => {
    const tree = createTree('debate-1', '根', '描述')
    const node = createNode({ title: '子任务', description: '描述', parentId: tree.rootId, createdBy: 'user', assigneeId: 'backend' })
    addNode(tree, node)
    transitionStatus(tree, node.id, 'ready')
    transitionStatus(tree, node.id, 'running')
    // 模拟应用启动时 markInterruptedTrees 的直写：只改状态不写缘由
    node.failureReason = undefined
    node.status = 'interrupted'

    node.attempt++
    captureRetryContext(node)

    expect(node.retryContext).toContain('上次执行被中断（应用重启或用户取消）')
  })

  it('超长成果摘要截断到 600 字符', () => {
    const tree = createTree('debate-1', '根', '描述')
    const node = makeFailedNode(tree)
    node.resultSummary = 'x'.repeat(1500)

    node.attempt++
    captureRetryContext(node)

    expect(node.retryContext).toContain('x'.repeat(600) + '...(已截断)')
    expect(node.retryContext).not.toContain('x'.repeat(601))
  })

  it('既无缘由也无摘要时不编造内容', () => {
    const tree = createTree('debate-1', '根', '描述')
    const node = createNode({ title: '子任务', description: '描述', parentId: tree.rootId, createdBy: 'user', assigneeId: 'backend' })
    addNode(tree, node)
    transitionStatus(tree, node.id, 'ready')
    transitionStatus(tree, node.id, 'running')
    transitionStatus(tree, node.id, 'paused', '监护器检测到循环')

    node.attempt++
    captureRetryContext(node)

    expect(node.retryContext).toBeUndefined()
  })

  it('再次重试时重新抓取覆盖，不与上一轮叠加', () => {
    const tree = createTree('debate-1', '根', '描述')
    const node = makeFailedNode(tree)

    node.attempt++
    captureRetryContext(node)
    const firstCapture = node.retryContext

    // 本轮重新失败，缘由与摘要都换了
    node.resultSummary = '补完了接口，仍差测试'
    transitionStatus(tree, node.id, 'ready')
    transitionStatus(tree, node.id, 'running')
    transitionStatus(tree, node.id, 'failed', '执行未成功：缺少依赖')
    node.attempt++
    captureRetryContext(node)

    expect(node.retryContext).toContain('已尝试 2 次')
    expect(node.retryContext).toContain('缺少依赖')
    expect(node.retryContext).toContain('补完了接口')
    expect(node.retryContext).not.toContain(firstCapture!.slice(0, 40))
  })
})
