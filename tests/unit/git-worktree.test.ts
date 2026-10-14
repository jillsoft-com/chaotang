/**
 * Git Worktree 隔离测试（三期 Phase G）
 *
 * 覆盖：worktree 管理函数
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createWorktree,
  removeWorktree,
  listWorktrees,
  getWorktreePath,
  hasActiveWorktree,
  cleanupAllWorktrees
} from '@/services/agent/git-worktree'

// ============ Mock ============

const mockExecuteCommand = vi.fn()

beforeEach(() => {
  vi.stubGlobal('window', {
    electronAPI: {
      executeCommand: mockExecuteCommand
    }
  })
})

afterEach(async () => {
  // 清理所有 worktree 避免测试间干扰
  await cleanupAllWorktrees()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

// ============ 测试用例 ============

describe('createWorktree', () => {
  it('创建 worktree 成功', async () => {
    mockExecuteCommand.mockResolvedValue({
      success: true,
      stdout: '',
      stderr: '',
      exitCode: 0
    })

    const result = await createWorktree('task-1', 'main', 'feature-1')
    expect(result.success).toBe(true)
    expect(result.branch).toBe('feature-1')
    expect(result.worktreePath).toContain('task-1')
  })

  it('自动生成分支名', async () => {
    mockExecuteCommand.mockResolvedValue({
      success: true,
      stdout: '',
      stderr: '',
      exitCode: 0
    })

    const result = await createWorktree('task-2')
    expect(result.success).toBe(true)
    expect(result.branch).toContain('task-2')
  })

  it('创建失败返回错误', async () => {
    mockExecuteCommand.mockResolvedValue({
      success: false,
      stdout: '',
      stderr: 'fatal: invalid reference',
      exitCode: 128
    })

    const result = await createWorktree('task-3')
    expect(result.success).toBe(false)
    expect(result.error).toContain('invalid reference')
  })

  it('无 Electron 环境返回错误', async () => {
    vi.stubGlobal('window', {})

    const result = await createWorktree('task-4')
    expect(result.success).toBe(false)
    expect(result.error).toContain('Electron')
  })
})

describe('removeWorktree', () => {
  it('移除 worktree 成功', async () => {
    // 先创建
    mockExecuteCommand.mockResolvedValue({
      success: true,
      stdout: '',
      stderr: '',
      exitCode: 0
    })
    await createWorktree('task-5')

    // 再移除
    const result = await removeWorktree('task-5')
    expect(result.success).toBe(true)
  })

  it('移除不存在的 worktree 返回错误', async () => {
    const result = await removeWorktree('non-existent')
    expect(result.success).toBe(false)
    expect(result.error).toContain('未找到')
  })
})

describe('listWorktrees', () => {
  it('解析 worktree 列表', async () => {
    mockExecuteCommand.mockResolvedValue({
      success: true,
      stdout: `worktree /path/to/main
HEAD abc123
branch refs/heads/main

worktree /path/to/worktree1
HEAD def456
branch refs/heads/feature-1

`,
      stderr: '',
      exitCode: 0
    })

    const worktrees = await listWorktrees()
    expect(worktrees).toHaveLength(2)
    expect(worktrees[0].path).toBe('/path/to/main')
    expect(worktrees[0].branch).toBe('refs/heads/main')
    expect(worktrees[1].path).toBe('/path/to/worktree1')
  })

  it('命令失败返回空数组', async () => {
    mockExecuteCommand.mockResolvedValue({
      success: false,
      stdout: '',
      stderr: 'error',
      exitCode: 1
    })

    const worktrees = await listWorktrees()
    expect(worktrees).toHaveLength(0)
  })
})

describe('getWorktreePath', () => {
  it('获取已创建的 worktree 路径', async () => {
    mockExecuteCommand.mockResolvedValue({
      success: true,
      stdout: '',
      stderr: '',
      exitCode: 0
    })
    await createWorktree('task-6')

    const path = getWorktreePath('task-6')
    expect(path).toBeDefined()
    expect(path).toContain('task-6')
  })

  it('未创建的 worktree 返回 undefined', () => {
    const path = getWorktreePath('non-existent')
    expect(path).toBeUndefined()
  })
})

describe('hasActiveWorktree', () => {
  it('检查活跃 worktree', async () => {
    mockExecuteCommand.mockResolvedValue({
      success: true,
      stdout: '',
      stderr: '',
      exitCode: 0
    })

    expect(hasActiveWorktree('task-7')).toBe(false)
    
    await createWorktree('task-7')
    expect(hasActiveWorktree('task-7')).toBe(true)
  })
})

describe('cleanupAllWorktrees', () => {
  it('清理所有 worktree', async () => {
    mockExecuteCommand.mockResolvedValue({
      success: true,
      stdout: '',
      stderr: '',
      exitCode: 0
    })

    await createWorktree('task-8')
    await createWorktree('task-9')

    const removed = await cleanupAllWorktrees()
    expect(removed).toBe(2)
    expect(hasActiveWorktree('task-8')).toBe(false)
    expect(hasActiveWorktree('task-9')).toBe(false)
  })
})
