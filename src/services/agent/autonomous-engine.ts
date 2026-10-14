import { appStorage } from '@/services/storage'
/**
 * 自主执行引擎 — 通用 "规划→执行→验证→迭代" 闭环
 *
 * 设计为底层能力，可被任何角色/团队使用：
 * - IT 开发团队：写代码 → 编译 → 跑测试 → 看报错 → 改代码 → 再跑
 * - 企业团队：生成方案 → 数据校验 → 交叉验证 → 修正方案
 * - 古代朝堂：制定策略 → 可行性检查 → 风险评估 → 调整策略
 *
 * 核心原理：
 *   1. LLM 根据目标制定执行计划
 *   2. 调用工具执行计划中的步骤
 *   3. LLM 审查工具返回结果，判断目标是否达成
 *   4. 如未达成，调整计划并继续执行
 *   5. 循环直到目标达成或达到最大迭代次数
 *
 * 与现有 Coordinator 的关系：
 *   - Coordinator 负责"任务拆解"（把一个需求拆给多个角色）
 *   - AutonomousEngine 负责"单角色的自主执行"（确保该角色真正完成目标）
 *   - 两者组合：Coordinator 拆解 → 每个 Worker 用 AutonomousEngine 自主执行
 */

import type { ChatMessage, ToolCall, ToolCallResult, ToolDefinition } from '@/types'
import type { LLMProvider } from '@/services/llm/types'
import { createProvider } from '@/services/llm'
import { llmService } from '@/services/llm-config'
import { toolExecutor } from '@/services/tools/executor'
import { compressContext } from './context-compressor'
import { ContextManager } from './context-manager'
import { WRITE_TOOLS } from './resource-lock'
import { invalidateIndexOnWrite } from './repository-context'
import { runAcceptance, collectChangedFiles } from './acceptance-gate'
import type { AcceptancePlan, CommandExecutor, RepairConfig } from './acceptance-gate'
import { extractRepairDiagnostics, hasNewEvidence, DEFAULT_REPAIR_CONFIG } from './acceptance-gate'
import { TestLoopEngine } from './test-loop'
import type { TestLoopResult } from './test-loop'
import { LintFixEngine } from './lint-fix-loop'
import type { LintFixResult } from './lint-fix-loop'
import type { SubAgentProfile } from './subagent-registry'

// ============ 类型 ============

/** 自主执行引擎配置 */
export interface AutonomousConfig {
  /** 最大工具调用迭代轮数（默认 10） */
  maxIterations: number
  /** 是否在每轮后注入验证提示（默认 true） */
  verifyAfterEachRound: boolean
  /** 工作目录（可选） */
  workingDirectory?: string
  /** 项目指令文件内容（可选） */
  agentsMdHint?: string
  /** 持久记忆（可选） */
  memoryHint?: string
  /** 模型标识（用于 ContextManager 容量判断） */
  modelId?: string
  /** 是否为只读节点（阻止写工具调用） */
  readOnly?: boolean
  /** 子 Agent 配置（三期 Phase A）— 追加提示词 + 工具过滤 */
  subAgentProfile?: SubAgentProfile
}

export const DEFAULT_AUTONOMOUS_CONFIG: AutonomousConfig = {
  maxIterations: 10,
  verifyAfterEachRound: true
}

/** 自主执行进度事件 */
export type AutonomousEventType =
  | 'planning'        // 规划中
  | 'plan-ready'      // 规划完成
  | 'executing'       // 执行工具中
  | 'tool-call'       // 单次工具调用
  | 'verifying'       // 验证中
  | 'iterating'       // 开始下一轮迭代
  | 'goal-reached'    // 目标达成
  | 'complete'        // 全部完成
  | 'error'           // 出错

export interface AutonomousEvent {
  type: AutonomousEventType
  data?: any
}

type AutonomousEventCallback = (event: AutonomousEvent) => void

/** 检查点状态（心跳监护者使用） */
export interface CheckpointState {
  round: number
  toolCallsCount: number
  goalReached: boolean
  aborted: boolean
  lastContent: string
  /** 最近 5 次工具调用指纹（供监护器循环检测） */
  recentToolFingerprints: string[]
  /** 最后一次有效进展时间 */
  lastProgressAt: number
  /** 工具证据摘要（简短描述） */
  evidenceSummary: string
}

/** 自主执行结果 */
export interface AutonomousResult {
  /** 最终输出内容 */
  content: string
  /** 所有工具调用记录 */
  toolCalls: ToolCallResult[]
  /** 实际迭代轮数 */
  iterations: number
  /** 是否达成目标 */
  goalReached: boolean
  /** 总耗时（毫秒） */
  duration: number
  /** 是否被外部中止 */
  aborted?: boolean
  /** 总 Token 消耗（估算） */
  tokenEstimate?: {
    promptTokens: number
    completionTokens: number
  }
  /** 验收结果（P0-B） */
  acceptance?: AcceptancePlan
  /** 文件基线记录（P1-C） */
  fileBaselines?: Record<string, { beforeSha256: string; afterSha256?: string; originalContent?: string }>
  /** 测试循环结果（Phase 2） */
  testLoop?: TestLoopResult
  /** Lint 修复结果（Phase 4） */
  lintFix?: LintFixResult
}

// ============ 自主执行系统提示词 ============

/**
 * 通用自主执行系统提示词后缀
 * 附加在任何角色的 system prompt 之后，赋予其"规划→执行→验证→迭代"能力
 */
export const AUTONOMOUS_PROMPT_SUFFIX = `

## 🔄 自主执行协议

你具备自主执行能力。请按以下流程完成目标：

### 工作流程
1. **规划**：分析目标，制定具体的执行步骤（在心中规划，不必输出完整计划）
2. **执行**：逐步调用工具完成每个步骤
3. **检查**：每次工具调用后，仔细审查返回结果
4. **修正**：如果发现问题，调整方案并重试
5. **验证**：所有步骤完成后，主动验证整体结果

### 执行规则
- 每完成一个关键步骤，检查结果是否符合预期
- 如果命令执行失败，分析错误信息并修改命令重试
- 如果测试失败，读取失败详情，定位原因，修复代码，重新运行测试
- 如果文件写入后发现问题，读取文件验证，然后修改
- **不要重复用相同参数调用已失败的工具**，要分析原因后改变参数
- 不要在一次回复中调用超过 5 个工具，分批执行并检查中间结果
- 当你确认目标已完全达成时，输出最终总结并停止工具调用

### 目标达成信号
当你认为目标已完全达成时，请在回复开头加上：
\`[GOAL_REACHED]\`
后面跟随完成总结。`

/**
 * IT 开发场景的增强提示词
 */
export const AUTONOMOUS_DEV_PROMPT_SUFFIX = `

### 开发执行规范
- 创建文件后立即读取确认内容正确
- 写完代码后运行编译/构建命令验证（如 npm run build、cargo build 等）
- 如果有测试，运行测试并确认通过（如 npm test、pytest 等）
- 如果编译或测试失败，分析报错 → 修改代码 → 重新验证，反复直到通过
- 使用 search_code 工具确认修改不影响其他文件
- 每修改一个文件后验证，不要批量修改后才验证`

// ============ 自主执行引擎 ============

export class AutonomousEngine {
  private config: AutonomousConfig
  private listeners: AutonomousEventCallback[] = []
  /** P1-C: 本次执行的文件基线记录 */
  private _fileBaselines?: Record<string, { beforeSha256: string; afterSha256?: string; originalContent?: string }>

  constructor(config?: Partial<AutonomousConfig>) {
    this.config = { ...DEFAULT_AUTONOMOUS_CONFIG, ...config }
  }

  /**
   * 添加事件监听
   */
  onEvent(callback: AutonomousEventCallback): () => void {
    this.listeners.push(callback)
    return () => {
      this.listeners = this.listeners.filter(cb => cb !== callback)
    }
  }

  private emit(event: AutonomousEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* 回调异常不影响主流程 */ }
    }
  }

  /**
   * 获取摘要模型 provider（用于上下文压缩）
   */
  private getSummaryProvider(): LLMProvider | null {
    const summaryId = appStorage.getItem('summary_model_id')
    if (summaryId) {
      const cfg = llmService.getById(summaryId)
      if (cfg) return createProvider({ provider: cfg.provider, model: cfg.model, apiKey: cfg.apiKey, baseURL: cfg.baseURL })
    }
    const defaultCfg = llmService.getAll().find((c: any) => c.isDefault) || llmService.getAll()[0]
    if (defaultCfg) return createProvider({ provider: defaultCfg.provider, model: defaultCfg.model, apiKey: defaultCfg.apiKey, baseURL: defaultCfg.baseURL })
    return null
  }

  /**
   * 执行自主任务
   *
   * @param provider LLM 提供者
   * @param systemPrompt 角色的完整系统提示词（已附加自主协议）
   * @param goal 目标描述
   * @param taskContext 任务上下文（来自协调者的任务描述）
   * @param toolDefs 可用工具定义
   * @param onContent 流式内容回调（更新 UI）
   * @param onBeforeToolExecute 危险命令审批回调
   */
  async execute(params: {
    provider: LLMProvider
    systemPrompt: string
    goal: string
    taskContext?: string
    toolDefs: ToolDefinition[]
    onContent: (text: string) => void
    onBeforeToolExecute?: (toolCall: ToolCall) => Promise<boolean>
    /** 外部中止信号（心跳监护者/用户暂停） */
    abortSignal?: AbortSignal
    /** 每轮结束后的检查点回调 */
    onCheckpoint?: (state: CheckpointState) => void
    /** 每次工具调用后的回调（用于预算追踪）；返回 false 表示预算耗尽，引擎应中止 */
    onToolCall?: () => boolean | void
  }): Promise<AutonomousResult> {
    const { provider, systemPrompt, goal, taskContext, toolDefs, onContent, onBeforeToolExecute, abortSignal, onCheckpoint, onToolCall } = params
    const startTime = Date.now()
    const allToolCalls: ToolCallResult[] = []
    let finalContent = ''
    let goalReached = false
    let iterations = 0

    const { workingDirectory, agentsMdHint, memoryHint } = this.config
    this._fileBaselines = undefined

    // 三期 Phase A: 子 Agent 工具过滤
    let effectiveToolDefs = toolDefs
    if (this.config.subAgentProfile) {
      const { subAgentProfile } = this.config
      if (subAgentProfile.toolWhitelist && subAgentProfile.toolWhitelist.length > 0) {
        const whitelist = new Set(subAgentProfile.toolWhitelist)
        effectiveToolDefs = effectiveToolDefs.filter(td => whitelist.has(td.function.name))
      }
      if (subAgentProfile.toolBlacklist && subAgentProfile.toolBlacklist.length > 0) {
        const blacklist = new Set(subAgentProfile.toolBlacklist)
        effectiveToolDefs = effectiveToolDefs.filter(td => !blacklist.has(td.function.name))
      }
    }

    // 构建初始消息
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: this.buildSystemPrompt(systemPrompt, workingDirectory, agentsMdHint, memoryHint)
      },
      {
        role: 'user',
        content: taskContext
          ? `## 总目标\n${goal}\n\n## 你的任务\n${taskContext}`
          : goal
      }
    ]

    // 自主执行循环
    let aborted = false
    for (let round = 0; round < this.config.maxIterations; round++) {
      iterations = round + 1

      // 检查外部中止信号
      if (abortSignal?.aborted) {
        aborted = true
        this.emit({ type: 'complete', data: { round: round + 1, aborted: true } })
        break
      }

      this.emit({ type: 'executing', data: { round: round + 1, maxRounds: this.config.maxIterations } })

      const pendingToolCalls: ToolCall[] = []

      // 调用 LLM（带工具）
      const content = await provider.chatStreamWithTools(
        messages,
        (text) => {
          // 流式更新
          finalContent = text
          onContent(text)
        },
        (tcs) => {
          pendingToolCalls.push(...tcs)
        },
        { tools: effectiveToolDefs.length > 0 ? effectiveToolDefs : undefined }
      )

      if (content) {
        finalContent = content
      }

      // 检查目标达成信号
      if (this.detectGoalReached(content)) {
        goalReached = true
        this.emit({ type: 'goal-reached', data: { round: round + 1 } })
        break
      }

      // 如果没有工具调用，这是最终回复
      if (pendingToolCalls.length === 0) {
        this.emit({ type: 'complete', data: { round: round + 1 } })
        break
      }

      // 将 assistant 消息加入历史
      messages.push({
        role: 'assistant',
        content: content || '',
        tool_calls: pendingToolCalls
      })

      // 执行每个工具调用
      for (const tc of pendingToolCalls) {
        // 每次工具执行前检查中止信号
        if (abortSignal?.aborted) {
          aborted = true
          break
        }

        // 路径解析：工作目录自动拼接
        this.resolveToolPaths(tc, workingDirectory)

        this.emit({
          type: 'tool-call',
          data: { functionName: tc.function.name, status: 'executing' }
        })

        // 危险命令审批
        if (onBeforeToolExecute) {
          const approved = await onBeforeToolExecute(tc)
          if (!approved) {
            const rejectResult: ToolCallResult = {
              toolCallId: tc.id,
              functionName: tc.function.name,
              arguments: {},
              result: { success: false, error: '用户拒绝执行该危险命令' },
              status: 'error',
              duration: 0,
              error: '用户拒绝执行危险命令'
            }
            allToolCalls.push(rejectResult)
            messages.push({
              role: 'tool',
              content: JSON.stringify({ success: false, error: '用户拒绝执行该危险命令。请调整方案或使用其他命令。' }),
              tool_call_id: tc.id,
              name: tc.function.name
            })
            continue
          }
        }

        // write_file / search_replace 之前读取旧内容（用于 diff + 基线）
        let preWriteOldContent: string | null = null
        let preWriteSha256: string | undefined
        if (tc.function.name === 'write_file' || tc.function.name === 'search_replace') {
          try {
            const args = JSON.parse(tc.function.arguments)
            if (args.path && window.electronAPI?.readFile) {
              const readResult = await window.electronAPI.readFile(args.path)
              if (readResult.success) {
                preWriteOldContent = readResult.content || ''
                preWriteSha256 = readResult.sha256
              }
            }
          } catch { /* 忽略 */ }
        }

        // P0: 运行时只读授权——在执行前拦截写工具调用
        if (this.config.readOnly && WRITE_TOOLS.has(tc.function.name)) {
          allToolCalls.push({
            toolCallId: tc.id, functionName: tc.function.name, arguments: {},
            result: { success: false, error: '只读节点不允许调用写工具' },
            status: 'error', duration: 0, error: '只读权限拦截'
          })
          messages.push({
            role: 'tool',
            content: JSON.stringify({ success: false, error: '当前任务为只读模式，不允许执行写操作。请改用分析/调研方式完成任务。' }),
            tool_call_id: tc.id, name: tc.function.name
          })
          continue
        }

        // P1: 执行前原子预留预算额度
        if (onToolCall) {
          const reserved = onToolCall()
          if (reserved === false) {
            // 预算耗尽：不执行工具，直接中止
            allToolCalls.push({
              toolCallId: tc.id, functionName: tc.function.name, arguments: {},
              result: { success: false, error: '工具调用预算已耗尽' },
              status: 'error', duration: 0, error: '预算耗尽'
            })
            aborted = true
            this.emit({ type: 'complete', data: { round: round + 1, reason: 'budget_exhausted' } })
            break
          }
        }

        // 执行工具
        const result = await toolExecutor.execute(tc)
        allToolCalls.push(result)

        // P1-A: 写后失效索引
        if (['write_file', 'search_replace', 'create_directory', 'git_operation'].includes(tc.function.name) && result.status === 'success' && workingDirectory) {
          invalidateIndexOnWrite(workingDirectory)
        }

        // write_file / search_replace 之后捕获 diff + 文件基线
        if ((tc.function.name === 'write_file' || tc.function.name === 'search_replace') && result.status === 'success') {
          try {
            const args = JSON.parse(tc.function.arguments)
            let newContent = args.content || ''
            let newSha256: string | undefined
            // search_replace: 读取写入后的文件内容
            if (tc.function.name === 'search_replace' && window.electronAPI?.readFile) {
              const postRead = await window.electronAPI.readFile(args.path)
              if (postRead.success) {
                newContent = postRead.content || ''
                newSha256 = postRead.sha256
              }
            }
            // write_file: 从结果中获取 sha256
            if (tc.function.name === 'write_file' && (result.result as any)?.sha256) {
              newSha256 = (result.result as any).sha256
            }
            ;(result as any).diffData = {
              filePath: args.path || '',
              oldContent: preWriteOldContent || '',
              newContent,
              isNew: preWriteOldContent === null
            }
            // P1-C: 记录文件基线（用于恢复校验）
            if (args.path && newSha256) {
              if (!this._fileBaselines) this._fileBaselines = {}
              const existing = this._fileBaselines[args.path]
              if (existing) {
                // 多次修改同一文件：更新 afterSha256
                existing.afterSha256 = newSha256
              } else {
                // 首次写入：记录 before 和 after + 原始内容（用于撤销恢复）
                this._fileBaselines[args.path] = {
                  beforeSha256: preWriteSha256 || (preWriteOldContent !== null ? 'unknown' : 'unknown'),
                  afterSha256: newSha256,
                  originalContent: preWriteOldContent !== null ? preWriteOldContent : undefined
                }
              }
            }
          } catch { /* 忽略 */ }
        }

        // 将工具结果加入消息历史
        messages.push({
          role: 'tool',
          content: typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result, null, 2),
          tool_call_id: tc.id,
          name: tc.function.name
        })
      }

      // 验证提示注入
      if (this.config.verifyAfterEachRound && round < this.config.maxIterations - 1) {
        this.emit({ type: 'verifying', data: { round: round + 1 } })
        messages.push({
          role: 'user',
          content: '请检查刚才工具调用的执行结果。如果一切正常，继续下一步。如果有错误或失败，分析原因并修正后重试。如果目标已全部完成，输出最终总结。'
        })
      }

      // 上下文压缩（防止超长对话）
      if (round < this.config.maxIterations - 1) {
        await this.compressIfNeeded(messages, goal)
      }

      // 检查点回调
      if (onCheckpoint) {
        // 计算最近 5 次工具调用指纹
        const recentFps = allToolCalls.slice(-5).map(tc => {
          const normArgs = JSON.stringify(tc.arguments, Object.keys(tc.arguments || {}).sort())
          return `${tc.functionName}:${normArgs}`
        })

        // 计算最后有效进展时间（成功的写操作/编译/测试）
        const progressTools = ['write_file', 'search_replace', 'execute_command', 'run_tests', 'git_operation']
        let lastProgress = startTime
        for (let i = allToolCalls.length - 1; i >= 0; i--) {
          if (allToolCalls[i].status === 'success' && progressTools.includes(allToolCalls[i].functionName)) {
            lastProgress = startTime + allToolCalls.slice(0, i + 1).reduce((sum, tc) => sum + tc.duration, 0)
            break
          }
        }

        // 工具证据摘要
        const evidenceLines = allToolCalls.slice(-3).map(tc => {
          const status = tc.status === 'success' ? '✅' : '❌'
          return `${status} ${tc.functionName}`
        }).join('; ')

        onCheckpoint({
          round: round + 1,
          toolCallsCount: allToolCalls.length,
          goalReached,
          aborted,
          lastContent: finalContent,
          recentToolFingerprints: recentFps,
          lastProgressAt: lastProgress,
          evidenceSummary: evidenceLines
        })
      }

      // 如果已中止，跳出主循环
      if (aborted) break

      this.emit({ type: 'iterating', data: { nextRound: round + 2 } })
    }

    // 清理最终内容中的目标达成标记
    finalContent = finalContent.replace(/^\[GOAL_REACHED\]\s*/m, '').trim()

    const duration = Date.now() - startTime

    // P0-B/C: 验收 + 有界修复循环
    let acceptance: AcceptancePlan | undefined
    let repairsUsed = 0
    if (workingDirectory) {
      const cmdExecutor: CommandExecutor = {
        execute: async (cmd: string, cwd?: string, timeoutMs?: number) => {
          if (window.electronAPI?.executeCommand) {
            const result = await window.electronAPI.executeCommand({
              command: cmd,
              cwd: cwd || workingDirectory,
              timeout: timeoutMs || 120000
            })
            return {
              exitCode: result.exitCode ?? (result.success ? 0 : 1),
              stdout: result.stdout || '',
              stderr: result.stderr || '',
              timedOut: result.timedOut || false
            }
          }
          return { exitCode: 1, stdout: '', stderr: '无命令执行能力', timedOut: false }
        }
      }

      // 初始验收
      const changedFiles = collectChangedFiles(allToolCalls)
      if (changedFiles.length > 0) {
        try {
          acceptance = await runAcceptance(workingDirectory, changedFiles, cmdExecutor)
        } catch {
          acceptance = { checks: [], overallState: 'unverified' }
        }

        // P0-C: 有界修复循环
        const repairConfig: Required<RepairConfig> = { ...DEFAULT_REPAIR_CONFIG }
        let prevAcceptance: AcceptancePlan | undefined

        while (
          acceptance &&
          acceptance.overallState === 'failed' &&
          repairsUsed < repairConfig.maxRepairs &&
          iterations < this.config.maxIterations + repairConfig.maxRepairs &&
          !abortSignal?.aborted
        ) {
          // 检查新证据
          if (repairConfig.requireNewEvidence && prevAcceptance && !hasNewEvidence(prevAcceptance, acceptance)) {
            break // 无新证据，停止修复
          }

          prevAcceptance = acceptance
          repairsUsed++

          // 注入诊断信息
          const diagnostics = extractRepairDiagnostics(acceptance)
          messages.push({
            role: 'user',
            content: `\u7b2c ${repairsUsed} \u6b21\u9a8c\u6536\u672a\u901a\u8fc7\uff0c\u8bf7\u4fee\u590d\u4ee5\u4e0a\u95ee\u9898\u540e\u91cd\u65b0\u63d0\u4ea4\u3002${diagnostics}`
          })

          // 重新执行一轮
          const repairToolCalls: ToolCall[] = []
          const repairContent = await provider.chatStreamWithTools(
            messages,
            (text) => { finalContent = text; onContent(text) },
            (tcs) => { repairToolCalls.push(...tcs) },
            { tools: effectiveToolDefs.length > 0 ? effectiveToolDefs : undefined }
          )
          if (repairContent) finalContent = repairContent

          if (repairToolCalls.length === 0) break

          messages.push({ role: 'assistant', content: repairContent || '', tool_calls: repairToolCalls })

          // 执行修复工具调用（接入与主循环相同的执行保护）
          for (const tc of repairToolCalls) {
            if (abortSignal?.aborted) break
            this.resolveToolPaths(tc, workingDirectory)

            // P0-fix: 只读权限拦截
            if (this.config.readOnly && WRITE_TOOLS.has(tc.function.name)) {
              allToolCalls.push({
                toolCallId: tc.id, functionName: tc.function.name, arguments: {},
                result: { success: false, error: '只读节点不允许调用写工具' },
                status: 'error', duration: 0, error: '只读权限拦截'
              })
              messages.push({
                role: 'tool',
                content: JSON.stringify({ success: false, error: '修复轮次中当前为只读模式，不允许执行写操作。' }),
                tool_call_id: tc.id, name: tc.function.name
              })
              continue
            }

            // P0-fix: 危险命令审批
            if (onBeforeToolExecute) {
              const approved = await onBeforeToolExecute(tc)
              if (!approved) {
                allToolCalls.push({
                  toolCallId: tc.id, functionName: tc.function.name, arguments: {},
                  result: { success: false, error: '用户拒绝执行该危险命令' },
                  status: 'error', duration: 0, error: '用户拒绝执行危险命令'
                })
                messages.push({
                  role: 'tool',
                  content: JSON.stringify({ success: false, error: '用户拒绝执行危险命令。请调整方案。' }),
                  tool_call_id: tc.id, name: tc.function.name
                })
                continue
              }
            }

            // P0-fix: 预算检查
            if (onToolCall) {
              const reserved = onToolCall()
              if (reserved === false) {
                allToolCalls.push({
                  toolCallId: tc.id, functionName: tc.function.name, arguments: {},
                  result: { success: false, error: '工具调用预算已耗尽' },
                  status: 'error', duration: 0, error: '预算耗尽'
                })
                aborted = true
                break
              }
            }

            // P0-fix: 写前读取旧内容（用于 diff + 基线，与主循环一致）
            let repairPreWriteOldContent: string | null = null
            let repairPreWriteSha256: string | undefined
            if (tc.function.name === 'write_file' || tc.function.name === 'search_replace') {
              try {
                const args = JSON.parse(tc.function.arguments)
                if (args.path && window.electronAPI?.readFile) {
                  const readResult = await window.electronAPI.readFile(args.path)
                  if (readResult.success) {
                    repairPreWriteOldContent = readResult.content || ''
                    repairPreWriteSha256 = readResult.sha256
                  }
                }
              } catch { /* 忽略 */ }
            }

            const result = await toolExecutor.execute(tc)
            allToolCalls.push(result)

            // P0-fix: 修复轮次写后捕获 diff + 文件基线（与主循环一致）
            if ((tc.function.name === 'write_file' || tc.function.name === 'search_replace') && result.status === 'success') {
              try {
                const args = JSON.parse(tc.function.arguments)
                let newContent = args.content || ''
                let newSha256: string | undefined
                if (tc.function.name === 'search_replace' && window.electronAPI?.readFile) {
                  const postRead = await window.electronAPI.readFile(args.path)
                  if (postRead.success) {
                    newContent = postRead.content || ''
                    newSha256 = postRead.sha256
                  }
                }
                if (tc.function.name === 'write_file' && (result.result as any)?.sha256) {
                  newSha256 = (result.result as any).sha256
                }
                ;(result as any).diffData = {
                  filePath: args.path || '',
                  oldContent: repairPreWriteOldContent || '',
                  newContent,
                  isNew: repairPreWriteOldContent === null
                }
                if (args.path && newSha256) {
                  if (!this._fileBaselines) this._fileBaselines = {}
                  const existing = this._fileBaselines[args.path]
                  if (existing) {
                    existing.afterSha256 = newSha256
                  } else {
                    this._fileBaselines[args.path] = {
                      beforeSha256: repairPreWriteSha256 || 'unknown',
                      afterSha256: newSha256,
                      originalContent: repairPreWriteOldContent !== null ? repairPreWriteOldContent : undefined
                    }
                  }
                }
              } catch { /* 忽略 */ }
            }

            messages.push({
              role: 'tool',
              content: typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2),
              tool_call_id: tc.id,
              name: tc.function.name
            })
          }

          iterations++

          // 重新验收
          const newChangedFiles = collectChangedFiles(allToolCalls)
          try {
            acceptance = await runAcceptance(workingDirectory, newChangedFiles, cmdExecutor)
          } catch {
            acceptance = { checks: [], overallState: 'unverified' }
          }
        }
      }
    }

    // ── Phase 2: 测试循环 ──
    let testLoopResult: TestLoopResult | undefined
    if (workingDirectory && goalReached && !aborted) {
      const changedFilesForTest = collectChangedFiles(allToolCalls)
      if (changedFilesForTest.length > 0) {
        const testCmdExecutor: CommandExecutor = {
          execute: async (cmd: string, cwd?: string, timeoutMs?: number) => {
            if (window.electronAPI?.executeCommand) {
              const r = await window.electronAPI.executeCommand({
                command: cmd,
                cwd: cwd || workingDirectory,
                timeout: timeoutMs || 120000
              })
              return {
                exitCode: r.exitCode ?? (r.success ? 0 : 1),
                stdout: r.stdout || '',
                stderr: r.stderr || '',
                timedOut: r.timedOut || false
              }
            }
            return { exitCode: 1, stdout: '', stderr: '无命令执行能力', timedOut: false }
          }
        }

        const testLoop = new TestLoopEngine({
          workingDirectory,
          maxRounds: 3,
          agentsMdHint: this.config.agentsMdHint
        })

        this.emit({ type: 'verifying', data: { phase: 'test-loop' } })

        try {
          testLoopResult = await testLoop.execute({
            provider,
            systemPrompt: this.buildSystemPrompt(
              '你是一个代码修复专家。请分析测试失败的原因并修复代码。',
              workingDirectory,
              this.config.agentsMdHint
            ),
            toolDefs,
            executor: testCmdExecutor,
            goal,
            changedFiles: changedFilesForTest,
            onBeforeToolExecute,
            onContent,
            abortSignal,
            onToolCall
          })

          // 测试循环中的工具调用计入总记录
          if (testLoopResult.fixToolCalls.length > 0) {
            allToolCalls.push(...testLoopResult.fixToolCalls)
          }

          // P1-fix: 合并测试循环的文件基线
          if (testLoopResult.fileBaselines) {
            if (!this._fileBaselines) this._fileBaselines = {}
            for (const [path, baseline] of Object.entries(testLoopResult.fileBaselines)) {
              if (!this._fileBaselines[path]) {
                this._fileBaselines[path] = {
                  beforeSha256: baseline.beforeSha256,
                  afterSha256: baseline.afterSha256,
                  originalContent: baseline.originalContent
                }
              } else {
                this._fileBaselines[path].afterSha256 = baseline.afterSha256
              }
            }
          }

          // P0-fix: 测试失败则回滚 goalReached，确保最终验收反映真实状态
          if (!testLoopResult.passed) {
            goalReached = false
          }
        } catch (e) {
          // P1-fix: 测试循环异常也应回滚 goalReached
          console.error('[AutonomousEngine] 测试循环异常:', e)
          goalReached = false
        }
      }
    }

    // ── Phase 4: Lint 自动修复 ──
    let lintFixResult: LintFixResult | undefined
    if (workingDirectory && goalReached && !aborted) {
      const changedFilesForLint = collectChangedFiles(allToolCalls)
      if (changedFilesForLint.length > 0) {
        const lintCmdExecutor: CommandExecutor = {
          execute: async (cmd: string, cwd?: string, timeoutMs?: number) => {
            if (window.electronAPI?.executeCommand) {
              const r = await window.electronAPI.executeCommand({
                command: cmd,
                cwd: cwd || workingDirectory,
                timeout: timeoutMs || 60000
              })
              return {
                exitCode: r.exitCode ?? (r.success ? 0 : 1),
                stdout: r.stdout || '',
                stderr: r.stderr || '',
                timedOut: r.timedOut || false
              }
            }
            return { exitCode: 1, stdout: '', stderr: '无命令执行能力', timedOut: false }
          },
          // P1-fix: 接入 readFile，统一哈希读取路径（与恢复校验同一读取接口）
          readFile: async (path: string) => {
            if (window.electronAPI?.readFile) {
              const r = await window.electronAPI.readFile(path)
              return { success: r?.success ?? false, content: r?.content, sha256: r?.sha256 }
            }
            return { success: false }
          },
          // P1-fix: 接入 writeFile，用于安全传入 commit message 等
          writeFile: async (path: string, content: string) => {
            if (window.electronAPI?.writeFile) {
              const r = await window.electronAPI.writeFile(path, content)
              return { success: r?.success ?? false }
            }
            return { success: false }
          }
        }

        const lintFix = new LintFixEngine({
          workingDirectory,
          maxRounds: 2
        })

        this.emit({ type: 'verifying', data: { phase: 'lint-fix' } })

        try {
          lintFixResult = await lintFix.execute({
            provider,
            systemPrompt: this.buildSystemPrompt(
              '你是一个代码质量修复专家。请分析 lint 输出并修复代码问题。',
              workingDirectory,
              this.config.agentsMdHint
            ),
            toolDefs,
            executor: lintCmdExecutor,
            changedFiles: changedFilesForLint,
            onBeforeToolExecute,
            onContent,
            abortSignal,
            onToolCall
          })

          if (lintFixResult.fixToolCalls.length > 0) {
            allToolCalls.push(...lintFixResult.fixToolCalls)
          }

          // P1-fix: 合并 Lint 修复循环的文件基线
          if (lintFixResult.fileBaselines) {
            if (!this._fileBaselines) this._fileBaselines = {}
            for (const [path, baseline] of Object.entries(lintFixResult.fileBaselines)) {
              if (!this._fileBaselines[path]) {
                this._fileBaselines[path] = {
                  beforeSha256: baseline.beforeSha256,
                  afterSha256: baseline.afterSha256,
                  originalContent: baseline.originalContent
                }
              } else {
                this._fileBaselines[path].afterSha256 = baseline.afterSha256
              }
            }
          }

          // P0-fix: Lint 修复改动了代码（LLM 工具调用或 --fix 命令）→ 必须重跑测试
          const lintModifiedCode = lintFixResult.fixToolCalls.length > 0 || lintFixResult.fixCommandModifiedFiles
          if (lintModifiedCode && testLoopResult?.passed) {
            const changedFilesAfterLint = collectChangedFiles(allToolCalls)
            if (changedFilesAfterLint.length > 0) {
              const reTestCmdExecutor: CommandExecutor = {
                execute: async (cmd: string, cwd?: string, timeoutMs?: number) => {
                  if (window.electronAPI?.executeCommand) {
                    const r = await window.electronAPI.executeCommand({
                      command: cmd,
                      cwd: cwd || workingDirectory,
                      timeout: timeoutMs || 120000
                    })
                    return {
                      exitCode: r.exitCode ?? (r.success ? 0 : 1),
                      stdout: r.stdout || '',
                      stderr: r.stderr || '',
                      timedOut: r.timedOut || false
                    }
                  }
                  return { exitCode: 1, stdout: '', stderr: '无命令执行能力', timedOut: false }
                },
                // P1-fix: 接入 readFile，统一哈希读取路径
                readFile: async (path: string) => {
                  if (window.electronAPI?.readFile) {
                    const r = await window.electronAPI.readFile(path)
                    return { success: r?.success ?? false, content: r?.content, sha256: r?.sha256 }
                  }
                  return { success: false }
                },
                writeFile: async (path: string, content: string) => {
                  if (window.electronAPI?.writeFile) {
                    const r = await window.electronAPI.writeFile(path, content)
                    return { success: r?.success ?? false }
                  }
                  return { success: false }
                }
              }

              const reTestLoop = new TestLoopEngine({
                workingDirectory,
                maxRounds: 2,
                agentsMdHint: this.config.agentsMdHint,
                testCommand: testLoopResult.testCommand !== 'none' ? testLoopResult.testCommand : undefined
              })

              this.emit({ type: 'verifying', data: { phase: 'test-loop-recheck' } })

              try {
                const reTestResult = await reTestLoop.execute({
                  provider,
                  systemPrompt: this.buildSystemPrompt(
                    '你是一个代码修复专家。Lint 修复后测试失败，请分析并修复。',
                    workingDirectory,
                    this.config.agentsMdHint
                  ),
                  toolDefs,
                  executor: reTestCmdExecutor,
                  goal,
                  changedFiles: changedFilesAfterLint,
                  onBeforeToolExecute,
                  onContent,
                  abortSignal,
                  onToolCall
                })

                if (reTestResult.fixToolCalls.length > 0) {
                  allToolCalls.push(...reTestResult.fixToolCalls)
                }

                // 重跑测试失败则回滚 goalReached
                if (!reTestResult.passed) {
                  goalReached = false
                }

                // 合并测试结果
                testLoopResult = {
                  ...testLoopResult,
                  passed: reTestResult.passed,
                  totalRounds: testLoopResult.totalRounds + reTestResult.totalRounds,
                  rounds: [...testLoopResult.rounds, ...reTestResult.rounds],
                  fixToolCalls: [...testLoopResult.fixToolCalls, ...reTestResult.fixToolCalls],
                  duration: testLoopResult.duration + reTestResult.duration
                }

                // P1-fix: 合并 reTestResult 的文件基线
                if (reTestResult.fileBaselines) {
                  if (!this._fileBaselines) this._fileBaselines = {}
                  for (const [path, baseline] of Object.entries(reTestResult.fileBaselines)) {
                    if (!this._fileBaselines[path]) {
                      this._fileBaselines[path] = {
                        beforeSha256: baseline.beforeSha256,
                        afterSha256: baseline.afterSha256,
                        originalContent: baseline.originalContent
                      }
                    } else {
                      this._fileBaselines[path].afterSha256 = baseline.afterSha256
                    }
                  }
                }
              } catch (e) {
                // P1-fix: 重跑测试异常也应回滚 goalReached
                console.error('[AutonomousEngine] Lint 后重跑测试异常:', e)
                goalReached = false
              }
            }
          }

          // P0-fix: Lint 失败（仍有问题）也回滚 goalReached
          // 但“未检测到 lint 工具”不算失败，不影响 goalReached
          if (!lintFixResult.passed && lintFixResult.lintCommand !== 'none') {
            goalReached = false
          }
        } catch (e) {
          // P1-fix: Lint 修复异常也应回滚 goalReached
          console.error('[AutonomousEngine] Lint 修复异常:', e)
          goalReached = false
        }
      }
    }

    // P0-fix: 测试/Lint 循环后重新验收，确保 acceptance 反映最终状态
    if (workingDirectory && (testLoopResult || lintFixResult)) {
      const finalChangedFiles = collectChangedFiles(allToolCalls)
      if (finalChangedFiles.length > 0) {
        const reAcceptanceExecutor: CommandExecutor = {
          execute: async (cmd: string, cwd?: string, timeoutMs?: number) => {
            if (window.electronAPI?.executeCommand) {
              const r = await window.electronAPI.executeCommand({
                command: cmd,
                cwd: cwd || workingDirectory,
                timeout: timeoutMs || 120000
              })
              return {
                exitCode: r.exitCode ?? (r.success ? 0 : 1),
                stdout: r.stdout || '',
                stderr: r.stderr || '',
                timedOut: r.timedOut || false
              }
            }
            return { exitCode: 1, stdout: '', stderr: '无命令执行能力', timedOut: false }
          }
        }
        try {
          acceptance = await runAcceptance(workingDirectory, finalChangedFiles, reAcceptanceExecutor)
        } catch {
          acceptance = { checks: [], overallState: 'unverified' }
        }
      }
    }

    return {
      content: finalContent,
      toolCalls: allToolCalls,
      iterations,
      goalReached,
      duration,
      aborted: aborted || undefined,
      acceptance,
      fileBaselines: this._fileBaselines,
      testLoop: testLoopResult,
      lintFix: lintFixResult
    }
  }

  /**
   * 构建系统提示词（角色提示词 + 自主执行协议）
   */
  private buildSystemPrompt(
    basePrompt: string,
    workingDirectory?: string,
    agentsMdHint?: string,
    memoryHint?: string
  ): string {
    let prompt = basePrompt + AUTONOMOUS_PROMPT_SUFFIX

    // 如果工作目录存在，追加开发规范
    if (workingDirectory) {
      prompt += AUTONOMOUS_DEV_PROMPT_SUFFIX
      prompt += `\n\n项目工作目录: ${workingDirectory}\n创建文件时请使用相对路径。`
    }

    if (agentsMdHint) prompt += agentsMdHint
    if (memoryHint) prompt += memoryHint

    // 三期 Phase A: 子 Agent 提示词追加
    if (this.config.subAgentProfile) {
      prompt += `\n\n${this.config.subAgentProfile.systemPromptAddon}`
      if (this.config.subAgentProfile.outputFormat) {
        prompt += `\n\n### 输出格式要求\n${this.config.subAgentProfile.outputFormat}`
      }
    }

    return prompt
  }

  /**
   * 检测目标达成信号
   */
  private detectGoalReached(content: string): boolean {
    return /\[GOAL_REACHED\]/.test(content)
  }

  /**
   * 解析工具路径（相对路径 → 绝对路径）
   */
  private resolveToolPaths(tc: ToolCall, workingDirectory?: string): void {
    if (!workingDirectory) return

    const pathTools = ['write_file', 'search_replace', 'create_directory', 'read_file', 'read_directory', 'read_document', 'search_code']
    if (pathTools.includes(tc.function.name)) {
      try {
        const args = JSON.parse(tc.function.arguments)
        const pathKey = tc.function.name === 'search_code' ? 'directory' : 'path'
        if (args[pathKey] && !this.isAbsolutePath(args[pathKey])) {
          args[pathKey] = this.joinPath(workingDirectory, args[pathKey])
          tc.function.arguments = JSON.stringify(args)
        }
      } catch { /* 忽略 */ }
    }

    // execute_command / git_operation / run_tests: 注入 cwd
    const cwdTools = ['execute_command', 'git_operation', 'run_tests']
    if (cwdTools.includes(tc.function.name)) {
      try {
        const args = JSON.parse(tc.function.arguments)
        if (!args.cwd) {
          args.cwd = workingDirectory
          tc.function.arguments = JSON.stringify(args)
        }
      } catch { /* 忽略 */ }
    }
  }

  /**
   * 上下文压缩（R8：通过 ContextManager 按模型容量管理）
   */
  private async compressIfNeeded(messages: ChatMessage[], taskGoal?: string): Promise<void> {
    const ctxMgr = new ContextManager(this.config.modelId || 'unknown')
    const ctxMessages = messages.map(m => ({ role: m.role as 'system' | 'user' | 'assistant', content: typeof m.content === 'string' ? m.content : '' }))
    if (ctxMgr.exceedsContextLimit(ctxMessages)) {
      const summaryProvider = this.getSummaryProvider()
      if (!summaryProvider) {
        // 无摘要模型但上下文超限 → 终止执行
        throw new Error('上下文已超模型容量但未配置摘要模型，无法压缩。建议开启新会话。')
      }
      let compressed
      try {
        compressed = await compressContext(messages, summaryProvider, ctxMgr.getAvailableChars(), undefined, taskGoal, `auto-${Date.now()}`)
      } catch (e) {
        // 压缩过程出错 → 终止执行（上下文已超限，不能继续）
        const errMsg = e instanceof Error ? e.message : String(e)
        throw new Error(`上下文压缩失败: ${errMsg}。上下文已超模型容量，建议开启新会话。`)
      }
      // safe 检查：不安全时抛错，向上传播终止执行
      if (!compressed.safe) {
        throw new Error(compressed.warning || '上下文无法安全压缩，建议开启新会话')
      }
      messages.splice(0, messages.length, ...compressed.messages)
    }
  }

  // ============ 工具方法 ============

  private isAbsolutePath(p: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')
  }

  private joinPath(base: string, relative: string): string {
    const sep = base.includes('\\') ? '\\' : '/'
    const baseTrimmed = base.replace(/[\\/]+$/, '')
    const relTrimmed = relative.replace(/^[\\/]+/, '')
    return `${baseTrimmed}${sep}${relTrimmed}`
  }
}

/** 全局自主执行引擎单例 */
export const autonomousEngine = new AutonomousEngine()

/**
 * 生成附加了自主执行协议的系统提示词
 * 可被任何地方调用来增强角色的提示词
 */
export function enhanceWithAutonomousPrompt(
  basePrompt: string,
  options?: { workingDirectory?: string; isDev?: boolean }
): string {
  let enhanced = basePrompt + AUTONOMOUS_PROMPT_SUFFIX
  if (options?.isDev || options?.workingDirectory) {
    enhanced += AUTONOMOUS_DEV_PROMPT_SUFFIX
  }
  if (options?.workingDirectory) {
    enhanced += `\n\n项目工作目录: ${options.workingDirectory}\n创建文件时请使用相对路径。`
  }
  return enhanced
}
