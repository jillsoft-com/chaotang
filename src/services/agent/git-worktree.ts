/**
 * Git Worktree 隔离 — 三期 Phase G
 *
 * 为每个任务创建独立的 git worktree，实现并行任务的文件隔离
 */

// ============ 类型 ============

export interface WorktreeInfo {
  id: string
  path: string
  branch: string
  head: string
  isBare: boolean
}

export interface CreateWorktreeResult {
  success: boolean
  worktreePath?: string
  branch?: string
  error?: string
}

export interface RemoveWorktreeResult {
  success: boolean
  error?: string
}

// ============ Worktree 管理 ============

const activeWorktrees = new Map<string, { path: string; branch: string; taskId: string }>()

/**
 * 创建新的 worktree
 * 通过 execute_command 工具调用 git worktree add
 */
export async function createWorktree(
  taskId: string,
  _baseBranch: string = 'main',
  newBranch?: string
): Promise<CreateWorktreeResult> {
  const branch = newBranch || `task-${taskId}-${Date.now()}`
  const worktreePath = `.worktrees/${taskId}`

  try {
    // 检查 git 是否可用
    if (!window.electronAPI?.executeCommand) {
      return { success: false, error: '需要 Electron 环境' }
    }

    // 创建 worktree
    const result = await window.electronAPI.executeCommand({
      command: `git worktree add ${worktreePath} -b ${branch}`,
      timeout: 30000
    })

    if (!result.success) {
      return { success: false, error: result.stderr || '创建 worktree 失败' }
    }

    // 记录活跃的 worktree
    activeWorktrees.set(taskId, {
      path: worktreePath,
      branch,
      taskId
    })

    return {
      success: true,
      worktreePath,
      branch
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '创建 worktree 失败'
    }
  }
}

/**
 * 移除 worktree
 */
export async function removeWorktree(taskId: string): Promise<RemoveWorktreeResult> {
  const worktree = activeWorktrees.get(taskId)
  if (!worktree) {
    return { success: false, error: `未找到任务 ${taskId} 的 worktree` }
  }

  try {
    if (!window.electronAPI?.executeCommand) {
      return { success: false, error: '需要 Electron 环境' }
    }

    // 移除 worktree
    const result = await window.electronAPI.executeCommand({
      command: `git worktree remove ${worktree.path}`,
      timeout: 30000
    })

    if (!result.success) {
      // 强制移除
      const forceResult = await window.electronAPI.executeCommand({
        command: `git worktree remove --force ${worktree.path}`,
        timeout: 30000
      })

      if (!forceResult.success) {
        return { success: false, error: forceResult.stderr || '移除 worktree 失败' }
      }
    }

    // 清理记录
    activeWorktrees.delete(taskId)

    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '移除 worktree 失败'
    }
  }
}

/**
 * 列出所有 worktree
 */
export async function listWorktrees(): Promise<WorktreeInfo[]> {
  try {
    if (!window.electronAPI?.executeCommand) {
      return []
    }

    const result = await window.electronAPI.executeCommand({
      command: 'git worktree list --porcelain',
      timeout: 10000
    })

    if (!result.success) {
      return []
    }

    // 解析 porcelain 格式
    const worktrees: WorktreeInfo[] = []
    const lines = result.stdout.split('\n')
    let current: Partial<WorktreeInfo> = {}

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        if (current.path) {
          worktrees.push(current as WorktreeInfo)
        }
        current = { path: line.slice(9) }
      } else if (line.startsWith('HEAD ')) {
        current.head = line.slice(5)
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7)
      } else if (line === 'bare') {
        current.isBare = true
      } else if (line === 'detached') {
        // detached HEAD
      }
    }

    if (current.path) {
      worktrees.push(current as WorktreeInfo)
    }

    return worktrees
  } catch {
    return []
  }
}

/**
 * 获取任务的 worktree 路径
 */
export function getWorktreePath(taskId: string): string | undefined {
  return activeWorktrees.get(taskId)?.path
}

/**
 * 检查任务是否有活跃的 worktree
 */
export function hasActiveWorktree(taskId: string): boolean {
  return activeWorktrees.has(taskId)
}

/**
 * 清理所有 worktree（用于测试或重置）
 */
export async function cleanupAllWorktrees(): Promise<number> {
  const taskIds = Array.from(activeWorktrees.keys())
  let removed = 0

  for (const taskId of taskIds) {
    const result = await removeWorktree(taskId)
    if (result.success) removed++
  }

  return removed
}

/**
 * 在 worktree 中执行命令
 */
export async function executeInWorktree(
  taskId: string,
  command: string,
  timeout: number = 30000
): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }> {
  const worktree = activeWorktrees.get(taskId)
  if (!worktree) {
    return {
      success: false,
      stdout: '',
      stderr: `未找到任务 ${taskId} 的 worktree`,
      exitCode: 1
    }
  }

  if (!window.electronAPI?.executeCommand) {
    return {
      success: false,
      stdout: '',
      stderr: '需要 Electron 环境',
      exitCode: 1
    }
  }

  return window.electronAPI.executeCommand({
    command,
    cwd: worktree.path,
    timeout
  })
}
