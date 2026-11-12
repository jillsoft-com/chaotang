/**
 * 行级 diff 工具
 *
 * 工程里原先有三处各自实现的"简易 diff"（ChatSession.computeSimpleDiff、
 * DeliveryPanel.computeDiffLines、delivery-report.countLineDiff），它们都是
 * 集合式比对：先把所有删除行吐完再吐所有新增行，没有上下文、没有 hunk、
 * 行的先后顺序也丢了，读起来是两坨文本而不是差异。
 *
 * 这里统一为一套基于 LCS 的对齐结果，三种消费形态：
 * - diffRows    逐行渲染（会话气泡 / 交付面板 / 抽屉里的行级着色）
 * - toUnifiedDiff  git 风格文本（右侧面板 diff 视图直接按行首字符着色）
 * - diffStats   增删行数（chip 上的 +N -N 徽标）
 */

export type DiffRowType = 'unchanged' | 'added' | 'removed' | 'gap'

export interface DiffRow {
  type: DiffRowType
  line: string
  /** 该行的行号：删除行取旧文件行号，其余取新文件行号（1 起） */
  lineNum?: number
  oldNum?: number
  newNum?: number
}

export interface DiffStats {
  added: number
  removed: number
}

type Op =
  | { kind: 'eq'; o: number; n: number }
  | { kind: 'del'; o: number }
  | { kind: 'ins'; n: number }

/**
 * LCS 动态规划规模上限（旧行数 × 新中间段行数）。
 * 超过则退化为"整段删除 + 整段新增"，避免超大文件把主线程吃死。
 */
const MAX_LCS_CELLS = 1_500_000

/** 默认上下文行数，与 git diff 保持一致 */
const DEFAULT_CONTEXT = 3

function splitLines(content: string): string[] {
  if (content === '') return []
  const lines = content.split('\n')
  // 以换行结尾的文件 split 会多出一个空串，去掉它，避免 diff 尾部凭空多一行
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 计算旧内容到新内容的行对齐序列。
 *
 * 先掐掉公共前缀与公共后缀（真实编辑绝大多数只动中间一小块），
 * 再对中间段做 LCS；规模过大时退化为整段替换。
 */
function align(oldLines: string[], newLines: string[]): Op[] {
  const ops: Op[] = []

  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++
  }

  for (let i = 0; i < prefix; i++) ops.push({ kind: 'eq', o: i, n: i })

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix)
  const newMid = newLines.slice(prefix, newLines.length - suffix)

  if (oldMid.length === 0 && newMid.length === 0) {
    // 只剩公共后缀
  } else if (oldMid.length * newMid.length > MAX_LCS_CELLS || oldMid.length === 0 || newMid.length === 0) {
    // 规模超限或单边为空：整段替换即可（结果与逐行比对一致，只是不做相同行配对）
    for (let i = 0; i < oldMid.length; i++) ops.push({ kind: 'del', o: prefix + i })
    for (let j = 0; j < newMid.length; j++) ops.push({ kind: 'ins', n: prefix + j })
  } else {
    const m = oldMid.length
    const n = newMid.length
    // dp[i][j] = oldMid[i:] 与 newMid[j:] 的最长公共子序列长度
    const dp = new Int32Array((m + 1) * (n + 1))
    const at = (i: number, j: number) => i * (n + 1) + j
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[at(i, j)] = oldMid[i] === newMid[j]
          ? dp[at(i + 1, j + 1)] + 1
          : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)])
      }
    }
    let i = 0
    let j = 0
    while (i < m && j < n) {
      if (oldMid[i] === newMid[j]) {
        ops.push({ kind: 'eq', o: prefix + i, n: prefix + j })
        i++
        j++
      } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
        ops.push({ kind: 'del', o: prefix + i })
        i++
      } else {
        ops.push({ kind: 'ins', n: prefix + j })
        j++
      }
    }
    while (i < m) { ops.push({ kind: 'del', o: prefix + i }); i++ }
    while (j < n) { ops.push({ kind: 'ins', n: prefix + j }); j++ }
  }

  for (let k = 0; k < suffix; k++) {
    const oi = oldLines.length - suffix + k
    const ni = newLines.length - suffix + k
    ops.push({ kind: 'eq', o: oi, n: ni })
  }

  return ops
}

/**
 * 逐行差异序列。
 *
 * @param context 保留的上下文行数；传 0 表示只输出变更行。
 *   默认 3（git 风格）。连续未改动的行超过 context 时折叠成一行 gap 提示。
 */
export function diffRows(
  oldContent: string,
  newContent: string,
  context: number = DEFAULT_CONTEXT
): DiffRow[] {
  const oldLines = splitLines(oldContent)
  const newLines = splitLines(newContent)
  const ops = align(oldLines, newLines)

  const changedIdx = new Set<number>()
  ops.forEach((op, idx) => {
    if (op.kind === 'eq') return
    for (let k = idx - context; k <= idx + context; k++) {
      if (k >= 0 && k < ops.length && ops[k].kind === 'eq') changedIdx.add(k)
    }
  })

  const rows: DiffRow[] = []
  let hiddenRun = 0
  ops.forEach((op, idx) => {
    if (op.kind === 'del') {
      if (hiddenRun > 0) { rows.push({ type: 'gap', line: `… 省略 ${hiddenRun} 行未改动内容 …` }); hiddenRun = 0 }
      rows.push({ type: 'removed', line: oldLines[op.o], lineNum: op.o + 1, oldNum: op.o + 1 })
    } else if (op.kind === 'ins') {
      if (hiddenRun > 0) { rows.push({ type: 'gap', line: `… 省略 ${hiddenRun} 行未改动内容 …` }); hiddenRun = 0 }
      rows.push({ type: 'added', line: newLines[op.n], lineNum: op.n + 1, newNum: op.n + 1 })
    } else if (context > 0 && changedIdx.has(idx)) {
      if (hiddenRun > 0) { rows.push({ type: 'gap', line: `… 省略 ${hiddenRun} 行未改动内容 …` }); hiddenRun = 0 }
      rows.push({ type: 'unchanged', line: oldLines[op.o], lineNum: op.n + 1, oldNum: op.o + 1, newNum: op.n + 1 })
    } else {
      hiddenRun++
    }
  })
  if (hiddenRun > 0) rows.push({ type: 'gap', line: `… 省略 ${hiddenRun} 行未改动内容 …` })

  return rows
}

/** 增删行数统计（chip 徽标与交付报告用） */
export function diffStats(oldContent: string, newContent: string): DiffStats {
  const oldLines = splitLines(oldContent)
  const newLines = splitLines(newContent)
  let added = 0
  let removed = 0
  for (const op of align(oldLines, newLines)) {
    if (op.kind === 'del') removed++
    else if (op.kind === 'ins') added++
  }
  return { added, removed }
}

/**
 * 生成 git 风格的 unified diff 文本。
 *
 * 右侧面板已有按行首字符（+/-/@@/diff）着色的渲染器，直接复用这套文本，
 * 无需再写一份渲染分支。
 */
export function toUnifiedDiff(
  oldContent: string,
  newContent: string,
  filePath = 'file',
  context: number = DEFAULT_CONTEXT
): string {
  const oldLines = splitLines(oldContent)
  const newLines = splitLines(newContent)
  const ops = align(oldLines, newLines)

  if (ops.every(o => o.kind === 'eq')) return ''

  // 按「变更簇」切 hunk：两个相邻变更之间若未改动行数 > 2*context，则断开
  const hunks: Array<{ start: number; end: number }> = []
  let cur: { start: number; end: number } | null = null
  let lastChangeIdx = -1
  ops.forEach((op, idx) => {
    if (op.kind === 'eq') return
    if (!cur || (lastChangeIdx >= 0 && idx - lastChangeIdx > context * 2)) {
      cur = { start: Math.max(0, idx - context), end: idx }
      hunks.push(cur)
    }
    cur.end = idx
    lastChangeIdx = idx
  })
  // 每个簇各自补尾部上下文，并与下一簇的头部上下文错开，避免重叠
  hunks.forEach((h, i) => {
    const next = i + 1 < hunks.length ? hunks[i + 1].start - 1 : ops.length - 1
    h.end = Math.min(next, h.end + context)
  })

  const out: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`]
  for (const h of hunks) {
    let oldStart = 0
    let newStart = 0
    let oldCount = 0
    let newCount = 0
    const body: string[] = []
    for (let idx = h.start; idx <= h.end; idx++) {
      const op = ops[idx]
      if (op.kind === 'eq') {
        if (oldStart === 0) oldStart = op.o + 1
        if (newStart === 0) newStart = op.n + 1
        oldCount++
        newCount++
        body.push(` ${oldLines[op.o]}`)
      } else if (op.kind === 'del') {
        if (oldStart === 0) oldStart = op.o + 1
        oldCount++
        body.push(`-${oldLines[op.o]}`)
      } else {
        if (newStart === 0) newStart = op.n + 1
        newCount++
        body.push(`+${newLines[op.n]}`)
      }
    }
    // 纯新增/纯删除的簇可能取不到对侧起点，git 用 0 表示该侧无行
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    out.push(...body)
  }

  return out.join('\n')
}
