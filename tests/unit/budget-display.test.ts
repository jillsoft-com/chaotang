/**
 * 预算展示测试
 *
 * 覆盖：
 * - 预算追踪器基本功能
 * - 告警阈值与去重
 * - 预算增加
 * - 格式化辅助函数
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  BudgetTracker,
  formatBudgetDuration,
  formatBudgetPct
} from '@/services/agent/budget-display'
import type { BudgetSnapshot } from '@/services/agent/budget-display'

function makeSnapshot(overrides: Partial<BudgetSnapshot> = {}): BudgetSnapshot {
  return {
    nodeId: 'node-1',
    nodeUsage: { iterations: 1, toolCalls: 5, elapsedMs: 1000 },
    treeUsage: { iterations: 3, toolCalls: 50, elapsedMs: 5000 },
    remaining: { toolCalls: 150, iterations: 9 },
    timestamp: Date.now(),
    ...overrides
  }
}

describe('BudgetTracker', () => {
  let tracker: BudgetTracker

  beforeEach(() => {
    tracker = new BudgetTracker(200, 10)
  })

  describe('基本追踪', () => {
    it('处理 budget-update 事件', () => {
      const snapshot = makeSnapshot()
      tracker.processBudgetUpdate(snapshot)

      const state = tracker.getState()
      expect(state.treeUsage.toolCalls).toBe(50)
      expect(state.remaining.toolCalls).toBe(150)
      expect(state.nodeSnapshots.has('node-1')).toBe(true)
    })

    it('更新已有节点快照', () => {
      tracker.processBudgetUpdate(makeSnapshot())
      tracker.processBudgetUpdate(makeSnapshot({
        nodeUsage: { iterations: 3, toolCalls: 15, elapsedMs: 3000 }
      }))

      const nodeSummary = tracker.getNodeSummary('node-1')
      expect(nodeSummary?.nodeUsage.toolCalls).toBe(15)
    })

    it('追踪多个节点', () => {
      tracker.processBudgetUpdate(makeSnapshot({ nodeId: 'node-1' }))
      tracker.processBudgetUpdate(makeSnapshot({ nodeId: 'node-2' }))

      expect(tracker.getState().nodeSnapshots.size).toBe(2)
    })
  })

  describe('树级摘要', () => {
    it('getTreeSummary 返回正确数据', () => {
      tracker.processBudgetUpdate(makeSnapshot({
        treeUsage: { iterations: 5, toolCalls: 80, elapsedMs: 10000 }
      }))

      const summary = tracker.getTreeSummary()
      expect(summary.toolCalls).toBe(80)
      expect(summary.toolCallsMax).toBe(200)
      expect(summary.toolCallsPct).toBe(0.4)
      expect(summary.elapsedMs).toBe(10000)
    })
  })

  describe('告警阈值', () => {
    it('树级工具调用超过 80% 触发告警', () => {
      const warning = tracker.processBudgetUpdate(makeSnapshot({
        treeUsage: { iterations: 5, toolCalls: 170, elapsedMs: 10000 },
        remaining: { toolCalls: 30, iterations: 5 }
      }))

      expect(warning).not.toBeNull()
      expect(warning!.type).toBe('tree_budget_high')
      expect(warning!.message).toContain('85%')
    })

    it('树级工具调用耗尽触发告警', () => {
      const warning = tracker.processBudgetUpdate(makeSnapshot({
        treeUsage: { iterations: 5, toolCalls: 200, elapsedMs: 10000 },
        remaining: { toolCalls: 0, iterations: 5 }
      }))

      expect(warning).not.toBeNull()
      expect(warning!.type).toBe('tree_tool_calls_exhausted')
    })

    it('节点迭代超过 80% 触发告警', () => {
      const warning = tracker.processBudgetUpdate(makeSnapshot({
        nodeUsage: { iterations: 9, toolCalls: 5, elapsedMs: 1000 },
        remaining: { toolCalls: 150, iterations: 1 }
      }))

      expect(warning).not.toBeNull()
      expect(warning!.type).toBe('node_iterations_high')
    })

    it('低于阈值不触发告警', () => {
      const warning = tracker.processBudgetUpdate(makeSnapshot({
        treeUsage: { iterations: 1, toolCalls: 50, elapsedMs: 1000 },
        remaining: { toolCalls: 150, iterations: 9 }
      }))

      expect(warning).toBeNull()
      expect(tracker.getState().hasWarning).toBe(false)
    })
  })

  describe('告警去重', () => {
    it('同一类型告警 30 秒内不重复', () => {
      tracker.processBudgetUpdate(makeSnapshot({
        treeUsage: { iterations: 5, toolCalls: 170, elapsedMs: 10000 },
        remaining: { toolCalls: 30, iterations: 5 }
      }))

      // 第二次不触发告警（30秒内）
      const warning2 = tracker.processBudgetUpdate(makeSnapshot({
        treeUsage: { iterations: 5, toolCalls: 175, elapsedMs: 10500 },
        remaining: { toolCalls: 25, iterations: 5 }
      }))

      expect(warning2).toBeNull()
    })

    it('30 秒后同类型告警可再次触发', () => {
      vi.useFakeTimers()
      try {
        tracker.processBudgetUpdate(makeSnapshot({
          treeUsage: { iterations: 5, toolCalls: 170, elapsedMs: 10000 },
          remaining: { toolCalls: 30, iterations: 5 },
          timestamp: Date.now()
        }))

        vi.advanceTimersByTime(31000)

        const warning2 = tracker.processBudgetUpdate(makeSnapshot({
          treeUsage: { iterations: 5, toolCalls: 175, elapsedMs: 41000 },
          remaining: { toolCalls: 25, iterations: 5 },
          timestamp: Date.now()
        }))

        expect(warning2).not.toBeNull()
        expect(warning2!.type).toBe('tree_budget_high')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('告警监听', () => {
    it('onWarning 注册并收到告警', () => {
      const listener = vi.fn()
      tracker.onWarning(listener)

      tracker.processBudgetUpdate(makeSnapshot({
        treeUsage: { iterations: 5, toolCalls: 170, elapsedMs: 10000 },
        remaining: { toolCalls: 30, iterations: 5 }
      }))

      expect(listener).toHaveBeenCalledOnce()
      expect(listener.mock.calls[0][0].type).toBe('tree_budget_high')
    })

    it('取消监听后不再收到告警', () => {
      const listener = vi.fn()
      const unsub = tracker.onWarning(listener)
      unsub()

      tracker.processBudgetUpdate(makeSnapshot({
        treeUsage: { iterations: 5, toolCalls: 170, elapsedMs: 10000 },
        remaining: { toolCalls: 30, iterations: 5 }
      }))

      expect(listener).not.toHaveBeenCalled()
    })
  })

  describe('预算增加', () => {
    it('increaseMaxToolCalls 增加上限', () => {
      tracker.processBudgetUpdate(makeSnapshot({
        treeUsage: { iterations: 5, toolCalls: 200, elapsedMs: 10000 },
        remaining: { toolCalls: 0, iterations: 5 }
      }))

      tracker.increaseMaxToolCalls(100, '用户申请加额')

      const summary = tracker.getTreeSummary()
      expect(summary.toolCallsMax).toBe(300)
      expect(tracker.getState().hasWarning).toBe(false)
    })

    it('increaseMaxToolCalls 记录原因', () => {
      tracker.increaseMaxToolCalls(50, '需要额外验证')

      const warnings = tracker.getWarnings()
      expect(warnings.length).toBeGreaterThan(0)
      expect(warnings[warnings.length - 1].message).toContain('需要额外验证')
    })
  })

  describe('重置', () => {
    it('reset 清除所有状态', () => {
      tracker.processBudgetUpdate(makeSnapshot())
      tracker.reset()

      const state = tracker.getState()
      expect(state.nodeSnapshots.size).toBe(0)
      expect(state.treeUsage.toolCalls).toBe(0)
      expect(state.warnings).toHaveLength(0)
    })
  })
})

describe('formatBudgetDuration', () => {
  it('毫秒', () => {
    expect(formatBudgetDuration(500)).toBe('500ms')
  })

  it('秒', () => {
    expect(formatBudgetDuration(5000)).toBe('5s')
  })

  it('分钟', () => {
    expect(formatBudgetDuration(125000)).toBe('2m5s')
  })
})

describe('formatBudgetPct', () => {
  it('百分比', () => {
    expect(formatBudgetPct(0.85)).toBe('85%')
    expect(formatBudgetPct(0.5)).toBe('50%')
    expect(formatBudgetPct(1)).toBe('100%')
  })
})
