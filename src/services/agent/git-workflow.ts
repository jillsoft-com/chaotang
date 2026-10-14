/**
 * Git 工作流 — 高层 Git 操作封装
 *
 * 在基础 git_operation 工具（status/diff/log/branch）之上，
 * 提供自动提交、创建分支、push + PR 命令生成、diff 摘要等高层工作流。
 *
 * 设计依据：编码能力二期升级 Phase 3。
 */

import type { CommandExecutor } from './acceptance-gate'

// ============ 类型 ============

/** autoCommit 结果 */
export interface AutoCommitResult {
  success: boolean
  commitHash?: string
  filesChanged: number
  message: string
  command: string
}

/** createBranch 结果 */
export interface CreateBranchResult {
  success: boolean
  branchName: string
  previousBranch?: string
  message: string
}

/** pushAndCreatePR 结果 */
export interface PushPRResult {
  success: boolean
  pushOutput?: string
  prCommand: string
  message: string
}

/** diffSummary 结果 */
export interface DiffSummary {
  filesChanged: number
  insertions: number
  deletions: number
  fileDetails: Array<{
    path: string
    status: 'added' | 'modified' | 'deleted' | 'renamed'
    insertions: number
    deletions: number
  }>
  commitLog?: string[]
  rawDiff: string
}

// ============ 辅助函数 ============

/**
 * 执行 git 命令并返回输出
 */
async function runGit(
  gitArgs: string,
  workingDir: string,
  executor: CommandExecutor,
  timeoutMs = 30000
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await executor.execute(`git ${gitArgs}`, workingDir, timeoutMs)
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
}

/**
 * 获取当前分支名
 */
async function getCurrentBranch(workingDir: string, executor: CommandExecutor): Promise<string | null> {
  const result = await runGit('rev-parse --abbrev-ref HEAD', workingDir, executor, 5000)
  if (result.exitCode === 0) return result.stdout.trim()
  return null
}

// ============ 参数校验 ============

/** 分支名校验：只允许合法 Git 分支名，拒绝 shell 注入 */
const BRANCH_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\/\-]*$/

function validateBranchName(name: string): string | null {
  if (!name || name.length > 100) return '分支名不能为空且长度不超过 100'
  if (name.includes('..') || name.includes('--')) return '分支名不允许包含 .. 或 --'
  if (name.endsWith('.lock') || name.endsWith('/')) return '分支名不允许以 .lock 或 / 结尾'
  if (!BRANCH_NAME_RE.test(name)) return '分支名包含非法字符'
  if (name.includes('//') || name.startsWith('/')) return '分支名格式不合法'
  return null
}

/** 转义 shell 参数（防止注入，仅用于路径等已校验的简单字符串） */
function shellEscape(s: string): string {
  // P0-fix: 用双引号包裹并转义所有 shell 特殊字符
  // 兼容 Bash（\$、\`、\\）和 PowerShell（`$、``、`"）
  // 由于路径已通过严格校验（只含安全字符），这里主要防御编程错误
  return `"${s.replace(/"/g, '\\"')}"`
}

/** P0-fix: 严格文件路径校验 — 只允许安全字符，拒绝所有 shell 元字符 */
const SAFE_PATH_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\/\\\-]*$/

function validateFilePath(path: string): string | null {
  if (!path || path.length > 500) return '文件路径不能为空且长度不超过 500'
  if (path.includes('..')) return '文件路径不允许包含 ..'
  if (path.startsWith('/') || path.startsWith('\\')) return '文件路径不能以绝对路径开头'
  if (!SAFE_PATH_RE.test(path)) return '文件路径包含非法字符，只允许字母、数字、点、横线、斜杠和下划线'
  return null
}

// ============ 高层工作流 ============

/**
 * 自动提交 — git add + commit
 *
 * @param workingDir 工作目录
 * @param executor 命令执行器
 * @param message 提交信息（可选，默认自动生成）
 * @param files 指定文件范围（可选，不指定则 add 所有变更）
 */
export async function autoCommit(
  workingDir: string,
  executor: CommandExecutor,
  message?: string,
  files?: string[]
): Promise<AutoCommitResult> {
  // P0-fix: 不指定 files 时拒绝 git add -A，防止夹带工作区原有改动
  if (!files || files.length === 0) {
    return {
      success: false,
      filesChanged: 0,
      message: 'autoCommit 必须明确指定 files 参数，防止 git add -A 夹带工作区原有改动。请使用 git commit 手动处理全量提交。',
      command: ''
    }
  }

  // 1. P0-fix: 严格校验每个文件路径，拒绝所有 shell 元字符
  for (const f of files) {
    const validationError = validateFilePath(f)
    if (validationError) {
      return {
        success: false,
        filesChanged: 0,
        message: `文件路径不合法: ${f} — ${validationError}`,
        command: ''
      }
    }
  }

  // 2. 检查是否有变更
  const statusResult = await runGit('status --porcelain', workingDir, executor, 5000)
  if (statusResult.exitCode !== 0) {
    return {
      success: false,
      filesChanged: 0,
      message: `git status 失败: ${statusResult.stderr}`,
      command: 'git status --porcelain'
    }
  }

  const statusLines = statusResult.stdout.trim()
  if (!statusLines) {
    return {
      success: true,
      filesChanged: 0,
      message: '无变更，无需提交',
      command: 'git status --porcelain'
    }
  }

  // 3. P0-fix: 检查暂存区是否已有预存文件
  const preStagedResult = await runGit('diff --cached --name-only', workingDir, executor, 5000)
  // P1-fix: 检查命令失败时视为错误，不假设暂存区为空
  if (preStagedResult.exitCode !== 0) {
    return {
      success: false,
      filesChanged: 0,
      message: `git diff --cached 失败: ${preStagedResult.stderr}`,
      command: 'git diff --cached --name-only'
    }
  }
  const preStagedFiles = preStagedResult.stdout.trim().split('\n').filter(l => l.trim())

  // P0-fix: 若暂存区已有文件，拒绝执行以避免破坏用户的部分暂存状态
  if (preStagedFiles.length > 0) {
    return {
      success: false,
      filesChanged: 0,
      message: `暂存区已有 ${preStagedFiles.length} 个预存文件，autoCommit 无法安全隔离。请先手动 git commit 或 git reset 清空暂存区。`,
      command: ''
    }
  }

  // 4. 仅 add 指定的文件（无需 reset，因为暂存区已确认空）
  const escapedFiles = files.map(f => shellEscape(f)).join(' ')
  const addCommand = `git add ${escapedFiles}`
  const addResult = await runGit('add ' + escapedFiles, workingDir, executor, 10000)

  if (addResult.exitCode !== 0) {
    // P1-fix: git add 部分失败也可能已暂存了部分文件，需要清理
    const cleanResult = await runGit('reset HEAD', workingDir, executor, 5000)
    return {
      success: false,
      filesChanged: 0,
      message: `git add 失败${cleanResult.exitCode === 0 ? '（已清理暂存区）' : ''}: ${addResult.stderr}`,
      command: addCommand
    }
  }

  // 6. 统计本次 add 的文件数
  const stagedAfter = await runGit('diff --cached --name-only', workingDir, executor, 5000)
  const changedFiles = stagedAfter.exitCode === 0
    ? stagedAfter.stdout.trim().split('\n').filter(l => l.trim()).length
    : files.length

  // 7. P0-fix: 使用临时文件传入 commit message，避免 shell 转义问题
  const commitMsg = message || generateCommitMessage(statusLines)
  const commitMsgFile = '.git/COMMIT_MSG_TMP'

  if (executor.writeFile) {
    // 优先使用 writeFile API 安全写入
    const writeResult = await executor.writeFile(
      `${workingDir}/${commitMsgFile}`,
      commitMsg
    )
    if (!writeResult.success) {
      // P1-fix: 写入失败也要清理暂存区，避免已 add 的文件留在暂存区
      const cleanResult = await runGit('reset HEAD', workingDir, executor, 5000)
      return {
        success: false,
        filesChanged: changedFiles,
        message: `无法写入 commit message 临时文件${cleanResult.exitCode === 0 ? '（已清理暂存区）' : '（暂存区清理失败，请手动 git reset）'}`,
        command: ''
      }
    }
  } else {
    // 回退：通过命令写入（仅适用于 ASCII 安全的消息）
    const safeMsg = commitMsg.replace(/"/g, '\\"').replace(/\n/g, ' ')
    const writeCmd = `echo "${safeMsg}" > ${commitMsgFile}`
    await executor.execute(writeCmd, workingDir, 3000)
  }

  const commitCmd = `git commit -F ${commitMsgFile}`
  const commitResult = await runGit(`commit -F ${commitMsgFile}`, workingDir, executor, 15000)

  // 清理临时文件
  await executor.execute(
    process.platform === 'win32'
      ? `if (Test-Path "${commitMsgFile}") { Remove-Item "${commitMsgFile}" }`
      : `rm -f "${commitMsgFile}"`,
    workingDir, 3000
  ).catch(() => {})

  if (commitResult.exitCode !== 0) {
    // P1-fix: commit 失败后清理暂存区，避免留下已暂存文件
    const cleanResult = await runGit('reset HEAD', workingDir, executor, 5000)
    return {
      success: false,
      filesChanged: changedFiles,
      message: `git commit 失败${cleanResult.exitCode === 0 ? '（已清理暂存区）' : '（暂存区清理失败，请手动 git reset）'}: ${commitResult.stderr}`,
      command: commitCmd
    }
  }

  // 8. 获取 commit hash
  const hashResult = await runGit('rev-parse --short HEAD', workingDir, executor, 5000)
  const commitHash = hashResult.exitCode === 0 ? hashResult.stdout.trim() : undefined

  return {
    success: true,
    commitHash,
    filesChanged: changedFiles,
    message: commitMsg,
    command: commitCmd
  }
}

/**
 * 创建并切换到新分支
 */
export async function createBranch(
  workingDir: string,
  executor: CommandExecutor,
  branchName: string
): Promise<CreateBranchResult> {
  // P0-fix: 分支名校验
  const validationError = validateBranchName(branchName)
  if (validationError) {
    return {
      success: false,
      branchName,
      message: `分支名校验失败: ${validationError}`
    }
  }

  // 获取当前分支
  const previousBranch = await getCurrentBranch(workingDir, executor)

  // 创建并切换（分支名已通过正则校验，可安全拼接）
  const result = await runGit(`checkout -b ${branchName}`, workingDir, executor, 10000)
  if (result.exitCode !== 0) {
    // 如果分支已存在，尝试直接切换
    if (result.stderr.includes('already exists')) {
      const switchResult = await runGit(`checkout ${branchName}`, workingDir, executor, 10000)
      if (switchResult.exitCode === 0) {
        return {
          success: true,
          branchName,
          previousBranch: previousBranch || undefined,
          message: `已切换到已有分支: ${branchName}`
        }
      }
      return {
        success: false,
        branchName,
        message: `切换分支失败: ${switchResult.stderr}`
      }
    }
    return {
      success: false,
      branchName,
      message: `创建分支失败: ${result.stderr}`
    }
  }

  return {
    success: true,
    branchName,
    previousBranch: previousBranch || undefined,
    message: `已创建并切换到新分支: ${branchName}`
  }
}

/**
 * Push 当前分支并生成 PR 创建命令
 *
 * 由于 PR 创建需要 GitHub token，这里生成 `gh pr create` 命令让用户确认执行。
 */
export async function pushAndCreatePR(
  workingDir: string,
  executor: CommandExecutor,
  title: string,
  body?: string
): Promise<PushPRResult> {
  // 1. 获取当前分支名
  const currentBranch = await getCurrentBranch(workingDir, executor)
  if (!currentBranch) {
    return {
      success: false,
      prCommand: '',
      message: '无法获取当前分支名'
    }
  }

  // 2. Push
  const pushResult = await runGit(`push -u origin ${currentBranch}`, workingDir, executor, 60000)
  if (pushResult.exitCode !== 0) {
    return {
      success: false,
      pushOutput: pushResult.stderr,
      prCommand: '',
      message: `git push 失败: ${pushResult.stderr}`
    }
  }

  // 3. 生成 gh pr create 命令
  const escapedTitle = title.replace(/"/g, '\\"')
  const escapedBody = (body || '').replace(/"/g, '\\"')
  const prCommand = `gh pr create --title "${escapedTitle}" --body "${escapedBody}" --base main`

  return {
    success: true,
    pushOutput: pushResult.stdout,
    prCommand,
    message: `已 push 到 origin/${currentBranch}。请确认执行以下命令创建 PR:\n${prCommand}`
  }
}

/**
 * 获取 diff 摘要（供交付报告使用）
 */
export async function getDiffSummary(
  workingDir: string,
  executor: CommandExecutor,
  base?: string
): Promise<DiffSummary> {
  const baseRef = base || 'HEAD'

  // 获取 numstat（精确的增删行数）
  const numstatResult = await runGit(
    `diff --numstat ${baseRef}`,
    workingDir, executor, 10000
  )

  // 获取原始 diff
  const diffResult = await runGit(
    `diff ${baseRef}`,
    workingDir, executor, 30000
  )

  // 获取最近的 commit 日志
  const logResult = await runGit(
    'log --oneline -10',
    workingDir, executor, 5000
  )

  // 解析 numstat
  const fileDetails: DiffSummary['fileDetails'] = []
  let totalInsertions = 0
  let totalDeletions = 0

  if (numstatResult.exitCode === 0) {
    const lines = numstatResult.stdout.trim().split('\n').filter(l => l.trim())
    for (const line of lines) {
      const parts = line.split('\t')
      if (parts.length >= 3) {
        const ins = parts[0] === '-' ? 0 : parseInt(parts[0], 10)
        const del = parts[1] === '-' ? 0 : parseInt(parts[1], 10)
        const path = parts[2]

        // 判断文件状态
        let status: DiffSummary['fileDetails'][0]['status'] = 'modified'
        if (ins > 0 && del === 0) status = 'added'
        else if (ins === 0 && del > 0) status = 'deleted'
        else if (path.includes('=>')) status = 'renamed'

        fileDetails.push({ path, status, insertions: ins, deletions: del })
        totalInsertions += ins
        totalDeletions += del
      }
    }
  }

  // 解析 commit log
  const commitLog = logResult.exitCode === 0
    ? logResult.stdout.trim().split('\n').filter(l => l.trim())
    : undefined

  return {
    filesChanged: fileDetails.length,
    insertions: totalInsertions,
    deletions: totalDeletions,
    fileDetails,
    commitLog,
    rawDiff: diffResult.exitCode === 0 ? diffResult.stdout : ''
  }
}

// ============ 内部辅助 ============

/**
 * 根据 git status 输出自动生成 commit message
 */
function generateCommitMessage(statusOutput: string): string {
  const lines = statusOutput.split('\n').filter(l => l.trim())
  const added: string[] = []
  const modified: string[] = []
  const deleted: string[] = []

  for (const line of lines) {
    const code = line.slice(0, 2)
    const file = line.slice(3).trim()
    if (code.includes('A') || code === '??') added.push(file)
    else if (code.includes('D')) deleted.push(file)
    else modified.push(file)
  }

  const parts: string[] = []
  if (added.length > 0) parts.push(`新增 ${added.length} 个文件`)
  if (modified.length > 0) parts.push(`修改 ${modified.length} 个文件`)
  if (deleted.length > 0) parts.push(`删除 ${deleted.length} 个文件`)

  return parts.join('，') || 'auto commit'
}
