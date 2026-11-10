/**
 * Agent 执行时间线工具 —— 构建"思考→执行工具→思考→…"交错有序的时间线
 *
 * 数据落在 speech.execTimeline（ExecSegment[]），由两条 worker 执行路径实时写入：
 * - AutonomousEngine（自主分支）：每轮开始 push think 段，流式更新 text，
 *   工具执行前 push tool 段（executing），执行后 finishTool 落定状态与输出；
 * - executeWorkerTask（非自主分支）：轮次循环内同样按序构建。
 *
 * 会话区（ChatSession.vue）把 think 段与 tool 段渲染为可折叠块：
 * 点开 think 看思考全文，点开 tool 看命令行（入参）与返回内容。
 */

import type { ExecSegment } from '@/types'
import type { ToolCall } from '@/types'

/** 工具入参最大保留长度（超出截断） */
const MAX_INPUT_LEN = 2000
/** 工具返回内容最大保留长度（超出截断） */
const MAX_OUTPUT_LEN = 6000

let segSeq = 0
function nextSegId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++segSeq}`
}

/**
 * 开始一个思考段（每轮 LLM 输出对应一个），返回该段以便流式更新 text
 */
export function startThink(timeline: ExecSegment[]): ExecSegment & { type: 'think' } {
  const seg: ExecSegment & { type: 'think' } = {
    type: 'think',
    id: nextSegId('think'),
    text: '',
    done: false
  }
  timeline.push(seg)
  return seg
}

/**
 * 结束当前思考段；若该轮没有任何工具调用（即最终回复）或正文为空，
 * 则从时间线移除——最终正文由 speech.content 单独展示，避免重复
 */
export function endThink(timeline: ExecSegment[], seg: (ExecSegment & { type: 'think' }) | null, hasToolCalls: boolean): void {
  if (!seg) return
  seg.done = true
  const empty = !seg.text.trim()
  if (!hasToolCalls || empty) {
    const idx = timeline.indexOf(seg)
    if (idx >= 0) timeline.splice(idx, 1)
  }
}

/**
 * 开始一个工具段（工具执行前调用）
 */
export function startTool(timeline: ExecSegment[], tc: ToolCall, displayName: string): void {
  timeline.push({
    type: 'tool',
    id: nextSegId('tool'),
    toolCallId: tc.id,
    functionName: tc.function.name,
    displayName,
    status: 'executing',
    input: clip(tc.function.arguments || '', MAX_INPUT_LEN)
  })
}

/**
 * 落定工具段：状态 + 返回内容（截断）+ 可选 diff 数据。
 * 找不到对应 executing 段时静默忽略（如时间线未启用）。
 */
export function finishTool(
  timeline: ExecSegment[],
  toolCallId: string,
  status: 'completed' | 'error' | 'timeout',
  output: string,
  diffData?: { filePath: string; oldContent: string; newContent: string; isNew: boolean }
): void {
  const seg = timeline.find(s => s.type === 'tool' && s.toolCallId === toolCallId && s.status === 'executing')
  if (!seg || seg.type !== 'tool') return
  seg.status = status
  seg.output = clip(output, MAX_OUTPUT_LEN)
  if (diffData) seg.diffData = diffData
}

/** 把工具返回值格式化为可读文本（字符串原样，对象 JSON 美化） */
export function formatToolOutput(result: any): string {
  if (result === null || result === undefined) return '（无结果）'
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

function clip(text: string, max: number): string {
  if (!text) return ''
  if (text.length <= max) return text
  return text.slice(0, max) + `\n…（已截断，共 ${text.length} 字符）`
}

/**
 * 工具中文显示名（与 coordinator.getToolDisplayName 保持同一映射）
 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  web_search: '网络搜索',
  knowledge_query: '知识库检索',
  calculate: '计算器',
  read_file: '文件读取',
  write_file: '文件写入',
  search_replace: '补丁编辑',
  create_directory: '创建目录',
  read_directory: '读取目录',
  read_document: '文档解析',
  execute_command: '执行命令',
  search_code: '代码搜索',
  git_operation: 'Git 操作',
  git_auto_commit: 'Git 自动提交',
  git_create_branch: 'Git 创建分支',
  git_diff_summary: 'Git Diff 摘要',
  run_tests: '运行测试',
  save_memory: '保存记忆',
  search_memory: '搜索记忆',
  summarize_results: '结果汇总'
}

export function getToolDisplayName(name: string): string {
  return TOOL_DISPLAY_NAMES[name] || name
}
