/**
 * Lint 自动修复引擎 — 文件写入后自动运行 lint 并修复
 *
 * 流程：
 * 1. 检测工作目录的 lint 工具（ESLint/Pylint/Ruff 等）
 * 2. 运行 lint 检查（--fix 模式如果支持）
 * 3. 如果有不可自动修复的问题 → 将输出注入 LLM 让模型修复
 * 4. 重新 lint 验证
 * 5. 最多 2 轮
 *
 * 设计依据：编码能力二期升级 Phase 4。
 */

import type { ChatMessage, ToolCall, ToolCallResult, ToolDefinition } from '@/types'
import type { LLMProvider } from '@/services/llm/types'
import { toolExecutor } from '@/services/tools/executor'
import type { CommandExecutor } from './acceptance-gate'

// ============ 类型 ============

/** Lint 修复配置 */
export interface LintFixConfig {
  /** 最大修复轮次（默认 2） */
  maxRounds: number
  /** 工作目录 */
  workingDirectory: string
  /** 指定 lint 命令（可选，不指定则自动检测） */
  lintCommand?: string
  /** 指定修复命令（可选，不指定则自动检测） */
  fixCommand?: string
  /** 单轮 lint 超时（默认 60s） */
  lintTimeoutMs?: number
}

/** Lint 修复事件类型 */
export type LintFixEventType =
  | 'detecting'      // 检测 lint 工具中
  | 'lint-start'     // 开始 lint 检查
  | 'lint-result'    // lint 完成
  | 'fixing'         // LLM 修复中
  | 'lint-passed'    // 无问题
  | 'lint-failed'    // 达到最大轮次仍有问题
  | 'error'

export interface LintFixEvent {
  type: LintFixEventType
  data?: any
}

type LintFixEventCallback = (event: LintFixEvent) => void

/** Lint 修复结果 */
export interface LintFixResult {
  /** 是否最终无问题 */
  passed: boolean
  /** 初始问题数 */
  initialIssueCount: number
  /** 最终问题数 */
  finalIssueCount: number
  /** 总轮次 */
  totalRounds: number
  /** LLM 修复过程中的工具调用 */
  fixToolCalls: ToolCallResult[]
  /** 总耗时（毫秒） */
  duration: number
  /** 使用的 lint 命令 */
  lintCommand: string
  /** 使用的修复命令 */
  fixCommand: string
  /** 最终 lint 输出摘要 */
  finalOutput: string
  /** --fix 命令是否修改了文件（用于触发重测） */
  fixCommandModifiedFiles?: boolean
  /** P1-fix: 修复过程中写入的文件基线记录 */
  fileBaselines?: Record<string, { beforeSha256: string; afterSha256?: string; originalContent?: string }>
}

// ============ Lint 工具检测 ============

/**
 * P0-fix: 从字符串内容计算真实 SHA-256 哈希
 * 使用 Web Crypto API，与 electronAPI.readFile 返回的 SHA-256 格式一致
 */
async function computeSha256(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * 跨平台读取文件内容
 */
async function crossPlatformReadFile(
  filePath: string,
  workingDir: string,
  executor: CommandExecutor
): Promise<string | null> {
  const psResult = await executor.execute(
    `Get-Content -Raw -ErrorAction SilentlyContinue "${filePath}"`,
    workingDir, 5000
  )
  if (psResult.exitCode === 0 && psResult.stdout.trim()) {
    return psResult.stdout
  }
  const unixResult = await executor.execute(`cat "${filePath}"`, workingDir, 5000)
  if (unixResult.exitCode === 0 && unixResult.stdout.trim()) {
    return unixResult.stdout
  }
  return null
}

/**
 * 跨平台检测文件是否存在
 */
async function crossPlatformFileExists(
  filePath: string,
  workingDir: string,
  executor: CommandExecutor
): Promise<boolean> {
  const psResult = await executor.execute(
    `if (Test-Path "${filePath}") { echo __EXISTS__ }`,
    workingDir, 3000
  )
  if (psResult.stdout.includes('__EXISTS__')) return true
  const unixResult = await executor.execute(
    `test -f "${filePath}" && echo __EXISTS__`,
    workingDir, 3000
  )
  if (unixResult.stdout.includes('__EXISTS__')) return true
  return false
}

/**
 * P1-fix: 统一文件读取接口 — 优先使用 executor.readFile（与恢复校验同一读取路径）
 * 返回 { content, sha256 } 或 null（文件不存在/读取失败）
 */
async function readFileWithHash(
  filePath: string,
  workingDir: string,
  executor: CommandExecutor
): Promise<{ content: string; sha256: string } | null> {
  // 优先使用 executor.readFile（通过 electronAPI.readFile，与恢复校验同一读取路径）
  if (executor.readFile) {
    const fullPath = filePath.startsWith('/') || filePath.includes(':')
      ? filePath
      : `${workingDir}/${filePath}`
    const result = await executor.readFile(fullPath)
    if (result.success && result.content !== undefined && result.sha256) {
      return { content: result.content, sha256: result.sha256 }
    }
    return null
  }
  // 回退：crossPlatformReadFile + computeSha256（非 Electron 环境）
  const content = await crossPlatformReadFile(filePath, workingDir, executor)
  if (content === null) return null
  const sha = await computeSha256(content)
  return { content, sha256: sha }
}

/**
 * 检测工作目录的 lint 工具
 */
async function detectLintTools(
  workingDir: string,
  executor: CommandExecutor
): Promise<{ lintCommand: string | null; fixCommand: string | null }> {
  try {
    // 1. 检测 package.json 中的 ESLint（跨平台）
    const pkgContent = await crossPlatformReadFile('package.json', workingDir, executor)
    if (pkgContent) {
      try {
        const pkg = JSON.parse(pkgContent.trim())
        const deps = { ...pkg.dependencies, ...pkg.devDependencies }
        if (deps.eslint || deps['@typescript-eslint/parser']) {
          return {
            lintCommand: 'npx eslint . --format json 2>&1',
            fixCommand: 'npx eslint . --fix 2>&1'
          }
        }
      } catch { /* JSON 解析失败 */ }
    }

    // 2. 检测 ruff (Python)（跨平台）
    const hasRuffToml = await crossPlatformFileExists('ruff.toml', workingDir, executor)
    const hasPyProject = await crossPlatformFileExists('pyproject.toml', workingDir, executor)
    if (hasRuffToml || hasPyProject) {
      return {
        lintCommand: `ruff check ${workingDir} --output-format=text`,
        fixCommand: `ruff check ${workingDir} --fix`
      }
    }

    // 3. 检测 Python + pylint（跨平台）
    const hasReqTxt = await crossPlatformFileExists('requirements.txt', workingDir, executor)
    const hasSetupPy = await crossPlatformFileExists('setup.py', workingDir, executor)
    if (hasReqTxt || hasSetupPy) {
      return {
        lintCommand: `python -m pylint ${workingDir} --output-format=text 2>&1`,
        fixCommand: null // pylint 没有可靠的自动修复
      }
    }
  } catch {
    // 检测失败
  }
  return { lintCommand: null, fixCommand: null }
}

// ============ Lint 修复引擎 ============

export class LintFixEngine {
  private config: LintFixConfig
  private listeners: LintFixEventCallback[] = []

  constructor(config: LintFixConfig) {
    this.config = {
      lintTimeoutMs: 60_000,
      ...config
    }
  }

  /** 添加事件监听 */
  onEvent(callback: LintFixEventCallback): () => void {
    this.listeners.push(callback)
    return () => {
      this.listeners = this.listeners.filter(cb => cb !== callback)
    }
  }

  private emit(event: LintFixEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* 回调异常不影响主流程 */ }
    }
  }

  /**
   * 执行 lint 修复循环
   */
  async execute(params: {
    provider: LLMProvider
    systemPrompt: string
    toolDefs: ToolDefinition[]
    executor: CommandExecutor
    changedFiles: string[]
    onBeforeToolExecute?: (toolCall: ToolCall) => Promise<boolean>
    onContent?: (text: string) => void
    /** 外部中止信号 */
    abortSignal?: AbortSignal
    /** 预算预留回调；返回 false 表示预算耗尽 */
    onToolCall?: () => boolean | void
  }): Promise<LintFixResult> {
    const { provider, systemPrompt, toolDefs, executor, changedFiles, onBeforeToolExecute, onContent, abortSignal, onToolCall } = params
    const startTime = Date.now()
    const allFixToolCalls: ToolCallResult[] = []
    const allFileBaselines: Record<string, { beforeSha256: string; afterSha256?: string; originalContent?: string }> = {}

    // Step 1: 检测 lint 工具
    let lintCommand = this.config.lintCommand
    let fixCommand = this.config.fixCommand

    if (!lintCommand) {
      this.emit({ type: 'detecting' })
      const detected = await detectLintTools(this.config.workingDirectory, executor)
      lintCommand = detected.lintCommand ?? undefined
      fixCommand = detected.fixCommand ?? undefined
    }

    if (!lintCommand) {
      // P1-fix: 未检测到 lint 工具，返回 passed: false 以区分“未检查”和“通过”
      return {
        passed: false,
        initialIssueCount: 0,
        finalIssueCount: 0,
        totalRounds: 0,
        fixToolCalls: [],
        duration: Date.now() - startTime,
        lintCommand: 'none',
        fixCommand: 'none',
        finalOutput: '未检测到 lint 工具，跳过检查',
        fixCommandModifiedFiles: false,
        fileBaselines: undefined
      }
    }

    // Step 2: P0-fix: 运行自动修复前检查中止信号、预算、审批，并追踪 --fix 的文件改动
    let fixCommandModifiedFiles = false
    if (fixCommand && !abortSignal?.aborted) {
      // P0-fix: --fix 纳入预算检查
      if (onToolCall) {
        const reserved = onToolCall()
        if (reserved === false) {
          // 预算耗尽，跳过 --fix
          fixCommand = undefined
        }
      }

      // P0-fix: --fix 纳入审批检查（构造合成 ToolCall）
      if (fixCommand && onBeforeToolExecute) {
        const syntheticTc: ToolCall = {
          id: `__lint_fix_${Date.now()}__`,
          type: 'function',
          function: {
            name: 'execute_command',
            arguments: JSON.stringify({ command: fixCommand })
          }
        }
        const approved = await onBeforeToolExecute(syntheticTc)
        if (!approved) {
          fixCommand = undefined
        }
      }

      if (fixCommand) {
        // P0-fix: 在 --fix 前记录当前已变更文件快照（避免把用户原有改动算作 --fix 成果）
        // P1-fix: 快照不完整（git status 失败或文件读取失败）时跳过 --fix
        const preFixDirtyFiles = new Set<string>()
        let snapshotComplete = true

        // 1. 获取前置 dirty 文件列表
        const preStatus = await executor.execute(
          'git status --porcelain', this.config.workingDirectory, 5000
        )
        if (preStatus.exitCode !== 0) {
          snapshotComplete = false
        } else if (preStatus.stdout.trim()) {
          // P0-fix: 不能对整体 trim()，否则首行的前导空格（如 ' M file.ts'）会被截掉
          // git status --porcelain 格式：XY filename，文件名从第 4 列开始（slice(3)）
          for (const line of preStatus.stdout.split('\n')) {
            if (line.length >= 4) {
              const fp = line.slice(3).replace(/^"|"$/g, '')
              if (fp) preFixDirtyFiles.add(fp)
            }
          }
        }

        // 2. P0-fix: 读取所有 dirty 文件的工作副本内容（用于精确对比）
        // P1-fix: 使用 readFileWithHash 统一读取路径，同时获得 SHA-256
        const preFixContents = new Map<string, { content: string; sha256: string }>()
        if (snapshotComplete) {
          for (const f of preFixDirtyFiles) {
            const fileData = await readFileWithHash(f, this.config.workingDirectory, executor)
            if (fileData === null) {
              // 文件读取失败（可能被删除或不可读）→ 快照不完整
              snapshotComplete = false
              break
            }
            preFixContents.set(f, fileData)
          }
        }

        // P1-fix: 快照不完整时跳过 --fix，避免覆盖用户原有改动
        if (!snapshotComplete) {
          fixCommand = undefined
        }

        if (fixCommand) {
          try {
            await executor.execute(fixCommand, this.config.workingDirectory, this.config.lintTimeoutMs)
          } catch {
            // 修复命令失败不阻断流程
          }

          // P0-fix: 运行 --fix 后检测所有变更文件，包含「被改回干净」的文件
          // P1-fix: 后置快照失败必须阻断交付，不能静默继续
          let postSnapshotFailed = false
          try {
            const statusResult = await executor.execute(
              'git status --porcelain', this.config.workingDirectory, 5000
            )
            if (statusResult.exitCode !== 0) {
              postSnapshotFailed = true
            } else {
              // 获取后置 dirty 文件集合
              const postFixDirtyFiles = new Set<string>()
              if (statusResult.stdout.trim()) {
                // P0-fix: 不能对整体 trim()，保留每行的前导空格
                for (const line of statusResult.stdout.split('\n')) {
                  if (line.length >= 4) {
                    const fp = line.slice(3).replace(/^"|"$/g, '')
                    if (fp) postFixDirtyFiles.add(fp)
                  }
                }
              }

              // P0-fix: 收集所有被 --fix 真正修改的文件
              // 三类：(a) 新增 dirty (b) 原本 dirty 且内容变化 (c) 原本 dirty 但现在干净（被 --fix 改回）
              const trulyFixModifiedFiles: string[] = []

              // (a) 新增 dirty：--fix 前不在 dirty 列表，现在在
              for (const f of postFixDirtyFiles) {
                if (!preFixDirtyFiles.has(f)) {
                  trulyFixModifiedFiles.push(f)
                }
              }

              // (b) 原本 dirty 且现在仍 dirty：对比内容
              for (const f of preFixDirtyFiles) {
                if (postFixDirtyFiles.has(f)) {
                  const afterData = await readFileWithHash(f, this.config.workingDirectory, executor)
                  const beforeData = preFixContents.get(f)
                  if (afterData && beforeData && afterData.sha256 !== beforeData.sha256) {
                    trulyFixModifiedFiles.push(f)
                  } else if (!afterData && beforeData) {
                    // 文件被删除 → --fix 造成的
                    trulyFixModifiedFiles.push(f)
                  }
                }
              }

              // (c) P0-fix: 原本 dirty 但现在干净 → --fix 把它改回了 HEAD/索引状态
              for (const f of preFixDirtyFiles) {
                if (!postFixDirtyFiles.has(f)) {
                  trulyFixModifiedFiles.push(f)
                }
              }

              if (trulyFixModifiedFiles.length > 0) {
                fixCommandModifiedFiles = true

                // P0/P1-fix: 为真正被 --fix 修改的文件生成基线
                for (const f of trulyFixModifiedFiles) {
                  // 写前数据：优先用 --fix 前保存的工作副本
                  const beforeData = preFixContents.get(f) ?? null

                  // 写后数据：读取当前文件
                  const afterData = await readFileWithHash(f, this.config.workingDirectory, executor)

                  if (beforeData || afterData) {
                    allFileBaselines[f] = {
                      beforeSha256: beforeData?.sha256 ?? 'deleted-or-new',
                      afterSha256: afterData?.sha256 ?? 'deleted',
                      // P0-fix: originalContent 保存 --fix 前的工作副本（而非 HEAD），恢复时不覆盖用户原有修改
                      originalContent: beforeData?.content
                    }
                  }
                }
              }
            }
          } catch {
            postSnapshotFailed = true
          }

          // P1-fix: 后置快照失败 → --fix 可能已改动文件但无法确认，阻断交付
          if (postSnapshotFailed) {
            this.emit({ type: 'lint-failed', data: { round: 0, reason: '--fix 后置快照失败，无法确认改动范围' } })
            return {
              passed: false,
              initialIssueCount: 0,
              finalIssueCount: 0,
              totalRounds: 0,
              fixToolCalls: allFixToolCalls,
              duration: Date.now() - startTime,
              lintCommand,
              fixCommand: fixCommand || 'none',
              finalOutput: '--fix 已执行但后置 git status 失败，无法确认改动范围，已阻断交付',
              fixCommandModifiedFiles: false,
              fileBaselines: undefined
            }
          }
        }
      }
    }

    // Step 3: Lint 检查循环
    let initialIssueCount = 0
    let lastLintOutput = ''
    let lastIssueCount = 0
    let lastLintExitCode = 0

    for (let round = 1; round <= this.config.maxRounds; round++) {
      // 检查中止信号
      if (abortSignal?.aborted) {
        this.emit({ type: 'error', data: { reason: '外部中止' } })
        break
      }

      this.emit({ type: 'lint-start', data: { round, lintCommand } })

      let lintOutput: { exitCode: number; stdout: string; stderr: string }
      try {
        lintOutput = await executor.execute(lintCommand, this.config.workingDirectory, this.config.lintTimeoutMs)
      } catch (e) {
        lintOutput = {
          exitCode: 1,
          stdout: '',
          stderr: e instanceof Error ? e.message : String(e)
        }
      }

      const combinedOutput = (lintOutput.stdout || '') + (lintOutput.stderr || '')
      const issueCount = countIssues(combinedOutput)

      if (round === 1) {
        initialIssueCount = issueCount
      }

      lastLintOutput = combinedOutput
      lastIssueCount = issueCount
      lastLintExitCode = lintOutput.exitCode

      this.emit({ type: 'lint-result', data: { round, issueCount, exitCode: lintOutput.exitCode } })

      // P1-fix: 无问题且退出码为 0 → 通过（联合判断防止工具启动失败误判）
      if (issueCount === 0 && lintOutput.exitCode === 0) {
        this.emit({ type: 'lint-passed', data: { round } })
        return {
          passed: true,
          initialIssueCount,
          finalIssueCount: 0,
          totalRounds: round,
          fixToolCalls: allFixToolCalls,
          duration: Date.now() - startTime,
          lintCommand,
          fixCommand: fixCommand || 'none',
          finalOutput: '无问题',
          fixCommandModifiedFiles,
          fileBaselines: Object.keys(allFileBaselines).length > 0 ? allFileBaselines : undefined
        }
      }

      // P1-fix: 退出码非零但无法解析问题数 → 视为工具异常，不判为通过
      if (lintOutput.exitCode !== 0 && issueCount === 0 && combinedOutput.trim()) {
        this.emit({ type: 'lint-failed', data: { round, reason: 'lint 工具异常退出' } })
        return {
          passed: false,
          initialIssueCount,
          finalIssueCount: 0,
          totalRounds: round,
          fixToolCalls: allFixToolCalls,
          duration: Date.now() - startTime,
          lintCommand,
          fixCommand: fixCommand || 'none',
          finalOutput: `lint 工具异常退出 (exitCode=${lintOutput.exitCode})，输出无法解析`,
          fixCommandModifiedFiles,
          fileBaselines: Object.keys(allFileBaselines).length > 0 ? allFileBaselines : undefined
        }
      }

      // 最后一轮仍有问题
      if (round >= this.config.maxRounds) {
        this.emit({ type: 'lint-failed', data: { round, issueCount } })
        break
      }

      // LLM 修复阶段
      this.emit({ type: 'fixing', data: { round, issueCount } })

      const fixResult = await this.runFixRound({
        provider,
        systemPrompt,
        toolDefs,
        lintOutput: combinedOutput,
        issueCount,
        changedFiles,
        onBeforeToolExecute,
        onContent,
        abortSignal,
        onToolCall
      })

      allFixToolCalls.push(...fixResult.toolCalls)

      // 合并文件基线
      if (fixResult.fileBaselines) {
        for (const [path, baseline] of Object.entries(fixResult.fileBaselines)) {
          allFileBaselines[path] = baseline
        }
      }
    }

    return {
      passed: lastIssueCount === 0 && lastLintExitCode === 0,
      initialIssueCount,
      finalIssueCount: lastIssueCount,
      totalRounds: this.config.maxRounds,
      fixToolCalls: allFixToolCalls,
      duration: Date.now() - startTime,
      lintCommand,
      fixCommand: fixCommand || 'none',
      finalOutput: lastLintOutput.slice(0, 2000),
      fixCommandModifiedFiles,
      fileBaselines: Object.keys(allFileBaselines).length > 0 ? allFileBaselines : undefined
    }
  }

  /**
   * 单轮 LLM 修复
   */
  private async runFixRound(params: {
    provider: LLMProvider
    systemPrompt: string
    toolDefs: ToolDefinition[]
    lintOutput: string
    issueCount: number
    changedFiles: string[]
    onBeforeToolExecute?: (toolCall: ToolCall) => Promise<boolean>
    onContent?: (text: string) => void
    abortSignal?: AbortSignal
    onToolCall?: () => boolean | void
  }): Promise<{ toolCalls: ToolCallResult[]; fileBaselines?: Record<string, { beforeSha256: string; afterSha256?: string; originalContent?: string }> }> {
    const { provider, systemPrompt, toolDefs, lintOutput, issueCount, changedFiles, onBeforeToolExecute, onContent, abortSignal, onToolCall } = params

    const maxOutputLen = 6000
    const truncatedOutput = lintOutput.length > maxOutputLen
      ? lintOutput.slice(0, maxOutputLen) + '\n... (输出已截断)'
      : lintOutput

    const fixPrompt = `代码 lint 检查发现 ${issueCount} 个问题。请分析以下 lint 输出并修复代码。

## Lint 输出
${truncatedOutput}

## 变更的文件
${changedFiles.join('\n')}

## 要求
1. 仔细阅读每个 lint 问题的文件路径、行号和规则
2. 使用 read_file 读取相关源文件
3. 使用 search_replace 精确修复每个问题
4. 不要做与 lint 修复无关的改动
5. 修复完成后输出简要说明`

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: fixPrompt }
    ]

    const toolCalls: ToolCallResult[] = []
    const fileBaselines: Record<string, { beforeSha256: string; afterSha256?: string; originalContent?: string }> = {}
    const maxToolRounds = 3

    for (let toolRound = 0; toolRound < maxToolRounds; toolRound++) {
      const pendingToolCalls: ToolCall[] = []

      const content = await provider.chatStreamWithTools(
        messages,
        (text) => { onContent?.(text) },
        (tcs) => { pendingToolCalls.push(...tcs) },
        { tools: toolDefs.length > 0 ? toolDefs : undefined }
      )

      if (pendingToolCalls.length === 0) break

      messages.push({
        role: 'assistant',
        content: content || '',
        tool_calls: pendingToolCalls
      })

      for (const tc of pendingToolCalls) {
        // 中止信号检查
        if (abortSignal?.aborted) break

        // 预算检查
        if (onToolCall) {
          const reserved = onToolCall()
          if (reserved === false) {
            toolCalls.push({
              toolCallId: tc.id,
              functionName: tc.function.name,
              arguments: {},
              status: 'error',
              result: '',
              duration: 0,
              error: '预算耗尽'
            })
            break
          }
        }

        if (onBeforeToolExecute) {
          const approved = await onBeforeToolExecute(tc)
          if (!approved) {
            toolCalls.push({
              toolCallId: tc.id,
              functionName: tc.function.name,
              arguments: {},
              status: 'error',
              result: '',
              duration: 0,
              error: '用户拒绝执行'
            })
            continue
          }
        }

        // P1-fix: 写前读取旧内容（用于基线记录）
        let preWriteOldContent: string | null = null
        let preWriteSha256: string | undefined
        if (tc.function.name === 'write_file' || tc.function.name === 'search_replace') {
          try {
            const args = JSON.parse(tc.function.arguments)
            if (args.path && (globalThis as any).window?.electronAPI?.readFile) {
              const readResult = await (globalThis as any).window.electronAPI.readFile(args.path)
              if (readResult.success) {
                preWriteOldContent = readResult.content || ''
                preWriteSha256 = readResult.sha256
              }
            }
          } catch { /* 忽略 */ }
        }

        const result = await toolExecutor.execute(tc)
        toolCalls.push({
          toolCallId: tc.id,
          functionName: tc.function.name,
          arguments: typeof result.result === 'object' ? result.result : {},
          status: result.status === 'success' ? 'success' : 'error',
          result: typeof result.result === 'string' ? result.result : JSON.stringify(result.result),
          duration: result.duration,
          error: result.error
        })

        // P1-fix: 记录写后基线
        if ((tc.function.name === 'write_file' || tc.function.name === 'search_replace') && result.status === 'success') {
          try {
            const args = JSON.parse(tc.function.arguments)
            if (args.path) {
              let afterSha256: string | undefined
              if ((globalThis as any).window?.electronAPI?.readFile) {
                const postRead = await (globalThis as any).window.electronAPI.readFile(args.path)
                if (postRead.success) afterSha256 = postRead.sha256
              }
              if (afterSha256) {
                const existing = fileBaselines[args.path]
                if (existing) {
                  existing.afterSha256 = afterSha256
                } else {
                  fileBaselines[args.path] = {
                    beforeSha256: preWriteSha256 || 'unknown',
                    afterSha256,
                    originalContent: preWriteOldContent !== null ? preWriteOldContent : undefined
                  }
                }
              }
            }
          } catch { /* 解析失败忽略 */ }
        }

        messages.push({
          role: 'tool',
          content: typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2),
          tool_call_id: tc.id,
          name: tc.function.name
        })
      }
    }

    return { toolCalls, fileBaselines: Object.keys(fileBaselines).length > 0 ? fileBaselines : undefined }
  }
}

// ============ 辅助函数 ============

/**
 * 从 lint 输出中估算问题数
 */
function countIssues(output: string): number {
  if (!output || !output.trim()) return 0

  // 尝试解析 JSON（ESLint --format json）
  try {
    const parsed = JSON.parse(output)
    if (Array.isArray(parsed)) {
      return parsed.reduce((sum: number, f: any) => sum + (f.errorCount || 0) + (f.warningCount || 0), 0)
    }
  } catch { /* 非 JSON */ }

  // 文本模式：计算 error/warning 行数
  const lines = output.split('\n')
  let count = 0
  for (const line of lines) {
    // ESLint 文本格式: /path/file.ts:10:5: error/warning ...
    if (/\d+:\d+\s+(error|warning|warn)\b/i.test(line)) count++
    // Ruff 格式: /path/file.py:10:5: E501 ...
    else if (/:\d+:\d+:\s+[A-Z]+\d+/.test(line)) count++
    // Pylint 格式: /path/file.py:10:0: C0114...
    else if (/:\d+:\d+:\s+[CRWEF]\d+/.test(line)) count++
  }
  return count
}
