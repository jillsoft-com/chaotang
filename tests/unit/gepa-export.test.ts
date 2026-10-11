/**
 * GEPA 导入导出测试
 *
 * 覆盖：
 * - 导出序列化与反序列化
 * - 导入去重
 * - 冲突检测
 * - 模式合并
 */

import { describe, it, expect } from 'vitest'
import {
  exportGEPA,
  serializeExport,
  parseImport,
  importGEPA,
  mergePatterns
} from '@/services/learning/gepa-export'
import type { LearningPattern } from '@/services/learning/gepa-engine'

function makePattern(overrides: Partial<LearningPattern> = {}): LearningPattern {
  return {
    id: 'pattern-1',
    name: 'Test Pattern',
    trigger: 'test trigger',
    solution: 'test solution',
    occurrenceCount: 1,
    lastTriggered: 1000,
    promotedToSkill: false,
    sourceDebates: ['debate-1'],
    ...overrides
  }
}

describe('GEPA 导出', () => {
  it('exportGEPA 生成正确的导出结构', () => {
    const patterns = [makePattern(), makePattern({ id: 'pattern-2', name: 'Second' })]
    const result = exportGEPA(patterns, [], 'test-source')

    expect(result.schemaVersion).toBe(1)
    expect(result.sourceId).toBe('test-source')
    expect(result.patterns).toHaveLength(2)
    expect(result.stats.totalPatterns).toBe(2)
    expect(result.exportedAt).toBeGreaterThan(0)
  })

  it('serializeExport 输出 JSON', () => {
    const data = exportGEPA([makePattern()])
    const json = serializeExport(data)
    const parsed = JSON.parse(json)
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.patterns).toHaveLength(1)
  })

  it('包含 promotedSkills 统计', () => {
    const patterns = [
      makePattern({ promotedToSkill: true }),
      makePattern({ id: 'p2', promotedToSkill: false })
    ]
    const result = exportGEPA(patterns)
    expect(result.stats.promotedSkills).toBe(1)
  })

  it('includeEvents 控制事件导出', () => {
    const events = [{ id: 'e1', debateId: 'd1', timestamp: 1000, type: 'pattern_discovered' as const, description: 'test' }]
    const without = exportGEPA([], events, 'src', false)
    const withEvents = exportGEPA([], events, 'src', true)

    expect(without.events).toBeUndefined()
    expect(withEvents.events).toHaveLength(1)
  })
})

describe('GEPA 导入解析', () => {
  it('parseImport 解析有效 JSON', () => {
    const data = exportGEPA([makePattern()])
    const json = serializeExport(data)
    const parsed = parseImport(json)

    expect(parsed).not.toBeNull()
    expect(parsed!.schemaVersion).toBe(1)
    expect(parsed!.patterns).toHaveLength(1)
  })

  it('parseImport 拒绝无效 JSON', () => {
    expect(parseImport('not json')).toBeNull()
    expect(parseImport('{"schemaVersion":2}')).toBeNull()
    expect(parseImport('{"schemaVersion":1}')).toBeNull()
  })

  it('parseImport 拒绝缺少必要字段', () => {
    expect(parseImport('{"schemaVersion":1,"patterns":[]}')).toBeNull()
    expect(parseImport('{"schemaVersion":1,"patterns":"not array","exportedAt":1}')).toBeNull()
  })
})

describe('GEPA 导入合并', () => {
  it('新模式直接添加', () => {
    const existing = [makePattern({ id: 'existing-1', name: 'Existing' })]
    const importData = exportGEPA([
      makePattern({ id: 'new-1', name: 'New Pattern', trigger: 'new trigger', solution: 'new solution' })
    ])

    const result = importGEPA(existing, importData)
    expect(result.addedPatterns).toBe(1)
    expect(result.mergedPatterns).toBe(0)
    expect(result.conflicts).toBe(0)
  })

  it('相同模式去重（增加出现次数）', () => {
    const existing = [makePattern({ id: 'p1', name: 'Pattern A', occurrenceCount: 3 })]
    const importData = exportGEPA([
      makePattern({ id: 'p1', name: 'Pattern A', occurrenceCount: 5 })
    ])

    const result = importGEPA(existing, importData)
    expect(result.mergedPatterns).toBe(1)
    expect(result.addedPatterns).toBe(0)
    expect(existing[0].occurrenceCount).toBe(5) // 取最大值
  })

  it('同名不同内容检测为冲突', () => {
    const existing = [makePattern({ id: 'p1', name: 'Same Name', trigger: 'trigger A', solution: 'solution A' })]
    const importData = exportGEPA([
      makePattern({ id: 'p2', name: 'Same Name', trigger: 'trigger B', solution: 'solution B' })
    ])

    const result = importGEPA(existing, importData)
    expect(result.conflicts).toBe(1)
    expect(result.conflictDetails).toHaveLength(1)
  })

  it('同 ID 不同内容检测为冲突', () => {
    const existing = [makePattern({ id: 'p1', trigger: 'A', solution: 'A' })]
    const importData = exportGEPA([
      makePattern({ id: 'p1', trigger: 'B', solution: 'B' })
    ])

    const result = importGEPA(existing, importData)
    expect(result.conflicts).toBe(1)
  })

  it('mergePatterns 返回完整列表', () => {
    const existing = [makePattern({ id: 'e1', name: 'Existing' })]
    const importData = exportGEPA([
      makePattern({ id: 'n1', name: 'New', trigger: 'new', solution: 'new' })
    ])

    const merged = mergePatterns(existing, importData)
    expect(merged).toHaveLength(2)
    expect(merged.some(p => p.id === 'e1')).toBe(true)
    expect(merged.some(p => p.id === 'n1')).toBe(true)
  })

  it('mergePatterns 不重复添加已有模式', () => {
    const existing = [makePattern({ id: 'p1', name: 'Shared' })]
    const importData = exportGEPA([
      makePattern({ id: 'p1', name: 'Shared' }),
      makePattern({ id: 'p2', name: 'New', trigger: 'new', solution: 'new' })
    ])

    const merged = mergePatterns(existing, importData)
    expect(merged).toHaveLength(2)
  })

  it('合并时更新 sourceDebates', () => {
    const existing = [makePattern({ id: 'p1', name: 'Shared', sourceDebates: ['d1'] })]
    const importData = exportGEPA([
      makePattern({ id: 'p1', name: 'Shared', sourceDebates: ['d2', 'd3'] })
    ])

    importGEPA(existing, importData)
    expect(existing[0].sourceDebates).toContain('d1')
    expect(existing[0].sourceDebates).toContain('d2')
    expect(existing[0].sourceDebates).toContain('d3')
  })

  it('同名不同 ID 相同内容：幂等导入不重复计数', () => {
    const existing = [makePattern({ id: 'id-1', name: 'Shared', trigger: 't', solution: 's', occurrenceCount: 3 })]
    const importData = exportGEPA([
      makePattern({ id: 'id-2', name: 'Shared', trigger: 't', solution: 's', occurrenceCount: 3 })
    ])

    const result = importGEPA(existing, importData)
    expect(result.mergedPatterns).toBe(1)
    // 幂等：取最大值而非相加 (3 + 3 = 6 是错误的)
    expect(existing[0].occurrenceCount).toBe(3)
  })

  it('同名不同 ID 相同内容：多次导入仍幂等', () => {
    const existing = [makePattern({ id: 'id-1', name: 'Shared', trigger: 't', solution: 's', occurrenceCount: 2 })]
    const importData = exportGEPA([
      makePattern({ id: 'id-2', name: 'Shared', trigger: 't', solution: 's', occurrenceCount: 5 })
    ])

    // 第一次导入
    importGEPA(existing, importData)
    expect(existing[0].occurrenceCount).toBe(5) // max(2, 5) = 5

    // 再次导入同一份数据
    importGEPA(existing, importData)
    expect(existing[0].occurrenceCount).toBe(5) // max(5, 5) = 5，不应该是 10
  })
})
