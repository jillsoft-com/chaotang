/**
 * 代码审查测试（三期 Phase F）
 *
 * 覆盖：审查会话管理、变更 accept/reject、批量操作
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  createReviewSession,
  getReviewSession,
  addCodeChange,
  acceptChange,
  rejectChange,
  acceptAllChanges,
  rejectAllChanges,
  getPendingChangeCount,
  getReviewStats,
  completeReviewSession
} from '@/services/agent/code-review'

// ============ 测试用例 ============

describe('createReviewSession', () => {
  it('创建审查会话', () => {
    const session = createReviewSession('test-session-1')
    expect(session.id).toBeDefined()
    expect(session.sessionId).toBe('test-session-1')
    expect(session.changes).toHaveLength(0)
    expect(session.completedAt).toBeUndefined()
  })
})

describe('addCodeChange', () => {
  it('添加代码变更', () => {
    const session = createReviewSession('test-session-2')
    const change = addCodeChange(
      'test-session-2',
      'src/test.ts',
      'new content',
      'old content',
      'Test change'
    )
    
    expect(change.id).toBeDefined()
    expect(change.filePath).toBe('src/test.ts')
    expect(change.newContent).toBe('new content')
    expect(change.oldContent).toBe('old content')
    expect(change.status).toBe('pending')
    
    expect(session.changes).toHaveLength(1)
  })

  it('自动创建会话（如果不存在）', () => {
    const change = addCodeChange('auto-session', 'test.ts', 'content')
    const session = getReviewSession('auto-session')
    
    expect(session).toBeDefined()
    expect(session!.changes).toHaveLength(1)
  })
})

describe('acceptChange', () => {
  it('接受变更', () => {
    createReviewSession('test-session-3')
    const change = addCodeChange('test-session-3', 'test.ts', 'content')
    
    const result = acceptChange('test-session-3', change.id)
    expect(result).toBe(true)
    expect(change.status).toBe('accepted')
    expect(change.reviewedAt).toBeDefined()
  })

  it('不能重复接受', () => {
    createReviewSession('test-session-4')
    const change = addCodeChange('test-session-4', 'test.ts', 'content')
    acceptChange('test-session-4', change.id)
    
    const result = acceptChange('test-session-4', change.id)
    expect(result).toBe(false)
  })
})

describe('rejectChange', () => {
  it('拒绝变更', () => {
    createReviewSession('test-session-5')
    const change = addCodeChange('test-session-5', 'test.ts', 'content')
    
    const result = rejectChange('test-session-5', change.id)
    expect(result).toBe(true)
    expect(change.status).toBe('rejected')
    expect(change.reviewedAt).toBeDefined()
  })
})

describe('acceptAllChanges', () => {
  it('批量接受所有变更', () => {
    createReviewSession('test-session-6')
    addCodeChange('test-session-6', 'a.ts', 'content')
    addCodeChange('test-session-6', 'b.ts', 'content')
    addCodeChange('test-session-6', 'c.ts', 'content')
    
    const count = acceptAllChanges('test-session-6')
    expect(count).toBe(3)
    
    const stats = getReviewStats('test-session-6')
    expect(stats.accepted).toBe(3)
    expect(stats.pending).toBe(0)
  })
})

describe('rejectAllChanges', () => {
  it('批量拒绝所有变更', () => {
    createReviewSession('test-session-7')
    addCodeChange('test-session-7', 'a.ts', 'content')
    addCodeChange('test-session-7', 'b.ts', 'content')
    
    const count = rejectAllChanges('test-session-7')
    expect(count).toBe(2)
    
    const stats = getReviewStats('test-session-7')
    expect(stats.rejected).toBe(2)
    expect(stats.pending).toBe(0)
  })
})

describe('getPendingChangeCount', () => {
  it('返回待审查数量', () => {
    createReviewSession('test-session-8')
    addCodeChange('test-session-8', 'a.ts', 'content')
    addCodeChange('test-session-8', 'b.ts', 'content')
    
    expect(getPendingChangeCount('test-session-8')).toBe(2)
    
    const session = getReviewSession('test-session-8')!
    acceptChange('test-session-8', session.changes[0].id)
    
    expect(getPendingChangeCount('test-session-8')).toBe(1)
  })
})

describe('getReviewStats', () => {
  it('返回审查统计', () => {
    createReviewSession('test-session-9')
    const c1 = addCodeChange('test-session-9', 'a.ts', 'content')
    const c2 = addCodeChange('test-session-9', 'b.ts', 'content')
    addCodeChange('test-session-9', 'c.ts', 'content')
    
    acceptChange('test-session-9', c1.id)
    rejectChange('test-session-9', c2.id)
    
    const stats = getReviewStats('test-session-9')
    expect(stats.total).toBe(3)
    expect(stats.pending).toBe(1)
    expect(stats.accepted).toBe(1)
    expect(stats.rejected).toBe(1)
  })
})

describe('completeReviewSession', () => {
  it('完成审查会话', () => {
    const session = createReviewSession('test-session-10')
    expect(session.completedAt).toBeUndefined()
    
    completeReviewSession('test-session-10')
    expect(session.completedAt).toBeDefined()
  })
})
