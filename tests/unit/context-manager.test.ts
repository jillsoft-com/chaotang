/**
 * 上下文管理测试
 *
 * 覆盖：
 * - Token 估算
 * - 已知/未知模型容量
 * - 消息压缩策略
 * - 关键消息保留
 * - 压缩历史追踪
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  ContextManager,
  getModelContextLimit,
  getDefaultCharThreshold
} from '@/services/agent/context-manager'
import type { ContextMessage } from '@/services/agent/context-manager'

function makeMsg(role: 'system' | 'user' | 'assistant', content: string, source?: ContextMessage['source']): ContextMessage {
  return { role, content, source }
}

describe('ContextManager', () => {
  let mgr: ContextManager

  beforeEach(() => {
    mgr = new ContextManager('gpt-4o')
  })

  describe('模型容量', () => {
    it('已知模型返回正确容量', () => {
      expect(getModelContextLimit('gpt-4o')).toBe(128000)
      expect(getModelContextLimit('claude-3.5-sonnet')).toBe(200000)
    })

    it('未知模型返回 null', () => {
      expect(getModelContextLimit('unknown-model')).toBeNull()
    })

    it('getDefaultCharThreshold 返回 50000', () => {
      expect(getDefaultCharThreshold()).toBe(50000)
    })

    it('getBudget 返回正确预算', () => {
      const budget = mgr.getBudget()
      expect(budget.maxTokens).toBe(128000)
      expect(budget.modelId).toBe('gpt-4o')
    })
  })

  describe('Token 估算', () => {
    it('estimateTokens 按 1:3 比例估算', () => {
      expect(mgr.estimateTokens('abc')).toBe(1)
      expect(mgr.estimateTokens('a'.repeat(300))).toBe(100)
    })

    it('getAvailableChars 扣除系统保留', () => {
      const available = mgr.getAvailableChars()
      // 128000 tokens * 3 chars/token * 0.9 = 345600
      expect(available).toBe(Math.floor(128000 * 3 * 0.9))
    })
  })

  describe('上下文超限检测', () => {
    it('短消息不超限', () => {
      const messages = [makeMsg('user', 'hello'), makeMsg('assistant', 'hi')]
      expect(mgr.exceedsContextLimit(messages)).toBe(false)
    })

    it('超长消息超限', () => {
      const longContent = 'a'.repeat(400000)
      const messages = [makeMsg('user', longContent)]
      expect(mgr.exceedsContextLimit(messages)).toBe(true)
    })
  })

  describe('消息压缩', () => {
    it('保留 system 消息', () => {
      const messages: ContextMessage[] = [
        makeMsg('system', 'System prompt', 'system_constraint'),
        makeMsg('user', 'User message 1'),
        makeMsg('assistant', 'Assistant reply 1'),
        makeMsg('user', 'User message 2'),
        makeMsg('assistant', 'Assistant reply 2'),
        makeMsg('user', 'User message 3'),
        makeMsg('assistant', 'Assistant reply 3'),
        makeMsg('user', 'Latest message')
      ]

      const { compressed } = mgr.compress(messages)
      const systemMsgs = compressed.filter(m => m.role === 'system')
      expect(systemMsgs.length).toBeGreaterThanOrEqual(1)
      expect(systemMsgs[0].content).toContain('System prompt')
    })

    it('保留 critical 消息', () => {
      const messages: ContextMessage[] = [
        makeMsg('system', 'System prompt', 'system_constraint'),
        { role: 'user', content: 'Task goal', source: 'task_goal', critical: true },
        makeMsg('user', 'History 1'),
        makeMsg('assistant', 'History 2'),
        makeMsg('user', 'History 3'),
        makeMsg('assistant', 'History 4'),
        makeMsg('user', 'Latest')
      ]

      const { compressed } = mgr.compress(messages)
      const hasTaskGoal = compressed.some(m => m.content === 'Task goal')
      expect(hasTaskGoal).toBe(true)
    })

    it('保留最近 N 轮对话', () => {
      const messages: ContextMessage[] = [
        makeMsg('system', 'System'),
        makeMsg('user', 'Turn 1 user'),
        makeMsg('assistant', 'Turn 1 assistant'),
        makeMsg('user', 'Turn 2 user'),
        makeMsg('assistant', 'Turn 2 assistant'),
        makeMsg('user', 'Turn 3 user'),
        makeMsg('assistant', 'Turn 3 assistant'),
        makeMsg('user', 'Latest')
      ]

      const { compressed } = mgr.compress(messages)
      // 最近 4 条消息应保留
      expect(compressed.some(m => m.content === 'Latest')).toBe(true)
      expect(compressed.some(m => m.content === 'Turn 3 user')).toBe(true)
      expect(compressed.some(m => m.content === 'Turn 3 assistant')).toBe(true)
    })

    it('历史消息压缩为摘要', () => {
      const messages: ContextMessage[] = [
        makeMsg('system', 'System'),
        makeMsg('user', 'Old message 1'),
        makeMsg('assistant', 'Old reply 1'),
        makeMsg('user', 'Old message 2'),
        makeMsg('assistant', 'Old reply 2'),
        makeMsg('user', 'Recent'),
        makeMsg('assistant', 'Recent reply'),
        makeMsg('user', 'Latest')
      ]

      const { compressed, record } = mgr.compress(messages)
      // 应有历史摘要
      const historySummary = compressed.find(m => m.content.includes('历史摘要'))
      expect(historySummary).toBeDefined()
      expect(record.discardedSummaries.length).toBeGreaterThan(0)
    })

    it('保留证据引用消息', () => {
      const messages: ContextMessage[] = [
        makeMsg('system', 'System'),
        { role: 'assistant', content: 'Evidence data', source: 'evidence_ref' },
        makeMsg('user', 'Old 1'),
        makeMsg('assistant', 'Old 2'),
        makeMsg('user', 'Old 3'),
        makeMsg('assistant', 'Old 4'),
        makeMsg('user', 'Latest')
      ]

      const { compressed } = mgr.compress(messages)
      expect(compressed.some(m => m.content === 'Evidence data')).toBe(true)
    })
  })

  describe('压缩历史', () => {
    it('每次压缩记录历史', () => {
      const messages: ContextMessage[] = [
        makeMsg('system', 'System'),
        makeMsg('user', 'History'),
        makeMsg('assistant', 'Reply'),
        makeMsg('user', 'History 2'),
        makeMsg('assistant', 'Reply 2'),
        makeMsg('user', 'Latest')
      ]

      mgr.compress(messages, '第一次压缩')
      mgr.compress(messages, '第二次压缩')

      const history = mgr.getCompressionHistory()
      expect(history).toHaveLength(2)
      expect(history[0].reason).toBe('第一次压缩')
      expect(history[1].reason).toBe('第二次压缩')
    })

    it('getCompressionStats 返回正确统计', () => {
      const messages: ContextMessage[] = [
        makeMsg('system', 'System'),
        makeMsg('user', 'a'.repeat(200)),
        makeMsg('assistant', 'b'.repeat(200)),
        makeMsg('user', 'c'.repeat(200)),
        makeMsg('assistant', 'd'.repeat(200)),
        makeMsg('user', 'Latest')
      ]

      mgr.compress(messages)

      const stats = mgr.getCompressionStats()
      expect(stats.totalCompressions).toBe(1)
      expect(stats.totalCharsSaved).toBeGreaterThan(0)
      expect(stats.lastCompressionTime).toBeGreaterThan(0)
    })

    it('reset 清除压缩历史', () => {
      const messages = [makeMsg('user', 'test')]
      mgr.compress(messages)
      mgr.reset()

      expect(mgr.getCompressionHistory()).toHaveLength(0)
    })
  })
})
