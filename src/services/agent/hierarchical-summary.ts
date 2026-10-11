/**
 * 逐层汇总 — 父节点汇总与上下文裁剪
 *
 * 子节点全部终态后，生成 ParentSummary（结果摘要、缺口、冲突、证据引用）。
 * 汇总失败不伪装成子任务完成。
 * 根节点只接收下一级摘要 + 按需取回的证据引用，不一次性注入全部叶子全文。
 *
 * 设计依据：朝堂任务树运行时改进说明 R7。
 */

import type { TaskTreeSnapshot, TaskNode, ParentSummary } from './task-tree'

// ============ 父节点汇总 ============

export interface HierarchicalSummary {
  parentId: string
  parentTitle: string
  summary: ParentSummary
  /** 汇总的文本描述 */
  summaryText: string
  /** 汇总生成时间 */
  generatedAt: number
  /** 证据引用列表 */
  evidenceRefs: string[]
}

/**
 * 为父节点生成汇总
 *
 * @param tree 任务树快照
 * @param parentId 父节点 ID
 * @returns 汇总结果，如果子节点未全部终态则返回 null
 */
export function generateParentSummary(
  tree: TaskTreeSnapshot,
  parentId: string
): HierarchicalSummary | null {
  const parent = tree.nodes[parentId]
  if (!parent || parent.childIds.length === 0) return null

  // 检查所有子节点是否都有最终状态
  const allTerminal = parent.childIds.every(id => {
    const child = tree.nodes[id]
    return child && isTerminalStatus(child.status)
  })
  if (!allTerminal) return null

  const summary: ParentSummary = {
    completed: [],
    failed: [],
    blocked: [],
    skipped: [],
    partial: [],
    conflicts: [],
    gaps: []
  }

  const evidenceRefs: string[] = []

  for (const childId of parent.childIds) {
    const child = tree.nodes[childId]
    if (!child) continue

    switch (child.status) {
      case 'completed':
        summary.completed.push(child.title)
        evidenceRefs.push(...child.evidenceRefs)
        break
      case 'failed':
        summary.failed.push(child.title)
        break
      case 'blocked':
        summary.blocked.push(child.title)
        break
      case 'skipped':
      case 'cancelled':
        summary.skipped.push(child.title)
        break
      case 'partial':
        summary.partial.push(child.title)
        evidenceRefs.push(...child.evidenceRefs)
        break
    }
  }

  // 检测冲突：完成和失败的任务之间可能有冲突
  if (summary.completed.length > 0 && summary.failed.length > 0) {
    summary.conflicts.push(
      `${summary.completed.length} 个任务完成但 ${summary.failed.length} 个任务失败，可能存在依赖冲突`
    )
  }

  // 检测缺口：被阻塞和跳过的任务
  if (summary.blocked.length > 0 || summary.skipped.length > 0) {
    const gapCount = summary.blocked.length + summary.skipped.length
    summary.gaps.push(`${gapCount} 个任务未能执行（${summary.blocked.length} 被阻塞, ${summary.skipped.length} 被跳过）`)
  }

  // 生成文本描述
  const summaryText = renderSummaryText(parent, summary)

  return {
    parentId,
    parentTitle: parent.title,
    summary,
    summaryText,
    generatedAt: Date.now(),
    evidenceRefs: [...new Set(evidenceRefs)]
  }
}

/**
 * 将 ParentSummary 渲染为可读文本
 */
function renderSummaryText(parent: TaskNode, summary: ParentSummary): string {
  const parts: string[] = []
  const total = summary.completed.length + summary.failed.length +
    summary.blocked.length + summary.skipped.length + summary.partial.length

  parts.push(`## ${parent.title} — 汇总`)
  parts.push(`共 ${total} 个子任务:`)

  if (summary.completed.length > 0) {
    parts.push(`✅ 完成 (${summary.completed.length}): ${summary.completed.join(', ')}`)
  }
  if (summary.partial.length > 0) {
    parts.push(`⚠️ 部分完成 (${summary.partial.length}): ${summary.partial.join(', ')}`)
  }
  if (summary.failed.length > 0) {
    parts.push(`❌ 失败 (${summary.failed.length}): ${summary.failed.join(', ')}`)
  }
  if (summary.blocked.length > 0) {
    parts.push(`🚫 被阻塞 (${summary.blocked.length}): ${summary.blocked.join(', ')}`)
  }
  if (summary.skipped.length > 0) {
    parts.push(`⏭️ 跳过 (${summary.skipped.length}): ${summary.skipped.join(', ')}`)
  }
  if (summary.conflicts.length > 0) {
    parts.push(`⚡ 冲突: ${summary.conflicts.join('; ')}`)
  }
  if (summary.gaps.length > 0) {
    parts.push(`📋 缺口: ${summary.gaps.join('; ')}`)
  }

  return parts.join('\n')
}

// ============ 根节点上下文裁剪 ============

/**
 * 为根节点生成精简上下文（只接收下一级摘要 + 按需取回的证据引用）
 *
 * 不一次性注入全部叶子全文，避免超出模型上下文窗口。
 *
 * @param tree 任务树快照
 * @param rootId 根节点 ID
 * @returns 精简后的上下文文本
 */
export function buildRootContext(tree: TaskTreeSnapshot, rootId: string): string {
  const root = tree.nodes[rootId]
  if (!root) return ''

  const parts: string[] = []
  parts.push(`目标: ${root.description}`)

  // 收集所有证据引用（供最终汇报引用）
  const allEvidenceRefs: string[] = []

  // 只收集直接子节点的摘要（不递归到叶子）
  for (const childId of root.childIds) {
    const child = tree.nodes[childId]
    if (!child) continue

    let statusIcon: string
    switch (child.status) {
      case 'completed': statusIcon = '✅'; break
      case 'failed': statusIcon = '❌'; break
      case 'partial': statusIcon = '⚠️'; break
      case 'blocked': statusIcon = '🚫'; break
      case 'running': statusIcon = '🔄'; break
      default: statusIcon = '⏳'
    }

    const resultSnippet = child.resultSummary
      ? truncateText(child.resultSummary, 200)
      : '(无结果摘要)'

    parts.push(`${statusIcon} ${child.title}: ${resultSnippet}`)

    // 收集子节点的证据引用
    if (child.evidenceRefs.length > 0) {
      allEvidenceRefs.push(...child.evidenceRefs)
    }
  }

  // 如果有更深层的子树，为每个展开的子节点附加汇总
  for (const childId of root.childIds) {
    const child = tree.nodes[childId]
    if (!child || child.decomposition !== 'expanded' || child.childIds.length === 0) continue

    const childSummary = generateParentSummary(tree, childId)
    if (childSummary) {
      parts.push(`\n### ${child.title} — 子任务汇总`)
      parts.push(childSummary.summaryText)
      // 收集子树汇总中的证据引用
      allEvidenceRefs.push(...childSummary.evidenceRefs)
    }
  }

  // R7: 附加证据引用列表（去重）
  const uniqueRefs = [...new Set(allEvidenceRefs)]
  if (uniqueRefs.length > 0) {
    parts.push(`\n### 证据引用`)
    parts.push(`共 ${uniqueRefs.length} 条工具证据: ${uniqueRefs.slice(0, 10).join(', ')}${uniqueRefs.length > 10 ? ' ...' : ''}`)
  }

  return parts.join('\n')
}

/**
 * 为某个节点构建前序上下文（用于传递给 Worker）
 *
 * 只包含同级已完成节点的摘要，不包含全文。
 */
export function buildSiblingContext(
  tree: TaskTreeSnapshot,
  nodeId: string,
  maxCharsPerResult: number = 500
): string {
  const node = tree.nodes[nodeId]
  if (!node || !node.parentId) return ''

  const parent = tree.nodes[node.parentId]
  if (!parent) return ''

  const parts: string[] = []
  for (const siblingId of parent.childIds) {
    if (siblingId === nodeId) continue
    const sibling = tree.nodes[siblingId]
    if (!sibling || sibling.status !== 'completed' || !sibling.resultSummary) continue

    parts.push(`### ${sibling.title}\n${truncateText(sibling.resultSummary, maxCharsPerResult)}`)
  }

  if (parts.length === 0) return ''
  return `=== 前序成员已完成的工作 ===\n${parts.join('\n\n')}\n=== 前序工作结束 ===`
}

// ============ 辅助函数 ============

function isTerminalStatus(status: string): boolean {
  return ['completed', 'failed', 'skipped', 'cancelled', 'partial', 'blocked'].includes(status)
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '...(已截断)'
}
