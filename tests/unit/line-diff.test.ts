/**
 * 行级 diff 工具 — 纯逻辑单测
 *
 * 覆盖统一 diff 的三种消费形态：
 * - diffRows      逐行渲染（上下文保留、未改动段折叠）
 * - diffStats     增删行数（chip 上的 +N -N 徽标）
 * - toUnifiedDiff git 风格文本（右侧面板按行首字符着色）
 *
 * 同时验证落盘裁剪 trimDeliveryReportForStorage：正文超限时丢弃并禁用撤销，
 * 且不改动传入对象（内存里仍要保留完整正文用于撤销与内联 diff）。
 */

import { describe, it, expect } from 'vitest'
import { diffRows, diffStats, toUnifiedDiff } from '@/utils/line-diff'
import {
  MAX_SNAPSHOT_CHARS,
  trimDeliveryReportForStorage,
  type DeliveryReport
} from '@/services/agent/delivery-report'

describe('diffStats — 增删行数', () => {
  it('单行修改算一增一删', () => {
    expect(diffStats('a\nb\nc', 'a\nB\nc')).toEqual({ added: 1, removed: 1 })
  })

  it('重复行不会被集合式算法抵消', () => {
    // 旧实现用 Set 求交集：三行 x 与两行 x 交集非空，会算成 0/0
    expect(diffStats('x\nx\nx', 'x\nx')).toEqual({ added: 0, removed: 1 })
  })

  it('顺序调换是一增一删而不是零', () => {
    // 旧实现两行的集合相同，会认为「无改动」
    expect(diffStats('a\nb', 'b\na')).toEqual({ added: 1, removed: 1 })
  })

  it('新建文件全部为新增', () => {
    expect(diffStats('', 'a\nb')).toEqual({ added: 2, removed: 0 })
  })

  it('清空文件全部为删除', () => {
    expect(diffStats('a\nb', '')).toEqual({ added: 0, removed: 2 })
  })

  it('两侧一致返回零', () => {
    expect(diffStats('a\nb', 'a\nb')).toEqual({ added: 0, removed: 0 })
  })

  it('尾部换行不产生幻影行', () => {
    expect(diffStats('a\n', 'a\n')).toEqual({ added: 0, removed: 0 })
    expect(diffStats('a\nb\n', 'a\n')).toEqual({ added: 0, removed: 1 })
  })

  it('中间插入不牵连上下文', () => {
    const old = Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n')
    const neu = old.split('\n').map(l => (l === 'line-25' ? 'line-25\ninserted' : l)).join('\n')
    expect(diffStats(old, neu)).toEqual({ added: 1, removed: 0 })
  })

  it('规模超限退化为整段替换而不卡死', () => {
    // 1300 x 1300 > MAX_LCS_CELLS(150 万)，走整段替换分支
    const old = ['same', ...Array.from({ length: 1300 }, (_, i) => `old-${i}`)].join('\n')
    const neu = ['same', ...Array.from({ length: 1300 }, (_, i) => `new-${i}`)].join('\n')
    expect(diffStats(old, neu)).toEqual({ added: 1300, removed: 1300 })
  })
})

describe('diffRows — 逐行差异', () => {
  const old9 = Array.from({ length: 9 }, (_, i) => `l${i + 1}`).join('\n')
  const new9 = old9.replace('l5', 'X')

  it('变更行按类型输出，行号分别取旧/新文件', () => {
    const rows = diffRows(old9, new9)
    const removed = rows.filter(r => r.type === 'removed')
    const added = rows.filter(r => r.type === 'added')
    expect(removed.map(r => ({ line: r.line, num: r.lineNum }))).toEqual([{ line: 'l5', num: 5 }])
    expect(added.map(r => ({ line: r.line, num: r.lineNum }))).toEqual([{ line: 'X', num: 5 }])
  })

  it('变更处保留上下文，远离变更的段落折叠成 gap', () => {
    const rows = diffRows(old9, new9)
    const unchanged = rows.filter(r => r.type === 'unchanged').map(r => r.line)
    // 前后各 3 行上下文；首尾多出的 l1、l9 被折叠
    expect(unchanged).toEqual(['l2', 'l3', 'l4', 'l6', 'l7', 'l8'])
    const gaps = rows.filter(r => r.type === 'gap')
    expect(gaps).toHaveLength(2)
    expect(gaps[0].line).toContain('省略 1 行')
  })

  it('context 传 0 时只剩变更行', () => {
    const rows = diffRows(old9, new9, 0)
    expect(rows.some(r => r.type === 'unchanged')).toBe(false)
    expect(rows.filter(r => r.type !== 'gap').map(r => r.line)).toEqual(['l5', 'X'])
  })

  it('完全一致时只给一行折叠提示', () => {
    const rows = diffRows('a\nb', 'a\nb')
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('gap')
    expect(rows[0].line).toContain('2 行')
  })

  it('旧实现会丢顺序：变更与上下文交错而非上下两块', () => {
    const rows = diffRows('a\nb\nc', 'a\nc\nb')
    expect(rows.filter(r => r.type === 'removed')).toHaveLength(1)
    expect(rows.filter(r => r.type === 'added')).toHaveLength(1)
    const types = rows.map(r => r.type)
    const firstChange = types.findIndex(t => t !== 'unchanged' && t !== 'gap')
    const lastContext = types.lastIndexOf('unchanged')
    // 旧实现会先把所有删除行吐完再吐所有新增行
    expect(lastContext).toBeGreaterThan(firstChange)
  })
})

describe('toUnifiedDiff — git 风格文本', () => {
  it('输出文件头与 hunk 头', () => {
    const text = toUnifiedDiff('a\nb\nc', 'a\nB\nc', 'app.ts')
    expect(text.split('\n')).toEqual([
      '--- a/app.ts',
      '+++ b/app.ts',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c'
    ])
  })

  it('纯新增用 -0,0 表示旧侧无行', () => {
    const text = toUnifiedDiff('', 'x\ny', 'new.ts')
    expect(text).toContain('@@ -0,0 +1,2 @@')
    expect(text).toContain('+x')
    expect(text).toContain('+y')
  })

  it('纯删除时新侧计数为 0', () => {
    const text = toUnifiedDiff('x\ny', '', 'gone.ts')
    expect(text).toContain('@@ -1,2 +0,0 @@')
    expect(text).toContain('-x')
  })

  it('无改动返回空串', () => {
    expect(toUnifiedDiff('a\nb', 'a\nb')).toBe('')
  })

  it('相距较远的两处改动拆成两个 hunk，各自带尾部上下文', () => {
    const old = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join('\n')
    const neu = old.replace('l2', 'X').replace('l11', 'Y')
    const lines = toUnifiedDiff(old, neu, 'f.ts').split('\n')
    const hunks = lines.filter(l => l.startsWith('@@'))
    expect(hunks).toHaveLength(2)
    // l1 + 尾部 3 行上下文 => 旧侧 5 行
    expect(hunks[0]).toBe('@@ -1,5 +1,5 @@')
    expect(hunks[1]).toBe('@@ -8,5 +8,5 @@')
  })

  it('行首字符可直接用于着色', () => {
    const lines = toUnifiedDiff('a\nb', 'a\nB', 'f').split('\n')
    expect(lines.some(l => l.startsWith('+'))).toBe(true)
    expect(lines.some(l => l.startsWith('-'))).toBe(true)
    expect(lines.some(l => l.startsWith(' '))).toBe(true)
  })
})

describe('trimDeliveryReportForStorage — 落盘裁剪', () => {
  function reportWith(files: DeliveryReport['changedFiles']): DeliveryReport {
    return {
      changedFiles: files,
      acceptanceState: 'unverified',
      acceptanceChecks: [],
      unresolvedQuestions: [],
      repairsUsed: 0
    }
  }

  it('未超限的正文原样保留', () => {
    const report = reportWith([
      { path: 'a.ts', status: 'modified', oldContent: 'x', newContent: 'y', linesAdded: 1, linesRemoved: 1 }
    ])
    const trimmed = trimDeliveryReportForStorage(report)
    expect(trimmed.changedFiles[0].oldContent).toBe('x')
    expect(trimmed.changedFiles[0].newContent).toBe('y')
    expect(trimmed.changedFiles[0].contentTrimmed).toBeUndefined()
  })

  it('超限时丢弃正文、标记裁剪并禁用撤销', () => {
    const big = 'z'.repeat(MAX_SNAPSHOT_CHARS + 1)
    const trimmed = trimDeliveryReportForStorage(
      reportWith([
        { path: 'big.ts', status: 'modified', oldContent: big, newContent: big, linesAdded: 10, linesRemoved: 4 }
      ])
    )
    const f = trimmed.changedFiles[0]
    expect(f.oldContent).toBeUndefined()
    expect(f.newContent).toBeUndefined()
    expect(f.contentTrimmed).toBe(true)
    expect(f.revertDisabled).toBe(true)
    // 行数统计要留住，chip 仍能显示 +N -N
    expect(f.linesAdded).toBe(10)
    expect(f.linesRemoved).toBe(4)
  })

  it('只丢超限的那一侧', () => {
    const big = 'z'.repeat(MAX_SNAPSHOT_CHARS + 1)
    const trimmed = trimDeliveryReportForStorage(
      reportWith([
        { path: 'new.ts', status: 'created', newContent: big, linesAdded: 3, linesRemoved: 0 }
      ])
    )
    const f = trimmed.changedFiles[0]
    expect(f.newContent).toBeUndefined()
    expect(f.oldContent).toBeUndefined()
    // 新建文件本就无需原始内容，裁剪后仍然不可撤销
    expect(f.revertDisabled).toBeUndefined()
  })

  it('不改动传入对象', () => {
    const big = 'z'.repeat(MAX_SNAPSHOT_CHARS + 1)
    const report = reportWith([
      { path: 'big.ts', status: 'modified', oldContent: big, newContent: 'v2', linesAdded: 1, linesRemoved: 1 }
    ])
    const trimmed = trimDeliveryReportForStorage(report)
    expect(report.changedFiles[0].oldContent).toBe(big)
    expect(report.changedFiles[0].contentTrimmed).toBeUndefined()
    expect(trimmed.changedFiles[0]).not.toBe(report.changedFiles[0])
  })

  it('自定义上限同样生效', () => {
    const trimmed = trimDeliveryReportForStorage(
      reportWith([
        { path: 's.ts', status: 'modified', oldContent: 'aaaa', newContent: 'b', linesAdded: 1, linesRemoved: 1 }
      ]),
      2
    )
    expect(trimmed.changedFiles[0].oldContent).toBeUndefined()
    expect(trimmed.changedFiles[0].newContent).toBe('b')
  })
})
