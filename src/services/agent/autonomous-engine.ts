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
import { compressContext, getCompressThreshold, countMessageChars } from './context-compressor'

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
  /** 总 Token 消耗（估算） */
  tokenEstimate?: {
    promptTokens: number
    completionTokens: number
  }
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
    const summaryId = localStorage.getItem('summary_model_id')
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
  }): Promise<AutonomousResult> {
    const { provider, systemPrompt, goal, taskContext, toolDefs, onContent, onBeforeToolExecute } = params
    const startTime = Date.now()
    const allToolCalls: ToolCallResult[] = []
    let finalContent = ''
    let goalReached = false
    let iterations = 0

    const { workingDirectory, agentsMdHint, memoryHint } = this.config

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
    for (let round = 0; round < this.config.maxIterations; round++) {
      iterations = round + 1

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
        { tools: toolDefs.length > 0 ? toolDefs : undefined }
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

        // write_file 之前读取旧内容（用于 diff）
        let preWriteOldContent: string | null = null
        if (tc.function.name === 'write_file') {
          try {
            const args = JSON.parse(tc.function.arguments)
            if (args.path && window.electronAPI?.readFile) {
              const readResult = await window.electronAPI.readFile(args.path)
              if (readResult.success) preWriteOldContent = readResult.content || ''
            }
          } catch { /* 忽略 */ }
        }

        // 执行工具
        const result = await toolExecutor.execute(tc)
        allToolCalls.push(result)

        // write_file 之后捕获 diff
        if (tc.function.name === 'write_file' && result.status === 'success') {
          try {
            const args = JSON.parse(tc.function.arguments)
            ;(result as any).diffData = {
              filePath: args.path || '',
              oldContent: preWriteOldContent || '',
              newContent: args.content || '',
              isNew: preWriteOldContent === null
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
        await this.compressIfNeeded(messages)
      }

      this.emit({ type: 'iterating', data: { nextRound: round + 2 } })
    }

    // 清理最终内容中的目标达成标记
    finalContent = finalContent.replace(/^\[GOAL_REACHED\]\s*/m, '').trim()

    const duration = Date.now() - startTime

    return {
      content: finalContent,
      toolCalls: allToolCalls,
      iterations,
      goalReached,
      duration
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

    const pathTools = ['write_file', 'create_directory', 'read_file', 'read_directory', 'read_document', 'search_code']
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
   * 上下文压缩
   */
  private async compressIfNeeded(messages: ChatMessage[]): Promise<void> {
    const threshold = getCompressThreshold()
    const totalChars = countMessageChars(messages)
    if (totalChars > threshold) {
      const summaryProvider = this.getSummaryProvider()
      if (summaryProvider) {
        try {
          const compressed = await compressContext(messages, summaryProvider, threshold)
          messages.splice(0, messages.length, ...compressed)
        } catch (e) {
          console.warn('[AutonomousEngine] 上下文压缩失败:', e)
        }
      }
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
