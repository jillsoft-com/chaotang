/**
 * 测试循环引擎 — "测试 → 分析失败 → 修复 → 再测试" 闭环
 *
 * 在自主引擎完成后，独立运行测试循环：
 * 1. 自动检测或接受指定的测试命令
 * 2. 运行测试
 * 3. 如果全部通过 → 结束
 * 4. 如果有失败 → 将失败输出注入 LLM 上下文
 * 5. LLM 分析失败并通过工具修改代码
 * 6. 回到步骤 2
 * 7. 最多 maxRounds 轮
 *
 * 设计依据：编码能力二期升级 Phase 2。
 */

import type { ChatMessage, ToolCall, ToolCallResult, ToolDefinition } from '@/types'
import type { LLMProvider } from '@/services/llm/types'
import { toolExecutor } from '@/services/tools/executor'
import type { CommandExecutor } from './acceptance-gate'

// ============ 类型 ============

/** 测试循环配置 */
export interface TestLoopConfig {
  /** 最大修复轮次（默认 3） */
  maxRounds: number
  /** 指定测试命令（可选，不指定则自动检测） */
  testCommand?: string
  /** 单条测试超时（默认 120s） */
  testTimeoutMs?: number
  /** 工作目录 */
  workingDirectory: string
  /** 项目指令（可选） */
  agentsMdHint?: string
}

/** 测试循环事件类型 */
export type TestLoopEventType =
  | 'detecting'       // 检测测试命令中
  | 'test-start'      // 开始运行测试
  | 'test-result'     // 测试完成（通过或失败）
  | 'fixing'          // LLM 修复中
  | 'test-passed'     // 全部通过
  | 'test-failed'     // 达到最大轮次仍未通过
  | 'budget-exhausted' // 预算耗尽
  | 'error'           // 出错

export interface TestLoopEvent {
  type: TestLoopEventType
  data?: any
}

type TestLoopEventCallback = (event: TestLoopEvent) => void

/** 单轮测试结果 */
export interface TestRoundResult {
  round: number
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  passed: boolean
  duration: number
}

/** 测试循环最终结果 */
export interface TestLoopResult {
  /** 是否最终通过 */
  passed: boolean
  /** 总轮次数 */
  totalRounds: number
  /** 每轮结果详情 */
  rounds: TestRoundResult[]
  /** LLM 修复过程中的工具调用 */
  fixToolCalls: ToolCallResult[]
  /** 总耗时（毫秒） */
  duration: number
  /** 使用的测试命令 */
  testCommand: string
  /** P1-fix: 修复过程中写入的文件基线记录 */
  fileBaselines?: Record<string, { beforeSha256: string; afterSha256?: string; originalContent?: string }>
}

// ============ 测试命令检测 ============

/**
 * 跨平台读取文件内容（用于检测项目配置文件）
 * 兼容 Windows PowerShell / cmd.exe 和 Unix bash
 */
async function crossPlatformReadFile(
  filePath: string,
  workingDir: string,
  executor: CommandExecutor
): Promise<string | null> {
  // 策略 1: PowerShell (Windows)
  const psResult = await executor.execute(
    `Get-Content -Raw -ErrorAction SilentlyContinue "${filePath}"`,
    workingDir, 5000
  )
  if (psResult.exitCode === 0 && psResult.stdout.trim()) {
    return psResult.stdout
  }

  // 策略 2: Unix / Git Bash
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
  // PowerShell: Test-Path
  const psResult = await executor.execute(
    `if (Test-Path "${filePath}") { echo __EXISTS__ }`,
    workingDir, 3000
  )
  if (psResult.stdout.includes('__EXISTS__')) return true

  // Unix / Git Bash: test -f
  const unixResult = await executor.execute(
    `test -f "${filePath}" && echo __EXISTS__`,
    workingDir, 3000
  )
  if (unixResult.stdout.includes('__EXISTS__')) return true

  return false
}

/**
 * 从 package.json 中检测测试命令
 */
function detectTestCommandFromPackageJson(scripts: Record<string, string>): string | null {
  // 优先选择 test 脚本
  const testScripts = ['test', 'test:unit', 'test:all', 'jest', 'vitest', 'mocha']
  for (const name of testScripts) {
    if (scripts[name]) return `npm run ${name}`
  }
  return null
}

/**
 * 自动检测工作目录的测试命令
 */
async function detectTestCommand(
  workingDir: string,
  executor: CommandExecutor
): Promise<string | null> {
  try {
    // 1. 检测 package.json（跨平台）
    const pkgContent = await crossPlatformReadFile('package.json', workingDir, executor)
    if (pkgContent) {
      try {
        const pkg = JSON.parse(pkgContent.trim())
        if (pkg.scripts && typeof pkg.scripts === 'object') {
          const cmd = detectTestCommandFromPackageJson(pkg.scripts)
          if (cmd) return cmd
        }
      } catch { /* JSON 解析失败 */ }
    }

    // 2. 检测 Cargo.toml (Rust)
    if (await crossPlatformFileExists('Cargo.toml', workingDir, executor)) {
      return 'cargo test'
    }

    // 3. 检测 go.mod (Go)
    if (await crossPlatformFileExists('go.mod', workingDir, executor)) {
      return 'go test ./...'
    }

    // 4. 检测 Python 项目
    const hasPyReq = await crossPlatformFileExists('requirements.txt', workingDir, executor)
    const hasPyProject = await crossPlatformFileExists('pyproject.toml', workingDir, executor)
    const hasSetupPy = await crossPlatformFileExists('setup.py', workingDir, executor)
    if (hasPyReq || hasPyProject || hasSetupPy) {
      const pytestCheck = await executor.execute('python -m pytest --version', workingDir, 5000)
      if (pytestCheck.exitCode === 0) return 'python -m pytest'
    }

    // 5. 检测 Makefile 中的 test target（P2-fix: 跨平台，使用 crossPlatformReadFile 替代 grep）
    if (await crossPlatformFileExists('Makefile', workingDir, executor)) {
      const makefileContent = await crossPlatformReadFile('Makefile', workingDir, executor)
      if (makefileContent && /^test:/m.test(makefileContent)) {
        return 'make test'
      }
    }
  } catch {
    // 检测失败返回 null
  }
  return null
}

// ============ 测试循环引擎 ============

export class TestLoopEngine {
  private config: TestLoopConfig
  private listeners: TestLoopEventCallback[] = []

  constructor(config: TestLoopConfig) {
    this.config = {
      testTimeoutMs: 120_000,
      ...config
    }
  }

  /** 添加事件监听 */
  onEvent(callback: TestLoopEventCallback): () => void {
    this.listeners.push(callback)
    return () => {
      this.listeners = this.listeners.filter(cb => cb !== callback)
    }
  }

  private emit(event: TestLoopEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* 回调异常不影响主流程 */ }
    }
  }

  /**
   * 执行测试循环
   *
   * @param provider LLM 提供者（用于分析失败和修复）
   * @param systemPrompt 系统提示词
   * @param toolDefs 可用工具定义
   * @param executor 命令执行器
   * @param goal 原始目标（用于 LLM 上下文）
   * @param changedFiles 变更的文件列表
   * @param onBeforeToolExecute 工具执行前回调（审批）
   */
  async execute(params: {
    provider: LLMProvider
    systemPrompt: string
    toolDefs: ToolDefinition[]
    executor: CommandExecutor
    goal: string
    changedFiles: string[]
    onBeforeToolExecute?: (toolCall: ToolCall) => Promise<boolean>
    onContent?: (text: string) => void
    /** 外部中止信号 */
    abortSignal?: AbortSignal
    /** 预算预留回调；返回 false 表示预算耗尽 */
    onToolCall?: () => boolean | void
  }): Promise<TestLoopResult> {
    const { provider, systemPrompt, toolDefs, executor, goal, changedFiles, onBeforeToolExecute, onContent, abortSignal, onToolCall } = params
    const startTime = Date.now()
    const rounds: TestRoundResult[] = []
    const allFixToolCalls: ToolCallResult[] = []
    const allFileBaselines: Record<string, { beforeSha256: string; afterSha256?: string; originalContent?: string }> = {}

    // Step 1: 检测测试命令
    let testCommand: string | undefined = this.config.testCommand
    if (!testCommand) {
      this.emit({ type: 'detecting' })
      const detected = await detectTestCommand(this.config.workingDirectory, executor)
      testCommand = detected ?? undefined
    }

    if (!testCommand) {
      // 无法检测到测试命令，直接返回未验证
      return {
        passed: false,
        totalRounds: 0,
        rounds: [],
        fixToolCalls: [],
        duration: Date.now() - startTime,
        testCommand: 'none'
      }
    }

    // Step 2: 测试循环
    for (let round = 1; round <= this.config.maxRounds; round++) {
      // 检查中止信号
      if (abortSignal?.aborted) {
        this.emit({ type: 'budget-exhausted', data: { reason: '外部中止' } })
        break
      }

      // 运行测试
      this.emit({ type: 'test-start', data: { round, testCommand } })
      const testStart = Date.now()

      let testOutput: { exitCode: number; stdout: string; stderr: string; timedOut: boolean }
      try {
        testOutput = await executor.execute(
          testCommand,
          this.config.workingDirectory,
          this.config.testTimeoutMs
        )
      } catch (e) {
        testOutput = {
          exitCode: 1,
          stdout: '',
          stderr: e instanceof Error ? e.message : String(e),
          timedOut: false
        }
      }

      const roundResult: TestRoundResult = {
        round,
        exitCode: testOutput.exitCode,
        stdout: testOutput.stdout,
        stderr: testOutput.stderr,
        timedOut: testOutput.timedOut,
        passed: testOutput.exitCode === 0 && !testOutput.timedOut,
        duration: Date.now() - testStart
      }
      rounds.push(roundResult)

      this.emit({ type: 'test-result', data: roundResult })

      // 测试通过
      if (roundResult.passed) {
        this.emit({ type: 'test-passed', data: { round } })
        return {
          passed: true,
          totalRounds: round,
          rounds,
          fixToolCalls: allFixToolCalls,
          duration: Date.now() - startTime,
          testCommand,
          fileBaselines: Object.keys(allFileBaselines).length > 0 ? allFileBaselines : undefined
        }
      }

      // 最后一轮仍然失败
      if (round >= this.config.maxRounds) {
        this.emit({ type: 'test-failed', data: { round, totalRounds: round } })
        break
      }

      // LLM 修复阶段
      this.emit({ type: 'fixing', data: { round } })

      const fixResult = await this.runFixRound({
        provider,
        systemPrompt,
        toolDefs,
        testOutput,
        testCommand,
        goal,
        changedFiles,
        round,
        onBeforeToolExecute,
        onContent,
        abortSignal,
        onToolCall
      })

      allFixToolCalls.push(...fixResult.toolCalls)

      // 合并文件基线
      if (fixResult.fileBaselines) {
        for (const [path, baseline] of Object.entries(fixResult.fileBaselines)) {
          allFileBaselines[path] = baseline as { beforeSha256: string; afterSha256?: string; originalContent?: string }
        }
      }

      // 更新变更文件列表（修复过程中可能修改了新文件）
      if (fixResult.newFiles.length > 0) {
        for (const f of fixResult.newFiles) {
          if (!changedFiles.includes(f)) changedFiles.push(f)
        }
      }
    }

    return {
      passed: false,
      totalRounds: rounds.length,
      rounds,
      fixToolCalls: allFixToolCalls,
      duration: Date.now() - startTime,
      testCommand,
      fileBaselines: Object.keys(allFileBaselines).length > 0 ? allFileBaselines : undefined
    }
  }

  /**
   * 单轮修复：将测试失败输出注入 LLM，让其分析并修复
   */
  private async runFixRound(params: {
    provider: LLMProvider
    systemPrompt: string
    toolDefs: ToolDefinition[]
    testOutput: { exitCode: number; stdout: string; stderr: string; timedOut: boolean }
    testCommand: string
    goal: string
    changedFiles: string[]
    round: number
    onBeforeToolExecute?: (toolCall: ToolCall) => Promise<boolean>
    onContent?: (text: string) => void
    abortSignal?: AbortSignal
    onToolCall?: () => boolean | void
  }): Promise<{ toolCalls: ToolCallResult[]; newFiles: string[]; fileBaselines?: Record<string, { beforeSha256: string; afterSha256?: string; originalContent?: string }> }> {
    const { provider, systemPrompt, toolDefs, testOutput, testCommand, goal, changedFiles, onBeforeToolExecute, onContent, abortSignal, onToolCall } = params

    // 截断过长的测试输出
    const maxOutputLen = 8000
    const stdout = testOutput.stdout.length > maxOutputLen
      ? testOutput.stdout.slice(0, maxOutputLen) + '\n... (输出已截断)'
      : testOutput.stdout
    const stderr = testOutput.stderr.length > maxOutputLen
      ? testOutput.stderr.slice(0, maxOutputLen) + '\n... (输出已截断)'
      : testOutput.stderr

    const fixPrompt = `你上一轮的代码修改导致了测试失败。请分析以下测试输出，定位问题并修复代码。

## 原始目标
${goal}

## 测试命令
${testCommand}

## 测试输出（退出码: ${testOutput.exitCode}）

### stdout
${stdout || '(空)'}

### stderr
${stderr || '(空)'}

## 变更的文件
${changedFiles.join('\n')}

## 要求
1. 仔细分析测试失败的原因
2. 使用 read_file 读取相关源文件
3. 使用 write_file 或 search_replace 修复代码
4. 修复完成后输出简要说明

注意：只修复测试失败相关的代码，不要做无关的改动。`

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: fixPrompt }
    ]

    const toolCalls: ToolCallResult[] = []
    const newFiles: string[] = []
    const fileBaselines: Record<string, { beforeSha256: string; afterSha256?: string; originalContent?: string }> = {}
    const maxToolRounds = 3 // 每轮修复最多 3 次工具调用循环

    for (let toolRound = 0; toolRound < maxToolRounds; toolRound++) {
      const pendingToolCalls: ToolCall[] = []

      const content = await provider.chatStreamWithTools(
        messages,
        (text) => { onContent?.(text) },
        (tcs) => { pendingToolCalls.push(...tcs) },
        { tools: toolDefs.length > 0 ? toolDefs : undefined }
      )

      if (pendingToolCalls.length === 0) {
        // 没有工具调用，LLM 认为修复完成
        break
      }

      // 执行工具调用
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

        // 审批检查
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

        // 跟踪新写入的文件 + 记录基线
        if ((tc.function.name === 'write_file' || tc.function.name === 'search_replace') && result.status === 'success') {
          try {
            const args = JSON.parse(tc.function.arguments)
            if (args.path) {
              if (!newFiles.includes(args.path)) newFiles.push(args.path)
              // 读取写后哈希
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

    return { toolCalls, newFiles, fileBaselines }
  }
}
