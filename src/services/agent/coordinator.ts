/**
 * Coordinator Agent — 多 Agent 协作编排器
 *
 * 丞相作为 Coordinator（协调者），负责：
 * 1. 分析议题，拆解为子任务
 * 2. 将子任务分配给对应的 Worker Agent（大臣）
 * 3. 各 Worker 带工具执行子任务
 * 4. 丞相汇总所有结果，生成综合建议
 *
 * 流程：
 *   用户议题 → 丞相拆解 → Workers 执行（带工具）→ 丞相汇总 → 输出
 */

import type { Minister, ChatMessage, ToolCall, ToolCallResult, LLMConfig, Speech } from '@/types'
import type { LLMProvider } from '@/services/llm/types'
import { createProvider } from '@/services/llm'
import { llmService } from '@/services/llm-config'
import { compressContext, getCompressThreshold, countMessageChars } from './context-compressor'
import { memoryStore } from '@/services/memory'
import { skillRegistry } from '@/services/skills'
import { toolExecutor } from '@/services/tools/executor'
import { findPresetById, getCurrentDynastyId } from '@/services/dynasty-presets'
import { AutonomousEngine } from './autonomous-engine'
import type { AutonomousEvent } from './autonomous-engine'

// ============ 类型定义 ============

/** 子任务分配 */
export interface WorkerTask {
  ministerId: string   // 执行者 ID
  task: string         // 子任务描述
  context?: string     // 补充上下文
}

/** 任务拆解结果 */
export interface TaskDecomposition {
  plan: string          // 丞相的分析计划
  tasks: WorkerTask[]   // 子任务列表
}

/** Worker 执行结果 */
export interface WorkerResult {
  ministerId: string
  ministerName: string
  task: string
  content: string
  toolCalls: ToolCallResult[]
  duration: number
  status: 'success' | 'error'
}

/** Agent 模式进度事件 */
export type AgentEventType =
  | 'start'           // 开始
  | 'decomposing'     // 丞相分析中
  | 'plan-ready'      // 拆解完成
  | 'worker-start'    // Worker 开始
  | 'worker-progress' // Worker 输出中
  | 'worker-tool'     // Worker 调用工具
  | 'worker-done'     // Worker 完成
  | 'worker-autonomous' // Worker 自主执行子事件
  | 'synthesizing'    // 丞相汇总中
  | 'complete'        // 全部完成
  | 'error'           // 出错

export interface AgentEvent {
  type: AgentEventType
  ministerId?: string
  data?: any
}

type AgentEventCallback = (event: AgentEvent) => void

/** 最大工具调用轮数（防止无限循环） */
const MAX_TOOL_ROUNDS = 3

/** Agent 编排器配置 */
export interface CoordinatorConfig {
  /** 是否启用 Agent 模式 */
  enabled: boolean
  /** 丞相是否做最终汇总 */
  synthesize: boolean
  /** Worker 执行失败时是否继续 */
  continueOnError: boolean
  /** 是否启用 Plan Mode（拆解后等待用户确认） */
  planMode: boolean
  /** 是否启用自主执行模式（Worker 可自主迭代：执行→验证→修正） */
  autonomousMode: boolean
  /** 自主执行模式下的最大迭代轮数（默认 10） */
  autonomousMaxIterations: number
}

const DEFAULT_CONFIG: CoordinatorConfig = {
  enabled: true,
  synthesize: true,
  continueOnError: true,
  planMode: false,
  autonomousMode: false,
  autonomousMaxIterations: 10
}

// ============ Coordinator Agent ============

export class CoordinatorAgent {
  private config: CoordinatorConfig
  private listeners: AgentEventCallback[] = []

  constructor(config?: Partial<CoordinatorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 添加事件监听
   */
  onEvent(callback: AgentEventCallback): () => void {
    this.listeners.push(callback)
    return () => {
      this.listeners = this.listeners.filter(cb => cb !== callback)
    }
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  /**
   * 获取当前主题类别（dynasty | industry）
   */
  private getCurrentThemeCategory(): 'dynasty' | 'industry' {
    const dynastyId = getCurrentDynastyId()
    const preset = findPresetById(dynastyId)
    return preset?.category === 'industry' ? 'industry' : 'dynasty'
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
    const defaultCfg = llmService.getAll().find(c => c.isDefault) || llmService.getAll()[0]
    if (defaultCfg) return createProvider({ provider: defaultCfg.provider, model: defaultCfg.model, apiKey: defaultCfg.apiKey, baseURL: defaultCfg.baseURL })
    return null
  }

  /**
   * 读取 AGENTS.md 项目指令文件
   * 如果工作目录下存在 AGENTS.md，读取并返回其内容
   */
  private async readAgentsMd(workingDirectory?: string): Promise<string> {
    if (!workingDirectory) return ''
    try {
      if (window.electronAPI?.readFile) {
        // 尝试几种常见的文件名
        const candidates = ['AGENTS.md', 'agents.md', 'AGENT.md', 'agent.md',
                           '.agents.md', 'CLAUDE.md', 'RULES.md']
        for (const name of candidates) {
          const sep = workingDirectory.includes('\\') ? '\\' : '/'
          const filePath = `${workingDirectory.replace(/[\\/]+$/, '')}${sep}${name}`
          const result = await window.electronAPI.readFile(filePath)
          if (result.success && result.content) {
            console.log(`[Agent] 已加载项目指令文件: ${name}`)
            return result.content
          }
        }
      }
    } catch {
      // 文件不存在时静默返回
    }
    return ''
  }

  /**
   * 运行完整的 Agent 协作流程
   *
   * @param topic 议题
   * @param chancellor 丞相（coordinator）
   * @param workers Worker 大臣列表
   * @param resolveLLM 获取完整 LLM 配置的函数
   * @param addSpeech 添加发言到 session 的函数
   * @param getReactiveSpeech 获取响应式发言引用的函数
   * @param shouldContinue 检查是否应继续执行的函数
   */
  async runAgentDebate(params: {
    topic: string
    chancellor: Minister
    workers: Minister[]
    resolveLLM: (ministerLLM: LLMConfig) => LLMConfig
    addSpeech: (speech: Speech) => void
    getReactiveSpeech: (speechId: string) => Speech
    shouldContinue: () => boolean
    workingDirectory?: string
    /** Plan Mode: 拆解完成后回调，返回 true 继续执行，false 取消 */
    onPlanReady?: (plan: TaskDecomposition) => Promise<boolean>
    /** Approval Mode: 危险命令执行前回调，返回 true 批准，false 拒绝 */
    onBeforeToolExecute?: (toolCall: ToolCall) => Promise<boolean>
  }): Promise<void> {
    const { topic, chancellor, workers, resolveLLM, addSpeech, getReactiveSpeech, shouldContinue, workingDirectory, onPlanReady, onBeforeToolExecute } = params

    this.emit({ type: 'start', data: { topic, workerCount: workers.length } })

    // 读取 AGENTS.md 项目指令
    const agentsMd = await this.readAgentsMd(workingDirectory)
    const agentsMdHint = agentsMd
      ? `\n\n=== 项目指令 (AGENTS.md) ===\n${agentsMd.slice(0, 5000)}\n=== 项目指令结束 ===`
      : ''

    // 加载持久记忆
    const memorySummary = memoryStore.getContextSummary(workingDirectory, topic)
    const memoryHint = memorySummary
      ? `\n\n=== 历史记忆（跨会话持久记忆） ===\n${memorySummary}\n=== 记忆结束 ===\n重要提示：以上是你之前会话中保存的记忆，请参考这些信息来回答。如果你发现了新的重要信息，可以使用 save_memory 工具保存。`
      : ''

    // ── Phase 1: 丞相拆解任务 ──
    this.emit({ type: 'decomposing' })

    const chancellorSpeechId = `chancellor-plan-${Date.now()}`
    const planSpeech: Speech = {
      id: chancellorSpeechId,
      ministerId: chancellor.id,
      content: '',
      timestamp: Date.now(),
      status: 'streaming'
    }
    addSpeech(planSpeech)

    const reactivePlan = getReactiveSpeech(chancellorSpeechId)
    const chancellorLLM = createProvider(resolveLLM(chancellor.llm))

    let decomposition: TaskDecomposition
    try {
      decomposition = await this.decomposeTask(
        chancellorLLM,
        topic,
        workers,
        workingDirectory,
        agentsMdHint,
        memoryHint,
        (_text) => { reactivePlan.content = '📋 丞相正在分析议题...' }
      )
    } catch (error) {
      reactivePlan.content = `丞相分析失败：${error instanceof Error ? error.message : '未知错误'}`
      reactivePlan.status = 'error'
      this.emit({ type: 'error', data: { phase: 'decompose', error } })
      return
    }

    // 将原始 JSON 替换为格式化的 Markdown
    reactivePlan.content = this.formatDecomposition(decomposition, workers)
    reactivePlan.status = 'completed'
    this.emit({ type: 'plan-ready', data: decomposition })

    // Plan Mode: 等待用户确认
    if (this.config.planMode && onPlanReady) {
      const userConfirmed = await onPlanReady(decomposition)
      if (!userConfirmed) {
        this.emit({ type: 'complete', data: { cancelled: true, reason: '用户取消了执行' } })
        return
      }
    }

    if (!shouldContinue()) return

    // ── Phase 2: Workers 执行子任务 ──
    const workerResults: WorkerResult[] = []

    for (const workerTask of decomposition.tasks) {
      if (!shouldContinue()) return

      const worker = workers.find(w => w.id === workerTask.ministerId)
      if (!worker) {
        console.warn(`[Agent] Worker not found: ${workerTask.ministerId}`)
        continue
      }

      this.emit({ type: 'worker-start', ministerId: worker.id, data: workerTask })

      const workerSpeechId = `${worker.id}-agent-${Date.now()}`
      const workerSpeech: Speech = {
        id: workerSpeechId,
        ministerId: worker.id,
        content: '',
        timestamp: Date.now(),
        status: 'streaming',
        toolStatuses: []
      }
      addSpeech(workerSpeech)

      const reactiveWorker = getReactiveSpeech(workerSpeechId)
      const workerLLM = createProvider(resolveLLM(worker.llm))
      const toolDefs = skillRegistry.getToolDefinitionsForMinister(worker.id)

      const startTime = Date.now()
      try {
        let result: { content: string; toolCalls: ToolCallResult[] }

        if (this.config.autonomousMode) {
          // ── 自主执行模式：使用 AutonomousEngine ──
          const engine = new AutonomousEngine({
            maxIterations: this.config.autonomousMaxIterations,
            verifyAfterEachRound: true,
            workingDirectory,
            agentsMdHint,
            memoryHint
          })

          // 转发自主执行子事件
          engine.onEvent((evt: AutonomousEvent) => {
            this.emit({
              type: 'worker-autonomous',
              ministerId: worker.id,
              data: evt
            })
          })

          const autoResult = await engine.execute({
            provider: workerLLM,
            systemPrompt: worker.systemPrompt,
            goal: topic,
            taskContext: `${workerTask.task}${workerTask.context ? '\n补充：' + workerTask.context : ''}`,
            toolDefs,
            onContent: (text) => { reactiveWorker.content = text },
            onBeforeToolExecute
          })

          // 收集 toolStatuses 用于 UI 显示
          if (!reactiveWorker.toolStatuses) reactiveWorker.toolStatuses = []
          for (const tc of autoResult.toolCalls) {
            reactiveWorker.toolStatuses.push({
              toolCallId: tc.toolCallId,
              functionName: tc.functionName,
              status: tc.status === 'success' ? 'completed' : (tc.status === 'timeout' ? 'timeout' : 'error'),
              displayName: this.getToolDisplayName(tc.functionName),
              summary: tc.status === 'success'
                ? this.buildSummary(tc.result)
                : tc.error || '执行失败'
            })
          }

          result = { content: autoResult.content, toolCalls: autoResult.toolCalls }
        } else {
          // ── 标准模式：使用原有的 Worker 执行循环 ──
          result = await this.executeWorkerTask(
            workerLLM,
            worker,
            workerTask,
            topic,
            toolDefs,
            reactiveWorker,
            workingDirectory,
            onBeforeToolExecute,
            agentsMdHint,
            memoryHint
          )
        }

        reactiveWorker.status = 'completed'
        reactiveWorker.toolCalls = result.toolCalls.length > 0 ? result.toolCalls : undefined

        workerResults.push({
          ministerId: worker.id,
          ministerName: worker.name,
          task: workerTask.task,
          content: result.content,
          toolCalls: result.toolCalls,
          duration: Date.now() - startTime,
          status: 'success'
        })

        this.emit({ type: 'worker-done', ministerId: worker.id })
      } catch (error) {
        const errMsg = `执行失败：${error instanceof Error ? error.message : '未知错误'}`
        reactiveWorker.content = errMsg
        reactiveWorker.status = 'error'

        workerResults.push({
          ministerId: worker.id,
          ministerName: worker.name,
          task: workerTask.task,
          content: errMsg,
          toolCalls: [],
          duration: Date.now() - startTime,
          status: 'error'
        })

        this.emit({ type: 'error', ministerId: worker.id, data: { phase: 'worker', error } })

        if (!this.config.continueOnError) break
      }
    }

    if (!shouldContinue()) return

    // ── Phase 3: 丞相汇总 ──
    if (this.config.synthesize && workerResults.length > 0) {
      this.emit({ type: 'synthesizing' })

      const summarySpeechId = `chancellor-summary-${Date.now()}`
      const summarySpeech: Speech = {
        id: summarySpeechId,
        ministerId: chancellor.id,
        content: '',
        timestamp: Date.now(),
        status: 'streaming'
      }
      addSpeech(summarySpeech)

      const reactiveSummary = getReactiveSpeech(summarySpeechId)

      try {
        const summary = await this.synthesizeResults(
          chancellorLLM,
          topic,
          workerResults,
          (text) => { reactiveSummary.content = text }
        )
        reactiveSummary.content = summary
        reactiveSummary.status = 'completed'
      } catch (error) {
        reactiveSummary.content = `汇总失败：${error instanceof Error ? error.message : '未知错误'}`
        reactiveSummary.status = 'error'
      }
    }

    this.emit({ type: 'complete', data: { workerResults } })
  }

  /**
   * Phase 1: 丞相拆解任务
   */
  private async decomposeTask(
    provider: LLMProvider,
    topic: string,
    workers: Minister[],
    workingDirectory: string | undefined,
    agentsMdHint: string,
    memoryHint: string,
    onContent: (text: string) => void
  ): Promise<TaskDecomposition> {
    const workerDesc = workers.map(w =>
      `- ${w.id}（${w.name}，${w.title}）：${w.description}`
    ).join('\n')

    const dirHint = workingDirectory
      ? `\n\n项目工作目录: ${workingDirectory}\n分配任务时请明确告知 worker 使用该目录下的文件，使用相对路径。`
      : ''

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: (() => {
          const isIndustry = this.getCurrentThemeCategory() === 'industry'
          if (isIndustry) {
            return `你是团队协调者（产品经理/项目经理）。你的职责是分析需求，将其拆解为具体的子任务，分配给合适的团队成员执行。

可用的团队成员：
${workerDesc}

请按照以下 JSON 格式输出（不要使用 markdown 代码块，直接输出 JSON）：
{
  "plan": "你对需求的简要分析和执行计划",
  "tasks": [
    {
      "ministerId": "成员ID",
      "task": "具体子任务描述，包含明确的交付物要求",
      "context": "补充说明（可选）"
    }
  ]
}

要求：
1. 每个任务分配给最合适的成员
2. 任务描述要具体、可执行，明确说明需要创建哪些文件
3. 按流水线顺序分配：UI设计 → 前端开发 → 后端开发 → 测试
4. 如果需要创建文件，在 task 描述中明确文件路径和内容要求
5. 通常分配 4-5 个子任务${dirHint}${agentsMdHint}${memoryHint}`
          }
          return `你是丞相，朝堂之上的协调者。你的职责是分析圣上提出的议题，将其拆解为具体的子任务，分配给合适的大臣去执行。

可用的大臣：
${workerDesc}

请按照以下 JSON 格式输出（不要使用 markdown 代码块，直接输出 JSON）：
{
  "plan": "你对议题的简要分析和执行计划（2-3句话）",
  "tasks": [
    {
      "ministerId": "大臣ID",
      "task": "具体子任务描述，清晰明确",
      "context": "补充说明（可选）"
    }
  ]
}

要求：
1. 每个任务分配给最合适的大臣
2. 任务描述要具体、可执行
3. 合理分配，不要遗漏重要方面
4. 通常分配 2-4 个子任务${dirHint}${agentsMdHint}${memoryHint}`
        })()
      },
      {
        role: 'user',
        content: `议题：${topic}\n\n请分析并拆解任务。`
      }
    ]

    const content = await provider.chatStream(messages, onContent)

    return this.parseTaskDecomposition(content, workers)
  }

  /**
   * 解析任务拆解结果
   */
  private parseTaskDecomposition(content: string, workers: Minister[]): TaskDecomposition {
    // 尝试从回复中提取 JSON
    try {
      // 先尝试直接解析
      let jsonStr = content

      // 尝试提取 ```json ... ``` 代码块
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim()
      }

      // 尝试提取 { ... } 块
      const braceMatch = jsonStr.match(/\{[\s\S]*\}/)
      if (braceMatch) {
        jsonStr = braceMatch[0]
      }

      const parsed = JSON.parse(jsonStr)

      if (parsed.tasks && Array.isArray(parsed.tasks)) {
        const validIds = workers.map(w => w.id)
        const validTasks = parsed.tasks.filter(
          (t: any) => validIds.includes(t.ministerId) && typeof t.task === 'string'
        )

        if (validTasks.length > 0) {
          return {
            plan: parsed.plan || content,
            tasks: validTasks
          }
        }
      }
    } catch {
      // JSON 解析失败，使用降级方案
    }

    // 降级：将原始内容作为 plan，平均分配任务
    return {
      plan: content,
      tasks: workers.slice(0, 3).map(w => ({
        ministerId: w.id,
        task: `请从你的专业角度分析以下议题：${content.slice(0, 100)}`
      }))
    }
  }

  /**
   * Phase 2: 执行 Worker 子任务（带工具调用循环）
   */
  private async executeWorkerTask(
    provider: LLMProvider,
    minister: Minister,
    workerTask: WorkerTask,
    topic: string,
    toolDefs: import('@/types').ToolDefinition[],
    reactiveSpeech: Speech,
    workingDirectory?: string,
    onBeforeToolExecute?: (toolCall: ToolCall) => Promise<boolean>,
    agentsMdHint?: string,
    memoryHint?: string
  ): Promise<{ content: string; toolCalls: ToolCallResult[] }> {
    const dirHint = workingDirectory
      ? `\n项目工作目录: ${workingDirectory}\n创建文件时请使用相对路径（如 src/components/xxx.vue），系统会自动解析到工作目录下。`
      : ''

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: (() => {
          const isIndustry = this.getCurrentThemeCategory() === 'industry'
          if (isIndustry) {
            return `${minister.systemPrompt}

你正在参与一次团队协作任务。
项目需求：${topic}
协调者分配给你的任务：${workerTask.task}
${workerTask.context ? `补充说明：${workerTask.context}` : ''}${dirHint}

请认真执行任务。如果任务要求你创建文件，请使用 write_file 和 create_directory 工具生成实际的项目文件。完成后给出你的交付物总结。${agentsMdHint || ''}${memoryHint || ''}`
          }
          return `${minister.systemPrompt}

你正在参与一次 Agent 协作任务。
圣上的议题：${topic}
丞相分配给你的任务：${workerTask.task}
${workerTask.context ? `补充说明：${workerTask.context}` : ''}${dirHint}

请认真执行任务，必要时使用可用的工具获取信息。完成后给出你的分析结论。${agentsMdHint || ''}${memoryHint || ''}`
        })()
      },
      {
        role: 'user',
        content: `请执行你的任务：${workerTask.task}`
      }
    ]

    const allToolCalls: ToolCallResult[] = []
    let finalContent = ''

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const pendingToolCalls: ToolCall[] = []

      const content = await provider.chatStreamWithTools(
        messages,
        // onChunk：流式更新 UI
        (text) => {
          reactiveSpeech.content = text
        },
        // onToolCalls：收集工具调用请求
        (tcs) => {
          pendingToolCalls.push(...tcs)
        },
        { tools: toolDefs.length > 0 ? toolDefs : undefined }
      )

      // 如果没有工具调用，这就是最终回复
      if (pendingToolCalls.length === 0) {
        finalContent = content
        break
      }

      // 保存本轮的部分内容（工具调用前的分析文本）
      if (content) {
        finalContent = content
      }

      // 将 assistant 消息加入历史（含 tool_calls）
      messages.push({
        role: 'assistant',
        content: content || '',
        tool_calls: pendingToolCalls
      })

      // 执行工具调用
      for (const tc of pendingToolCalls) {
        // 相对路径解析：如果设置了工作目录，自动拼接相对路径
        if (workingDirectory && (tc.function.name === 'write_file' || tc.function.name === 'create_directory' || tc.function.name === 'read_file' || tc.function.name === 'read_directory' || tc.function.name === 'read_document' || tc.function.name === 'search_code')) {
          try {
            const args = JSON.parse(tc.function.arguments)
            if (args.path && !this.isAbsolutePath(args.path)) {
              args.path = this.joinPath(workingDirectory, args.path)
              tc.function.arguments = JSON.stringify(args)
            }
          } catch { /* 解析失败不处理 */ }
        }

        // execute_command: 自动注入工作目录作为 cwd
        if (workingDirectory && tc.function.name === 'execute_command') {
          try {
            const args = JSON.parse(tc.function.arguments)
            if (!args.cwd) {
              args.cwd = workingDirectory
              tc.function.arguments = JSON.stringify(args)
            }
          } catch { /* 解析失败不处理 */ }
        }

        // git_operation: 自动注入工作目录作为 cwd
        if (workingDirectory && tc.function.name === 'git_operation') {
          try {
            const args = JSON.parse(tc.function.arguments)
            if (!args.cwd) {
              args.cwd = workingDirectory
              tc.function.arguments = JSON.stringify(args)
            }
          } catch { /* 解析失败不处理 */ }
        }

        // run_tests: 自动注入工作目录作为 cwd
        if (workingDirectory && tc.function.name === 'run_tests') {
          try {
            const args = JSON.parse(tc.function.arguments)
            if (!args.cwd) {
              args.cwd = workingDirectory
              tc.function.arguments = JSON.stringify(args)
            }
          } catch { /* 解析失败不处理 */ }
        }

        this.emit({
          type: 'worker-tool',
          ministerId: minister.id,
          data: { functionName: tc.function.name, status: 'executing' }
        })

        // Approval Mode: 危险命令需确认
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

            if (!reactiveSpeech.toolStatuses) reactiveSpeech.toolStatuses = []
            reactiveSpeech.toolStatuses.push({
              toolCallId: tc.id,
              functionName: tc.function.name,
              status: 'error',
              displayName: this.getToolDisplayName(tc.function.name),
              summary: '用户拒绝执行危险命令'
            })

            messages.push({
              role: 'tool',
              content: JSON.stringify({ success: false, error: '用户拒绝执行该危险命令' }),
              tool_call_id: tc.id,
              name: tc.function.name
            })
            continue
          }
        }

        // Diff 预览：write_file 执行前读取旧内容
        let preWriteOldContent: string | null = null
        if (tc.function.name === 'write_file') {
          try {
            const args = JSON.parse(tc.function.arguments)
            const fp = args.path || ''
            if (fp && window.electronAPI?.readFile) {
              const readResult = await window.electronAPI.readFile(fp)
              if (readResult.success) {
                preWriteOldContent = readResult.content || ''
              }
            }
          } catch { /* 读取失败不影响执行 */ }
        }

        const result = await toolExecutor.execute(tc)
        allToolCalls.push(result)

        // 更新响应式 toolStatuses
        if (!reactiveSpeech.toolStatuses) {
          reactiveSpeech.toolStatuses = []
        }
        const toolStatus: import('@/types').ToolCallStatus = {
          toolCallId: tc.id,
          functionName: tc.function.name,
          status: result.status === 'success' ? 'completed' : (result.status === 'timeout' ? 'timeout' : 'error'),
          displayName: this.getToolDisplayName(tc.function.name),
          summary: result.status === 'success'
            ? this.buildSummary(result.result)
            : result.error || '执行失败'
        }

        // Diff 预览：write_file 执行后捕获 diff 数据
        if (tc.function.name === 'write_file' && result.status === 'success') {
          try {
            const args = JSON.parse(tc.function.arguments)
            toolStatus.diffData = {
              filePath: args.path || '',
              oldContent: preWriteOldContent || '',
              newContent: args.content || '',
              isNew: preWriteOldContent === null
            }
          } catch { /* 解析失败不附加 */ }
        }

        reactiveSpeech.toolStatuses.push(toolStatus)

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

      // 上下文压缩：工具执行完后检查是否需要压缩
      if (round < MAX_TOOL_ROUNDS - 1) {
        const threshold = getCompressThreshold()
        const totalChars = countMessageChars(messages)
        if (totalChars > threshold) {
          const summaryProvider = this.getSummaryProvider()
          if (summaryProvider) {
            console.log(`[Agent] 上下文超过阈值 (${totalChars} > ${threshold})，开始压缩...`)
            try {
              const compressed = await compressContext(messages, summaryProvider, threshold)
              messages.splice(0, messages.length, ...compressed)
              console.log(`[Agent] 压缩完成, 消息数: ${messages.length}, 字符: ${countMessageChars(messages)}`)
            } catch (e) {
              console.warn('[Agent] 压缩失败，继续执行:', e)
            }
          }
        }
      }

      // 如果这是最后一轮，获取最终回复
      if (round === MAX_TOOL_ROUNDS - 1) {
        const finalReply = await provider.chatStream(
          messages,
          (text) => {
            reactiveSpeech.content = (finalContent ? finalContent + '\n\n' : '') + text
          }
        )
        finalContent = (finalContent ? finalContent + '\n\n' : '') + finalReply
      }
    }

    return { content: finalContent, toolCalls: allToolCalls }
  }

  /**
   * Phase 3: 丞相汇总结果
   */
  private async synthesizeResults(
    provider: LLMProvider,
    topic: string,
    results: WorkerResult[],
    onContent: (text: string) => void
  ): Promise<string> {
    const workerOutputs = results.map(r => {
      const toolInfo = r.toolCalls.length > 0
        ? `（使用了 ${r.toolCalls.length} 个工具）`
        : ''
      return `### ${r.ministerName}的分析${toolInfo}\n**任务**：${r.task}\n\n${r.content}`
    }).join('\n\n---\n\n')

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: (() => {
          const isIndustry = this.getCurrentThemeCategory() === 'industry'
          if (isIndustry) {
            return `你是团队协调者。各团队成员已完成各自的工作，现在请你综合所有人的交付物，输出一份完整的项目总结报告。

要求：
1. 先概括各成员的核心交付物
2. 列出已创建的文件清单
3. 指出可能的风险和改进建议
4. 给出整体项目状态评估
5. 使用 Markdown 格式`
          }
          return `你是丞相，百官之长。各位大臣已完成各自的调研任务，现在请你综合所有人的分析，给圣上一份全面的奏报。

要求：
1. 先概括各方核心观点
2. 指出共识和分歧
3. 给出你的综合建议
4. 语气稳重、全面、有条理
5. 使用 Markdown 格式`
        })()
      },
      {
        role: 'user',
        content: (() => {
          const isIndustry = this.getCurrentThemeCategory() === 'industry'
          if (isIndustry) {
            return `项目需求：${topic}\n\n以下是各团队成员的交付成果：\n\n${workerOutputs}\n\n请输出项目总结报告。`
          }
          return `议题：${topic}\n\n以下是各位大臣的分析结果：\n\n${workerOutputs}\n\n请给出你的综合奏报。`
        })()
      }
    ]

    return await provider.chatStream(messages, onContent)
  }

  /**
   * 将任务拆解结果格式化为 Markdown 展示
   */
  private formatDecomposition(decomposition: TaskDecomposition, workers: Minister[]): string {
    const lines: string[] = []

    // 分析计划
    lines.push(`**📋 议题分析**\n`)
    lines.push(`${decomposition.plan}\n`)

    // 任务分配
    lines.push(`**⚔️ 任务分配**\n`)

    decomposition.tasks.forEach((task, i) => {
      const worker = workers.find(w => w.id === task.ministerId)
      const name = worker ? `${worker.avatar} ${worker.name}` : task.ministerId
      const title = worker ? `（${worker.title}）` : ''

      lines.push(`${i + 1}. **${name}**${title}`)
      lines.push(`   ${task.task}`)
      if (task.context) {
        lines.push(`   > ${task.context}`)
      }
      lines.push('')
    })

    return lines.join('\n')
  }

  /**
   * 获取工具的中文显示名
   */
  private getToolDisplayName(name: string): string {
    const names: Record<string, string> = {
      web_search: '网络搜索',
      knowledge_query: '知识库检索',
      calculate: '计算器',
      read_file: '文件读取',
      write_file: '文件写入',
      create_directory: '创建目录',
      read_directory: '读取目录',
      read_document: '文档解析',
      execute_command: '执行命令',
      search_code: '代码搜索',
      git_operation: 'Git 操作',
      run_tests: '运行测试',
      save_memory: '保存记忆',
      search_memory: '搜索记忆',
      summarize_results: '结果汇总'
    }
    return names[name] || name
  }

  /**
   * 判断是否为绝对路径
   */
  private isAbsolutePath(p: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')
  }

  /**
   * 拼接路径（简易版，处理正反斜杠）
   */
  private joinPath(base: string, relative: string): string {
    const sep = base.includes('\\') ? '\\' : '/'
    const baseTrimmed = base.replace(/[\\/]+$/, '')
    const relTrimmed = relative.replace(/^[\\/]+/, '')
    return `${baseTrimmed}${sep}${relTrimmed}`
  }

  /**
   * 构建结果摘要（截断长文本）
   */
  private buildSummary(result: any): string {
    if (result === null || result === undefined) return '无结果'
    if (typeof result === 'string') {
      return result.length > 60 ? result.slice(0, 60) + '...' : result
    }
    if (typeof result === 'object') {
      // 尝试提取有意义的摘要
      if (result.message) return result.message.slice(0, 60)
      if (result.result_count !== undefined) return `找到 ${result.result_count} 条结果`
      const str = JSON.stringify(result)
      return str.length > 60 ? str.slice(0, 60) + '...' : str
    }
    return String(result)
  }
}

/** 全局 Coordinator Agent 单例 */
export const coordinatorAgent = new CoordinatorAgent()
