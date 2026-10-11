/**
 * GEPA 学习成果导出与导入
 *
 * 版本化 JSON 导出/导入，支持去重和冲突处理。
 *
 * 设计依据：朝堂任务树运行时改进说明 R9。
 */

import type { LearningPattern, LearningEvent } from './gepa-engine'

// ============ 类型 ============

export interface GEPAExport {
  /** 导出格式版本 */
  schemaVersion: 1
  /** 导出时间 */
  exportedAt: number
  /** 来源标识 */
  sourceId: string
  /** 学习模式 */
  patterns: LearningPattern[]
  /** 学习事件（可选，默认不导出事件以保持文件轻量） */
  events?: LearningEvent[]
  /** 导出统计 */
  stats: {
    totalPatterns: number
    promotedSkills: number
    totalEvents: number
  }
}

export interface ImportResult {
  /** 导入是否成功 */
  ok: boolean
  /** 新增的模式数 */
  addedPatterns: number
  /** 合并的模式数（已存在，增加了出现次数） */
  mergedPatterns: number
  /** 冲突的模式数（相同 key 但不同内容） */
  conflicts: number
  /** 冲突详情 */
  conflictDetails: Array<{ key: string; existing: string; incoming: string }>
  /** 错误信息 */
  error?: string
}

// ============ 导出 ============

/**
 * 导出 GEPA 学习成果
 *
 * @param patterns 学习模式列表
 * @param events 学习事件列表（可选）
 * @param sourceId 来源标识
 * @param includeEvents 是否包含事件（默认 false）
 */
export function exportGEPA(
  patterns: LearningPattern[],
  events: LearningEvent[] = [],
  sourceId: string = 'default',
  includeEvents: boolean = false
): GEPAExport {
  const promoted = patterns.filter(p => p.promotedToSkill).length

  return {
    schemaVersion: 1,
    exportedAt: Date.now(),
    sourceId,
    patterns: patterns.map(p => ({ ...p })),
    events: includeEvents ? events.map(e => ({ ...e })) : undefined,
    stats: {
      totalPatterns: patterns.length,
      promotedSkills: promoted,
      totalEvents: events.length
    }
  }
}

/**
 * 将导出结果序列化为 JSON 字符串
 */
export function serializeExport(data: GEPAExport): string {
  return JSON.stringify(data, null, 2)
}

// ============ 导入 ============

/**
 * 解析 JSON 字符串为 GEPA 导出数据
 */
export function parseImport(jsonStr: string): GEPAExport | null {
  try {
    const data = JSON.parse(jsonStr)

    // 基本校验
    if (!data || typeof data !== 'object') return null
    if (data.schemaVersion !== 1) return null
    if (!Array.isArray(data.patterns)) return null
    if (!data.exportedAt || typeof data.exportedAt !== 'number') return null

    return data as GEPAExport
  } catch {
    return null
  }
}

/**
 * 导入 GEPA 学习成果（合并到已有数据）
 *
 * @param existingPatterns 现有学习模式
 * @param importData 导入的数据
 * @returns 导入结果
 */
export function importGEPA(
  existingPatterns: LearningPattern[],
  importData: GEPAExport
): ImportResult {
  const result: ImportResult = {
    ok: true,
    addedPatterns: 0,
    mergedPatterns: 0,
    conflicts: 0,
    conflictDetails: []
  }

  // 构建现有模式的索引（按 id 和按关键字）
  const existingById = new Map<string, LearningPattern>()
  const existingByName = new Map<string, LearningPattern>()

  for (const p of existingPatterns) {
    existingById.set(p.id, p)
    existingByName.set(p.name.toLowerCase(), p)
  }

  for (const incoming of importData.patterns) {
    // 1. 按 ID 匹配
    const byId = existingById.get(incoming.id)
    if (byId) {
      if (isSameContent(byId, incoming)) {
        // 相同内容：合并出现次数
        byId.occurrenceCount = Math.max(byId.occurrenceCount, incoming.occurrenceCount)
        byId.lastTriggered = Math.max(byId.lastTriggered, incoming.lastTriggered)
        mergeSourceDebates(byId, incoming)
        result.mergedPatterns++
      } else {
        // 相同 ID 但不同内容：冲突
        result.conflicts++
        result.conflictDetails.push({
          key: incoming.id,
          existing: byId.name,
          incoming: incoming.name
        })
      }
      continue
    }

    // 2. 按名称匹配（可能来自不同来源的同一模式）
    const byName = existingByName.get(incoming.name.toLowerCase())
    if (byName) {
      if (isSameContent(byName, incoming)) {
        // 幂等导入：取最大值而非相加，避免重复导入时 occurrenceCount 膨胀
        byName.occurrenceCount = Math.max(byName.occurrenceCount, incoming.occurrenceCount)
        byName.lastTriggered = Math.max(byName.lastTriggered, incoming.lastTriggered)
        mergeSourceDebates(byName, incoming)
        result.mergedPatterns++
      } else {
        // 同名不同内容：冲突
        result.conflicts++
        result.conflictDetails.push({
          key: incoming.name,
          existing: byName.solution.slice(0, 50),
          incoming: incoming.solution.slice(0, 50)
        })
      }
      continue
    }

    // 3. 新模式：添加到现有列表
    existingPatterns.push({ ...incoming })
    result.addedPatterns++
  }

  return result
}

/**
 * 合并导入的模式到现有列表（返回新的完整列表）
 */
export function mergePatterns(
  existingPatterns: LearningPattern[],
  importData: GEPAExport
): LearningPattern[] {
  const result = [...existingPatterns.map(p => ({ ...p }))]
  const existingIds = new Set(result.map(p => p.id))
  const existingNames = new Set(result.map(p => p.name.toLowerCase()))

  for (const incoming of importData.patterns) {
    if (!existingIds.has(incoming.id) && !existingNames.has(incoming.name.toLowerCase())) {
      result.push({ ...incoming })
    }
  }

  return result
}

// ============ 辅助函数 ============

function isSameContent(a: LearningPattern, b: LearningPattern): boolean {
  return a.trigger === b.trigger && a.solution === b.solution
}

function mergeSourceDebates(existing: LearningPattern, incoming: LearningPattern): void {
  for (const debateId of incoming.sourceDebates) {
    if (!existing.sourceDebates.includes(debateId)) {
      existing.sourceDebates.push(debateId)
    }
  }
}
