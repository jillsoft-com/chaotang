/**
 * 任务文档 — 把丞相拆解的任务树渲染为 Markdown 并落盘到工程内
 *
 * 目的：让各 Worker（大臣）可以用 read_file 读取 `docs/任务分解.md`，
 * 获取完整的任务清单、职责分配、验收标准与实时执行状态，
 * 而不必依赖易逝的聊天气泡。
 *
 * 该文档在任务树创建、以及每个节点状态变化时被（去抖）重写，
 * 因此始终反映最新进度。
 */

import type { TaskTreeSnapshot, TaskNode, TaskStatus } from './task-tree'
import type { Minister } from '@/types'

/** 任务状态 → 中文标签 */
const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: '待处理',
  ready: '就绪',
  running: '执行中',
  awaiting_approval: '待批准',
  waiting: '等待',
  paused: '已暂停',
  interrupted: '已中断',
  completed: '已完成',
  partial: '部分完成',
  failed: '失败',
  blocked: '受阻',
  skipped: '已跳过',
  cancelled: '已取消'
}

/** 任务状态 → 展示标记（勾选框 + emoji） */
const STATUS_MARKS: Record<TaskStatus, string> = {
  pending: '⬜',
  ready: '⬜',
  running: '🔄',
  awaiting_approval: '🟡',
  waiting: '⏳',
  paused: '⏸️',
  interrupted: '⚠️',
  completed: '✅',
  partial: '🟠',
  failed: '❌',
  blocked: '⛔',
  skipped: '➖',
  cancelled: '🚫'
}

function statusLabel(status: TaskStatus): string {
  return STATUS_LABELS[status] || status
}

/** 整树状态（TreeState）→ 中文标签 */
const TREE_STATE_LABELS: Record<string, string> = {
  planning: '规划中',
  awaiting_approval: '待批准',
  running: '执行中',
  paused: '已暂停',
  interrupted: '已中断',
  completed: '已完成',
  completed_with_gaps: '完成（有缺口）',
  failed: '失败',
  cancelled: '已取消'
}

function treeStateLabel(state: string): string {
  return TREE_STATE_LABELS[state] || state
}

/** 验收状态→中文标签（与任务状态解耦：任务已完成但验收可能未验证） */
const ACCEPTANCE_LABELS: Record<string, string> = {
  passed: '已通过',
  failed: '未通过',
  unverified: '未验证',
  running: '验收中',
  pending: '待验收'
}

function acceptanceLabel(state: string): string {
  return ACCEPTANCE_LABELS[state] || state
}

function statusMark(status: TaskStatus): string {
  return STATUS_MARKS[status] || '⬜'
}

/** 按工作目录风格选择分隔符 */
function pickSep(base: string): string {
  return base.includes('\\') && !base.includes('/') ? '\\' : '/'
}

/** 拼接任务文档的绝对路径（不写盘，仅计算） */
export function getTaskDocPath(workingDirectory: string): string {
  const sep = pickSep(workingDirectory)
  const dir = workingDirectory.replace(/[\\/]+$/, '')
  return `${dir}${sep}docs${sep}任务分解.md`
}

/**
 * 把任务树渲染为 Markdown 文档。
 * @param tree    任务树快照
 * @param topic   议题（根任务描述）
 * @param ministers 角色列表，用于把 assigneeId 映射为可读的执行者名称
 */
export function buildTaskDocMarkdown(
  tree: TaskTreeSnapshot,
  topic: string,
  ministers: Minister[]
): string {
  const nameOf = (id: string | null): string => {
    if (!id) return '未分配'
    const m = ministers.find(mm => mm.id === id)
    return m ? `${m.avatar || ''} ${m.name}`.trim() : id
  }

  const nodes = Object.values(tree.nodes)
  const leafOrAction = nodes.filter(n => n.id !== tree.rootId)
  const doneCount = leafOrAction.filter(n => n.status === 'completed').length
  const failedCount = leafOrAction.filter(n => n.status === 'failed').length
  const total = leafOrAction.length
  const updatedAt = new Date(tree.updatedAt || Date.now()).toLocaleString('zh-CN')

  const lines: string[] = []

  lines.push('# 📋 任务分解与执行进度')
  lines.push('')
  lines.push('> 本文件由「朝堂」自动生成并实时维护，**请勿手工编辑**（下次状态变化会被覆盖）。')
  lines.push('> 各执行成员可用 `read_file` 读取本文件，了解完整任务清单、职责分工、验收标准与最新进度。')
  lines.push('')
  lines.push(`- **议题**：${topic || '(无)'}`)
  lines.push(`- **整体状态**：${treeStateLabel(tree.state)}`)
  lines.push(`- **进度**：${doneCount}/${total} 完成${failedCount > 0 ? ` · ${failedCount} 失败` : ''}`)
  lines.push(`- **最近更新**：${updatedAt}`)
  lines.push('')

  // 丞相分析计划
  const root = tree.nodes[tree.rootId]
  if (root && root.description) {
    lines.push('## 🧭 丞相分析计划')
    lines.push('')
    lines.push(root.description)
    lines.push('')
  }

  // 状态图例
  lines.push('## 📖 状态图例')
  lines.push('')
  lines.push('⬜ 待执行 · 🔄 执行中 · ✅ 已完成 · 🟠 部分完成 · ❌ 失败 · ⛔ 受阻 · ⏸️ 已暂停 · ⚠️ 已中断')
  lines.push('')

  lines.push('## 🌳 任务清单')
  lines.push('')

  // 深度优先遍历，按层级缩进渲染
  const walk = (id: string, depth: number) => {
    const node = tree.nodes[id]
    if (!node) return
    if (id !== tree.rootId) {
      const indent = '  '.repeat(Math.max(0, depth - 1))
      renderNode(lines, node, indent, nameOf, tree)
    }
    const childDepth = id === tree.rootId ? 1 : depth + 1
    for (const cid of node.childIds) walk(cid, childDepth)
  }
  walk(tree.rootId, 0)

  return lines.join('\n')
}

function renderNode(
  lines: string[],
  node: TaskNode,
  indent: string,
  nameOf: (id: string | null) => string,
  tree: TaskTreeSnapshot
): void {
  const mark = statusMark(node.status)
  const label = statusLabel(node.status)
  const assignee = nameOf(node.assigneeId)
  const attempt = (node.attempt && node.attempt > 0) ? ` · 已重试 ${node.attempt} 次` : ''

  lines.push(`${indent}- ${mark} **${node.title}** — ${assignee} \`${label}${attempt}\``)

  if (node.description && node.description !== node.title) {
    lines.push(`${indent}  - 说明：${node.description}`)
  }

  if (node.acceptanceState) {
    lines.push(`${indent}  - 验收：${acceptanceLabel(node.acceptanceState)}${node.acceptanceState === 'unverified' ? '（未配置自动检查）' : ''}`)
  }

  const deps = node.dependencies
    .map(d => tree.nodes[d.taskId]?.title)
    .filter(Boolean)
  if (deps.length > 0) {
    lines.push(`${indent}  - 依赖：${deps.join('、')}`)
  }

  if (node.acceptance && node.acceptance.length > 0) {
    lines.push(`${indent}  - 验收标准：`)
    for (const a of node.acceptance) {
      lines.push(`${indent}    - ${a}`)
    }
  }

  if (node.resultSummary) {
    const summary = node.resultSummary.replace(/\s+/g, ' ').trim()
    const clipped = summary.length > 300 ? summary.slice(0, 300) + '…' : summary
    lines.push(`${indent}  - 执行结果：${clipped}`)
  }

  if (node.unresolvedQuestions && node.unresolvedQuestions.length > 0) {
    lines.push(`${indent}  - 未决问题：${node.unresolvedQuestions.join('；')}`)
  }
}

/**
 * 渲染并写入工程内的 `docs/任务分解.md`。
 * 依赖 Electron write-file（主进程会自动创建 docs 目录，并在授权工作区内放行）。
 */
export async function writeTaskDoc(
  workingDirectory: string,
  tree: TaskTreeSnapshot,
  topic: string,
  ministers: Minister[]
): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!workingDirectory) return { ok: false, error: '未设置工作目录' }
  if (!window.electronAPI?.writeFile) return { ok: false, error: '需在 Electron 环境运行' }
  const md = buildTaskDocMarkdown(tree, topic, ministers)
  const path = getTaskDocPath(workingDirectory)
  try {
    const res = await window.electronAPI.writeFile(path, md)
    if (res.success) return { ok: true, path: res.path || path }
    return { ok: false, path, error: res.error || '写入失败' }
  } catch (e: any) {
    return { ok: false, path, error: e?.message || String(e) }
  }
}
