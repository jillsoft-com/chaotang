/**
 * 长期目标追踪测试（三期 Phase B）
 *
 * 覆盖：setLongTermGoal、updateGoalProgress、停滞检测、目标达成、
 *       getGoalSummary、TaskTreeSnapshot 集成
 */

import { describe, it, expect } from 'vitest'
import { createTree, setLongTermGoal, updateGoalProgress, getGoalSummary } from '@/services/agent/task-tree'
import type { LongTermGoal } from '@/services/agent/task-tree'

// ============ 辅助 ============

function makeTree() {
  return createTree('debate-goal-1', '实现用户认证', '完成登录/注册/密码重置')
}

// ============ 测试用例 ============

describe('setLongTermGoal — 设定目标', () => {
  it('设定目标后 longTermGoal 存在', () => {
    const tree = makeTree()
    const result = setLongTermGoal(tree, '完成所有功能开发', ['登录完成', '注册完成', '密码重置完成'])
    expect(result.ok).toBe(true)
    expect(tree.longTermGoal).toBeDefined()
    expect(tree.longTermGoal!.statement).toBe('完成所有功能开发')
    expect(tree.longTermGoal!.successCriteria).toHaveLength(3)
  })

  it('初始进度为 0', () => {
    const tree = makeTree()
    setLongTermGoal(tree, '目标', ['标准1'])
    expect(tree.longTermGoal!.progressPercent).toBe(0)
    expect(tree.longTermGoal!.checkCount).toBe(0)
    expect(tree.longTermGoal!.stalled).toBe(false)
    expect(tree.longTermGoal!.stallCount).toBe(0)
  })

  it('createdAt 被设置', () => {
    const tree = makeTree()
    setLongTermGoal(tree, '目标', [])
    expect(tree.longTermGoal!.createdAt).toBeGreaterThan(0)
    expect(tree.longTermGoal!.achievedAt).toBeUndefined()
  })
})

describe('updateGoalProgress — 更新进度', () => {
  it('更新进度值', () => {
    const tree = makeTree()
    setLongTermGoal(tree, '目标', ['标准'])
    const result = updateGoalProgress(tree, 50)
    expect(result.ok).toBe(true)
    expect(tree.longTermGoal!.progressPercent).toBe(50)
    expect(tree.longTermGoal!.checkCount).toBe(1)
  })

  it('进度值限制在 0-100', () => {
    const tree = makeTree()
    setLongTermGoal(tree, '目标', [])
    updateGoalProgress(tree, 150)
    expect(tree.longTermGoal!.progressPercent).toBe(100)
    updateGoalProgress(tree, -10)
    expect(tree.longTermGoal!.progressPercent).toBe(0)
  })

  it('无目标时返回错误', () => {
    const tree = makeTree()
    const result = updateGoalProgress(tree, 50)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('未设定')
  })

  it('lastCheckAt 被更新', () => {
    const tree = makeTree()
    setLongTermGoal(tree, '目标', [])
    updateGoalProgress(tree, 30)
    expect(tree.longTermGoal!.lastCheckAt).toBeGreaterThan(0)
  })
})

describe('停滞检测 — 连续 3 次进度未变', () => {
  it('连续 3 次相同进度 → stalled = true', () => {
    const tree = makeTree()
    setLongTermGoal(tree, '目标', [])
    updateGoalProgress(tree, 30) // 首次设置，stallCount = 0
    expect(tree.longTermGoal!.stalled).toBe(false)
    updateGoalProgress(tree, 30) // stallCount = 1
    expect(tree.longTermGoal!.stalled).toBe(false)
    updateGoalProgress(tree, 30) // stallCount = 2
    expect(tree.longTermGoal!.stalled).toBe(false)
    updateGoalProgress(tree, 30) // stallCount = 3 → stalled
    expect(tree.longTermGoal!.stalled).toBe(true)
    expect(tree.longTermGoal!.stallCount).toBe(3)
  })

  it('进度变化后停滞重置', () => {
    const tree = makeTree()
    setLongTermGoal(tree, '目标', [])
    updateGoalProgress(tree, 30) // 首次
    updateGoalProgress(tree, 30) // stallCount = 1
    updateGoalProgress(tree, 30) // stallCount = 2
    updateGoalProgress(tree, 30) // stallCount = 3 → stalled
    expect(tree.longTermGoal!.stalled).toBe(true)

    updateGoalProgress(tree, 50) // 进度变化
    expect(tree.longTermGoal!.stalled).toBe(false)
    expect(tree.longTermGoal!.stallCount).toBe(0)
  })

  it('stallCount 正确累计', () => {
    const tree = makeTree()
    setLongTermGoal(tree, '目标', [])
    updateGoalProgress(tree, 10) // 首次，stallCount = 0
    updateGoalProgress(tree, 10) // stallCount = 1
    expect(tree.longTermGoal!.stallCount).toBe(1)
    updateGoalProgress(tree, 20) // reset
    expect(tree.longTermGoal!.stallCount).toBe(0)
    updateGoalProgress(tree, 20) // stallCount = 1
    expect(tree.longTermGoal!.stallCount).toBe(1)
  })
})

describe('目标达成 — 100% 时设置 achievedAt', () => {
  it('进度达到 100% → achievedAt 被设置', () => {
    const tree = makeTree()
    setLongTermGoal(tree, '目标', [])
    updateGoalProgress(tree, 100)
    expect(tree.longTermGoal!.achievedAt).toBeGreaterThan(0)
    expect(tree.longTermGoal!.stalled).toBe(false)
    expect(tree.longTermGoal!.stallCount).toBe(0)
  })

  it('超过 100 也触发达成', () => {
    const tree = makeTree()
    setLongTermGoal(tree, '目标', [])
    updateGoalProgress(tree, 200) // 被 clamp 到 100
    expect(tree.longTermGoal!.achievedAt).toBeDefined()
  })

  it('achievedAt 只设置一次', () => {
    const tree = makeTree()
    setLongTermGoal(tree, '目标', [])
    updateGoalProgress(tree, 100)
    const firstAchievedAt = tree.longTermGoal!.achievedAt
    updateGoalProgress(tree, 50) // 回退不影响
    expect(tree.longTermGoal!.achievedAt).toBe(firstAchievedAt)
  })
})

describe('getGoalSummary — 目标摘要', () => {
  it('无目标时返回空字符串', () => {
    const tree = makeTree()
    expect(getGoalSummary(tree)).toBe('')
  })

  it('包含目标陈述和成功标准', () => {
    const tree = makeTree()
    setLongTermGoal(tree, '完成认证系统', ['登录', '注册'])
    const summary = getGoalSummary(tree)
    expect(summary).toContain('完成认证系统')
    expect(summary).toContain('登录')
    expect(summary).toContain('注册')
    expect(summary).toContain('0%')
  })

  it('停滞时包含警告标记', () => {
    const tree = makeTree()
    setLongTermGoal(tree, '目标', [])
    updateGoalProgress(tree, 30)
    updateGoalProgress(tree, 30)
    updateGoalProgress(tree, 30)
    updateGoalProgress(tree, 30) // stallCount = 3 → stalled
    const summary = getGoalSummary(tree)
    expect(summary).toContain('⚠️ 目标停滞')
  })

  it('达成时包含达成标记', () => {
    const tree = makeTree()
    setLongTermGoal(tree, '目标', [])
    updateGoalProgress(tree, 100)
    const summary = getGoalSummary(tree)
    expect(summary).toContain('✅ 已达成')
  })
})

describe('LongTermGoal 类型集成', () => {
  it('TaskTreeSnapshot 包含 longTermGoal 字段', () => {
    const tree = makeTree()
    setLongTermGoal(tree, '测试目标', ['标准1', '标准2'])
    const goal: LongTermGoal = tree.longTermGoal!
    expect(goal.statement).toBe('测试目标')
    expect(goal.successCriteria).toEqual(['标准1', '标准2'])
    expect(typeof goal.progressPercent).toBe('number')
    expect(typeof goal.checkCount).toBe('number')
    expect(typeof goal.stalled).toBe('boolean')
    expect(typeof goal.stallCount).toBe('number')
    expect(typeof goal.createdAt).toBe('number')
  })
})
