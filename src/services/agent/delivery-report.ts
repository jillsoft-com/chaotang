/**
 * 交付报告 — 桌面交付审阅（P1-B）
 *
 * 从自主执行结果中提取文件变更、验收状态等信息，
 * 聚合为结构化的交付报告供用户审阅。
 *
 * 设计依据：编码能力硬化路线图 Phase 5。
 */

import type { ToolCallResult } from '@/types'
import type { AcceptancePlan, CheckRecord, GateState } from './acceptance-gate'
import { diffStats } from '@/utils/line-diff'

// ============ 类型 ============

/**
 * 落盘时单个文件正文快照的字符上限。
 * 交付报告要长期留在历史归档里，正文全存会随轮次把存储撑爆；
 * 超过上限的文件只保留路径与增删行数，diff 视图据此回退到 git 基准。
 */
export const MAX_SNAPSHOT_CHARS = 32 * 1024

/** 单个文件变更 */
export interface FileChange {
  /** 文件路径 */
  path: string
  /** 变更状态 */
  status: 'created' | 'modified' | 'deleted'
  /** 旧内容（修改/删除时有） */
  oldContent?: string
  /** 新内容（创建/修改时有） */
  newContent?: string
  /** 新增行数 */
  linesAdded: number
  /** 删除行数 */
  linesRemoved: number
  /** 是否禁用撤销（新建文件或缺失原始内容时为 true） */
  revertDisabled?: boolean
  /** 快照生成后文件又被外部改动（当前磁盘内容 ≠ 本轮快照） */
  contentDrift?: boolean
  /** 正文因超过落盘上限被裁掉（内存里仍完整，重开历史会话后为 true） */
  contentTrimmed?: boolean
}

/** 交付报告 */
export interface DeliveryReport {
  /** 节点 ID（来自任务树时） */
  nodeId?: string
  /** 节点标题 */
  nodeTitle?: string
  /** 文件变更列表 */
  changedFiles: FileChange[]
  /** 验收状态 */
  acceptanceState: GateState
  /** 验收检查记录 */
  acceptanceChecks: CheckRecord[]
  /** 未解决问题 */
  unresolvedQuestions: string[]
  /** 修复循环使用次数 */
  repairsUsed: number
  /** 总耗时（毫秒） */
  durationMs?: number
}

// ============ 聚合函数 ============

/**
 * 从工具调用结果中提取文件变更
 *
 * 读取每个写操作附加的 diffData 字段来构建 FileChange。
 * 同一文件多次修改时，保留最新一次 diffData（oldContent 为首次写入前的内容，newContent 为最后一次写入后的内容）。
 */
export function extractFileChanges(toolCalls: ToolCallResult[]): FileChange[] {
  // P1-fix: 同一文件多次修改时聚合为最终版本
  // 策略：用 Map 记录每个文件的最新 diffData，最终统一输出
  const fileMap = new Map<string, {
    oldContent: string
    newContent: string
    isNew: boolean
  }>()

  for (const tc of toolCalls) {
    if (tc.status !== 'success') continue
    const name = tc.functionName
    if (name !== 'write_file' && name !== 'search_replace') continue

    const path = (tc.arguments as any)?.path
    if (!path || typeof path !== 'string') continue

    const diffData = (tc as any).diffData as {
      filePath: string
      oldContent: string
      newContent: string
      isNew: boolean
    } | undefined

    if (!diffData) continue

    const existing = fileMap.get(path)
    if (existing) {
      // 多次修改同一文件：保留首次的 oldContent（原始内容）和最新的 newContent
      existing.newContent = diffData.newContent
      // 如果第一次不是新建但后续是新建（不太可能），保持原值
      existing.isNew = existing.isNew && diffData.isNew
    } else {
      fileMap.set(path, {
        oldContent: diffData.oldContent || '',
        newContent: diffData.newContent || '',
        isNew: diffData.isNew ?? (diffData.oldContent === '')
      })
    }
  }

  const changes: FileChange[] = []
  for (const [path, data] of fileMap) {
    const { added, removed } = countLineDiff(data.oldContent, data.newContent)
    changes.push({
      path,
      status: data.isNew ? 'created' : 'modified',
      oldContent: data.isNew ? undefined : data.oldContent,
      newContent: data.newContent,
      linesAdded: added,
      linesRemoved: removed
    })
  }

  return changes
}

/**
 * 统计行级 diff 行数
 *
 * 委派给统一的 LCS 行对齐工具，与 diff 视图显示的行数保持同一套口径
 * （旧实现用集合交集近似，重复行与顺序变化都会算错）。
 */
export function countLineDiff(oldContent: string, newContent: string): { added: number; removed: number } {
  return diffStats(oldContent || '', newContent || '')
}

/**
 * 从验收计划中提取未解决问题
 *
 * 失败的检查 + 未验证的检查 → 生成待解决问题列表
 */
export function extractUnresolvedQuestions(
  acceptance: AcceptancePlan | undefined,
  toolCalls: ToolCallResult[]
): string[] {
  const questions: string[] = []

  if (acceptance) {
    for (const check of acceptance.checks) {
      if (check.status === 'failed') {
        questions.push(`[${check.kind}] ${check.command || '未知命令'} 未通过: ${check.summary}`)
      } else if (check.status === 'unverified') {
        questions.push(`[${check.kind}] ${check.command || '未知命令'} 未验证`)
      }
    }
  }

  // 检查是否有失败的工具调用
  const failedTools = toolCalls.filter(tc => tc.status === 'error')
  for (const tc of failedTools) {
    const error = tc.error || (tc.result as any)?.error || '未知错误'
    questions.push(`工具 ${tc.functionName} 执行失败: ${error}`)
  }

  return questions
}

/**
 * 构建完整交付报告
 *
 * 聚合文件变更、验收结果、未解决问题等信息。
 */
export function buildDeliveryReport(params: {
  toolCalls: ToolCallResult[]
  acceptance?: AcceptancePlan
  nodeId?: string
  nodeTitle?: string
  repairsUsed?: number
  durationMs?: number
}): DeliveryReport {
  const { toolCalls, acceptance, nodeId, nodeTitle, repairsUsed = 0, durationMs } = params

  const changedFiles = extractFileChanges(toolCalls)
  const unresolvedQuestions = extractUnresolvedQuestions(acceptance, toolCalls)

  return {
    nodeId,
    nodeTitle,
    changedFiles,
    acceptanceState: acceptance?.overallState || 'unverified',
    acceptanceChecks: acceptance?.checks || [],
    unresolvedQuestions,
    repairsUsed,
    durationMs
  }
}

/**
 * 格式化交付报告为可读文本（用于注入到对话中）
 */
export function formatDeliverySummary(report: DeliveryReport): string {
  const lines: string[] = []

  // 文件变更摘要
  if (report.changedFiles.length > 0) {
    lines.push('### 📝 文件变更')
    for (const f of report.changedFiles) {
      const icon = f.status === 'created' ? '🆕' : '✏️'
      lines.push(`- ${icon} \`${f.path}\` (+${f.linesAdded} -${f.linesRemoved})`)
    }
  }

  // 验收结果
  if (report.acceptanceChecks.length > 0) {
    lines.push('\n### ✅ 验收结果')
    for (const c of report.acceptanceChecks) {
      const icon = c.status === 'passed' ? '✅' : c.status === 'failed' ? '❌' : '⚠️'
      lines.push(`- ${icon} [${c.kind}] ${c.command || '未知'}: ${c.summary}`)
    }
  }

  // 未解决问题
  if (report.unresolvedQuestions.length > 0) {
    lines.push('\n### ⚠️ 待关注事项')
    for (const q of report.unresolvedQuestions) {
      lines.push(`- ${q}`)
    }
  }

  // 修复统计
  if (report.repairsUsed > 0) {
    lines.push(`\n🔧 修复循环: ${report.repairsUsed} 次`)
  }

  return lines.join('\n')
}

/**
 * 生成用于落盘的报告副本：只裁掉超限正文，不改动传入对象。
 *
 * 内存里的报告保留完整正文（撤销、内联 diff 都要用），写进存储的副本把超过
 * MAX_SNAPSHOT_CHARS 的正文丢弃并标记 contentTrimmed；被丢弃原始内容的修改项
 * 同时标记 revertDisabled，避免重启后从归档恢复时把空内容写回文件。
 */
export function trimDeliveryReportForStorage(report: DeliveryReport, limit: number = MAX_SNAPSHOT_CHARS): DeliveryReport {
  return {
    ...report,
    changedFiles: report.changedFiles.map(f => {
      const oldTooBig = typeof f.oldContent === 'string' && f.oldContent.length > limit
      const newTooBig = typeof f.newContent === 'string' && f.newContent.length > limit
      if (!oldTooBig && !newTooBig) return f
      const trimmed: FileChange = { ...f, contentTrimmed: true }
      if (oldTooBig) {
        delete trimmed.oldContent
        // 没有原始内容就无法回滚，必须显式禁用撤销（原本已禁用的保持不变）
        if (f.status === 'modified') trimmed.revertDisabled = true
      }
      if (newTooBig) delete trimmed.newContent
      return trimmed
    })
  }
}
