/**
 * 代码审查服务 — 三期 Phase F
 *
 * 管理代码变更的审查状态，支持 accept/reject 操作
 */

// ============ 类型 ============

export interface CodeChange {
  id: string
  filePath: string
  oldContent?: string
  newContent: string
  description?: string
  status: 'pending' | 'accepted' | 'rejected'
  createdAt: number
  reviewedAt?: number
}

export interface CodeReviewSession {
  id: string
  sessionId: string
  changes: CodeChange[]
  createdAt: number
  completedAt?: number
}

// ============ 审查状态管理 ============

const reviewSessions = new Map<string, CodeReviewSession>()

/**
 * 创建代码审查会话
 */
export function createReviewSession(sessionId: string): CodeReviewSession {
  const session: CodeReviewSession = {
    id: `review-${Date.now()}`,
    sessionId,
    changes: [],
    createdAt: Date.now()
  }
  reviewSessions.set(sessionId, session)
  return session
}

/**
 * 获取审查会话
 */
export function getReviewSession(sessionId: string): CodeReviewSession | undefined {
  return reviewSessions.get(sessionId)
}

/**
 * 添加代码变更
 */
export function addCodeChange(
  sessionId: string,
  filePath: string,
  newContent: string,
  oldContent?: string,
  description?: string
): CodeChange {
  let session = reviewSessions.get(sessionId)
  if (!session) {
    session = createReviewSession(sessionId)
  }

  const change: CodeChange = {
    id: `change-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    filePath,
    oldContent,
    newContent,
    description,
    status: 'pending',
    createdAt: Date.now()
  }

  session.changes.push(change)
  return change
}

/**
 * 接受代码变更
 */
export function acceptChange(sessionId: string, changeId: string): boolean {
  const session = reviewSessions.get(sessionId)
  if (!session) return false

  const change = session.changes.find(c => c.id === changeId)
  if (!change || change.status !== 'pending') return false

  change.status = 'accepted'
  change.reviewedAt = Date.now()
  return true
}

/**
 * 拒绝代码变更
 */
export function rejectChange(sessionId: string, changeId: string): boolean {
  const session = reviewSessions.get(sessionId)
  if (!session) return false

  const change = session.changes.find(c => c.id === changeId)
  if (!change || change.status !== 'pending') return false

  change.status = 'rejected'
  change.reviewedAt = Date.now()
  return true
}

/**
 * 批量接受所有变更
 */
export function acceptAllChanges(sessionId: string): number {
  const session = reviewSessions.get(sessionId)
  if (!session) return 0

  let count = 0
  for (const change of session.changes) {
    if (change.status === 'pending') {
      change.status = 'accepted'
      change.reviewedAt = Date.now()
      count++
    }
  }
  return count
}

/**
 * 批量拒绝所有变更
 */
export function rejectAllChanges(sessionId: string): number {
  const session = reviewSessions.get(sessionId)
  if (!session) return 0

  let count = 0
  for (const change of session.changes) {
    if (change.status === 'pending') {
      change.status = 'rejected'
      change.reviewedAt = Date.now()
      count++
    }
  }
  return count
}

/**
 * 完成审查会话
 */
export function completeReviewSession(sessionId: string): void {
  const session = reviewSessions.get(sessionId)
  if (session) {
    session.completedAt = Date.now()
  }
}

/**
 * 获取待审查的变更数量
 */
export function getPendingChangeCount(sessionId: string): number {
  const session = reviewSessions.get(sessionId)
  if (!session) return 0
  return session.changes.filter(c => c.status === 'pending').length
}

/**
 * 获取审查统计
 */
export function getReviewStats(sessionId: string): {
  total: number
  pending: number
  accepted: number
  rejected: number
} {
  const session = reviewSessions.get(sessionId)
  if (!session) {
    return { total: 0, pending: 0, accepted: 0, rejected: 0 }
  }

  return {
    total: session.changes.length,
    pending: session.changes.filter(c => c.status === 'pending').length,
    accepted: session.changes.filter(c => c.status === 'accepted').length,
    rejected: session.changes.filter(c => c.status === 'rejected').length
  }
}
