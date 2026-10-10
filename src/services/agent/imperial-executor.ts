/**
 * 圣旨执行闭环 — 自动执行 Imperial Decree 中的行动项
 *
 * 功能：
 * 1. 解析圣旨/决策报告中的行动项（nextSteps）
 * 2. 将行动项转化为可执行的工具调用
 * 3. 执行行动并生成执行报告
 *
 * Sprint D - #3
 */

import type { DecisionReport, ToolCall } from '@/types'
import { toolExecutor } from '@/services/tools/executor'

// ============ 类型 ============

export interface ActionItem {
  id: string
  /** 行动描述 */
  description: string
  /** 行动类型 */
  type: 'file_write' | 'file_create' | 'command' | 'search' | 'analysis' | 'custom'
  /** 执行状态 */
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'skipped'
  /** 执行结果 */
  result?: string
  /** 错误信息 */
  error?: string
  /** 执行时间（ms） */
  duration?: number
}

export interface ExecutionReport {
  /** 原始圣旨/决策 */
  source: string
  /** 解析出的行动项 */
  actionItems: ActionItem[]
  /** 已完成数量 */
  completedCount: number
  /** 总数 */
  totalCount: number
  /** 执行时间（ms） */
  duration: number
  /** 执行时间戳 */
  executedAt: number
}

// ============ 解析器 ============

/**
 * 从决策报告的 nextSteps 解析行动项
 */
export function parseActionItemsFromReport(report: DecisionReport): ActionItem[] {
  const items: ActionItem[] = []

  if (report.nextSteps && report.nextSteps.length > 0) {
    for (const step of report.nextSteps) {
      items.push({
        id: `action_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        description: step,
        type: inferActionType(step),
        status: 'pending'
      })
    }
  }

  return items
}

/**
 * 从圣旨文本解析行动项
 */
export function parseActionItemsFromDecree(decree: string): ActionItem[] {
  const items: ActionItem[] = []

  // 解析常见行动项模式
  const patterns = [
    /(?:需要|应该|必须|请|建议)[：:]\s*(.+?)(?=[。；\n]|$)/g,
    /(?:第一步|第二步|第三步|步骤\d+|Step\s*\d+)[：:]\s*(.+?)(?=[。；\n]|$)/gi,
    /(?:Action|TODO|Task|行动|任务)[：:]\s*(.+?)(?=[。；\n]|$)/gi,
    /(?:\d+[\.\)、])\s*(.+?)(?=[\n]|$)/g
  ]

  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(decree)) !== null) {
      const desc = match[1].trim()
      if (desc.length > 5 && desc.length < 200) {
        items.push({
          id: `action_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          description: desc,
          type: inferActionType(desc),
          status: 'pending'
        })
      }
    }
  }

  return items
}

/**
 * 根据描述推断行动类型
 */
function inferActionType(description: string): ActionItem['type'] {
  const d = description.toLowerCase()

  if (d.includes('创建') || d.includes('新建') || d.includes('生成') || d.includes('写入文件')) {
    return 'file_create'
  }
  if (d.includes('修改') || d.includes('更新') || d.includes('编辑') || d.includes('写入')) {
    return 'file_write'
  }
  if (d.includes('运行') || d.includes('执行') || d.includes('命令') || d.includes('脚本')) {
    return 'command'
  }
  if (d.includes('搜索') || d.includes('查找') || d.includes('检索') || d.includes('查询')) {
    return 'search'
  }
  if (d.includes('分析') || d.includes('评估') || d.includes('审查')) {
    return 'analysis'
  }

  return 'custom'
}

// ============ 执行器 ============

/**
 * 执行行动项列表
 */
export async function executeActionItems(
  items: ActionItem[],
  workingDirectory?: string,
  onProgress?: (item: ActionItem, index: number) => void
): Promise<ExecutionReport> {
  const startTime = Date.now()
  let completedCount = 0

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    item.status = 'executing'
    onProgress?.(item, i)

    const itemStart = Date.now()

    try {
      const result = await executeSingleAction(item, workingDirectory)
      item.result = result
      item.status = 'completed'
      item.duration = Date.now() - itemStart
      completedCount++
    } catch (error) {
      item.error = error instanceof Error ? error.message : '执行失败'
      item.status = 'failed'
      item.duration = Date.now() - itemStart
    }

    onProgress?.(item, i)
  }

  return {
    source: items.map(i => i.description).join('\n'),
    actionItems: items,
    completedCount,
    totalCount: items.length,
    duration: Date.now() - startTime,
    executedAt: Date.now()
  }
}

/**
 * 执行单个行动项
 */
async function executeSingleAction(item: ActionItem, workingDirectory?: string): Promise<string> {
  const dir = workingDirectory || ''

  switch (item.type) {
    case 'file_create':
    case 'file_write':
      return await executeFileAction(item.description, dir)

    case 'command':
      return await executeCommandAction(item.description, dir)

    case 'search':
      return await executeSearchAction(item.description, dir)

    case 'analysis':
      return `[分析行动已记录] ${item.description}\n请使用 AI 助手进一步分析。`

    default:
      return `[行动已记录] ${item.description}\n请手动执行或进一步细化。`
  }
}

async function executeFileAction(description: string, workingDirectory: string): Promise<string> {
  // 从描述中提取文件名和内容
  const fileMatch = description.match(/(?:文件|file)[：:]\s*([^\s,，。]+)/i)
  if (!fileMatch) {
    return `[文件操作] ${description}\n需要指定文件路径，请手动执行。`
  }

  let filePath = fileMatch[1]
  if (workingDirectory && !/^[a-zA-Z]:[\\/]/.test(filePath) && !filePath.startsWith('/')) {
    const sep = workingDirectory.includes('\\') ? '\\' : '/'
    filePath = `${workingDirectory.replace(/[\\/]+$/, '')}${sep}${filePath.replace(/^[\\/]+/, '')}`
  }

  // 尝试执行 write_file
  const tc: ToolCall = {
    id: `tc_${Date.now()}`,
    type: 'function',
    function: {
      name: 'write_file',
      arguments: JSON.stringify({
        path: filePath,
        content: `// ${description}\n// 自动创建于 ${new Date().toLocaleString('zh-CN')}\n`
      })
    }
  }

  const result = await toolExecutor.execute(tc)
  if (result.status === 'success') {
    return `文件已创建: ${filePath}`
  }
  throw new Error(result.error || '文件创建失败')
}

async function executeCommandAction(description: string, workingDirectory: string): Promise<string> {
  // 从描述中提取命令
  const cmdMatch = description.match(/(?:命令|command|运行|执行)[：:]\s*(.+?)(?=[。；]|$)/i)
  if (!cmdMatch) {
    return `[命令执行] ${description}\n需要指定具体命令，请手动执行。`
  }

  const command = cmdMatch[1].trim()
  const tc: ToolCall = {
    id: `tc_${Date.now()}`,
    type: 'function',
    function: {
      name: 'execute_command',
      arguments: JSON.stringify({
        command,
        cwd: workingDirectory || undefined
      })
    }
  }

  const result = await toolExecutor.execute(tc)
  if (result.status === 'success') {
    const output = typeof result.result === 'string'
      ? result.result.slice(0, 500)
      : JSON.stringify(result.result).slice(0, 500)
    return `命令执行成功:\n${output}`
  }
  throw new Error(result.error || '命令执行失败')
}

async function executeSearchAction(description: string, workingDirectory: string): Promise<string> {
  const queryMatch = description.match(/(?:搜索|查找|检索|查询)[：:]\s*(.+?)(?=[。；]|$)/i)
  if (!queryMatch) {
    return `[搜索] ${description}\n请指定搜索关键词。`
  }

  const query = queryMatch[1].trim()
  const tc: ToolCall = {
    id: `tc_${Date.now()}`,
    type: 'function',
    function: {
      name: 'search_code',
      arguments: JSON.stringify({
        path: workingDirectory || '.',
        pattern: query
      })
    }
  }

  const result = await toolExecutor.execute(tc)
  if (result.status === 'success') {
    return `搜索结果:\n${JSON.stringify(result.result).slice(0, 500)}`
  }
  throw new Error(result.error || '搜索失败')
}

// ============ 格式化 ============

/**
 * 将执行报告格式化为 Markdown
 */
export function formatExecutionReport(report: ExecutionReport): string {
  const lines: string[] = []

  lines.push(`## 📜 圣旨执行报告\n`)
  lines.push(`**执行时间**：${new Date(report.executedAt).toLocaleString('zh-CN')}`)
  lines.push(`**完成率**：${report.completedCount}/${report.totalCount}`)
  lines.push(`**耗时**：${(report.duration / 1000).toFixed(1)} 秒\n`)

  lines.push(`### 执行详情\n`)

  for (const item of report.actionItems) {
    const icon = item.status === 'completed' ? '✅'
      : item.status === 'failed' ? '❌'
      : item.status === 'skipped' ? '⏭️'
      : '⏳'

    lines.push(`${icon} **${item.description}**`)
    if (item.result) {
      lines.push(`   > ${item.result.slice(0, 200)}`)
    }
    if (item.error) {
      lines.push(`   > ⚠️ ${item.error}`)
    }
    if (item.duration) {
      lines.push(`   > 耗时: ${item.duration}ms`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
