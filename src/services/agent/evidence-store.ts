/**
 * 证据独立存储 — 交接包压缩后仍可按编号取回完整原文
 *
 * 设计：
 * - 每条工具结果在交接包构建时存入此模块级 Map
 * - 编号格式为 {sessionId}-E{n}，全局唯一，不会跨次覆盖
 * - 调用方可通过 getEvidence(id) 取回完整原文
 * - clearSessionEvidence(sessionId) 在会话结束时清理该会话的全部证据
 * - 交接包渲染文本中附带取回说明，供大臣/调用方读取
 */

export interface StoredEvidence {
  /** 证据全局唯一编号，如 "s1728000000000-E1" */
  id: string
  /** 来源工具名 */
  source: string
  /** 完整工具结果原文 */
  fullText: string
  /** 所属会话 ID */
  sessionId: string
  /** 存入时间戳 */
  storedAt: number
}

/** 模块级证据存储 */
const evidenceMap = new Map<string, StoredEvidence>()

/** 每个会话的自增计数器 */
const sessionCounters = new Map<string, number>()

/**
 * 生成会话内唯一递增编号
 */
function nextEvidenceId(sessionId: string): string {
  const count = (sessionCounters.get(sessionId) || 0) + 1
  sessionCounters.set(sessionId, count)
  return `${sessionId}-E${count}`
}

/**
 * 存入一条证据，返回生成的编号
 */
export function storeEvidence(sessionId: string, source: string, fullText: string): string {
  const id = nextEvidenceId(sessionId)
  evidenceMap.set(id, { id, source, fullText, sessionId, storedAt: Date.now() })
  return id
}

/**
 * 按编号读取完整证据原文
 * @returns 证据对象，未找到返回 null
 */
export function getEvidence(id: string): StoredEvidence | null {
  return evidenceMap.get(id) || null
}

/**
 * 列出所有已存储的证据 ID
 */
export function listEvidenceIds(): string[] {
  return [...evidenceMap.keys()]
}

/**
 * 获取所有证据的摘要列表（编号 + 来源 + 前 100 字）
 */
export function listEvidenceSummaries(): { id: string; source: string; preview: string }[] {
  const result: { id: string; source: string; preview: string }[] = []
  for (const ev of evidenceMap.values()) {
    result.push({
      id: ev.id,
      source: ev.source,
      preview: ev.fullText.slice(0, 100)
    })
  }
  return result
}

/**
 * 清空指定会话的全部证据（会话结束时调用）
 */
export function clearSessionEvidence(sessionId: string): void {
  for (const [id, ev] of evidenceMap.entries()) {
    if (ev.sessionId === sessionId) {
      evidenceMap.delete(id)
    }
  }
  sessionCounters.delete(sessionId)
}

/**
 * 清空全部证据存储（仅测试或全局重置时使用）
 */
export function clearEvidenceStore(): void {
  evidenceMap.clear()
  sessionCounters.clear()
}

/**
 * 当前存储的证据数量
 */
export function evidenceCount(): number {
  return evidenceMap.size
}
