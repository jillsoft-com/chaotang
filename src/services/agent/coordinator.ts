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
import { compressContext, countMessageChars } from './context-compressor'
import { memoryStore } from '@/services/memory'
import { skillRegistry } from '@/services/skills'
import { toolExecutor } from '@/services/tools/executor'
import { findPresetById, getCurrentDynastyId } from '@/services/dynasty-presets'
import { AutonomousEngine } from './autonomous-engine'
import type { AutonomousEvent } from './autonomous-engine'
import { taskScheduler } from './task-scheduler'
import type { ExecutionContext, LeafExecContext, LeafResult } from './task-scheduler'
import type { TaskTreeSnapshot, TaskNode } from './task-tree'
import { createTree, createNode, addNode, transitionStatus } from './task-tree'
import { filterToolDefinitionsForReadOnlyNode, WRITE_TOOLS } from './resource-lock'
import { buildRootContext } from './hierarchical-summary'
import { BudgetTracker } from './budget-display'
import { ContextManager } from './context-manager'
import type { NodeCost } from './execution-guardian'

// ============ 类型定义 ============

/** 子任务分配 */
export interface WorkerTask {
  ministerId: string   // 执行者 ID
  task: string         // 子任务描述
  context?: string     // 补充上下文
  /** 是否启用自主执行（由丞相在拆解时决定） */
  autonomous?: boolean
  /** 是否为只读任务（仅分析/调研，不写文件/执行命令） */
  readOnly?: boolean
}

/** 任务拆解结果 */
export interface TaskDecomposition {
  plan: string          // 丞相的分析计划
  tasks: WorkerTask[]   // 子任务列表
  /** 任务树快照（树模式时使用） */
  taskTree?: TaskTreeSnapshot
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
  | 'tree-created'    // 任务树已创建
  | 'worker-start'    // Worker 开始
  | 'worker-progress' // Worker 输出中
  | 'worker-tool'     // Worker 调用工具
  | 'worker-done'     // Worker 完成
  | 'worker-autonomous' // Worker 自主执行子事件
  | 'node-completed'  // 任务节点完成
  | 'node-failed'     // 任务节点失败
  | 'tree-completed'  // 任务树完成
  | 'tree-failed'     // 任务树失败
  | 'guardian-alert'  // 监护器报警（循环/停滞/预算）
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
  /** 自主执行的最大迭代轮数（默认 10，由丞相决定是否启用） */
  autonomousMaxIterations: number
}

const DEFAULT_CONFIG: CoordinatorConfig = {
  enabled: true,
  synthesize: true,
  continueOnError: true,
  planMode: false,
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
    /** 辩论 ID（用于任务树持久化） */
    debateId?: string
    /** Plan Mode: 拆解完成后回调，返回 true 继续执行，false 取消 */
    onPlanReady?: (plan: TaskDecomposition) => Promise<boolean>
    /** Approval Mode: 危险命令执行前回调，返回 true 批准，false 拒绝 */
    onBeforeToolExecute?: (toolCall: ToolCall) => Promise<boolean>
    /** 保存任务树快照（可选） */
    saveSnapshot?: (tree: TaskTreeSnapshot) => void
    /** 重试节点回调（监护器报警时调用，返回 true 确认重试） */
    onRetryNode?: (nodeId: string, reason: string) => Promise<boolean>
    /** 检查是否有遗留的中断任务树，返回用户选择 + 中断的树：{ choice, tree } */
    onRecoverInterrupted?: () => Promise<{ choice: 'resume' | 'restart' | null; tree?: TaskTreeSnapshot }>
  }): Promise<void> {
    const { topic, chancellor, workers, resolveLLM, addSpeech, getReactiveSpeech, shouldContinue, workingDirectory, debateId, onPlanReady, onBeforeToolExecute, saveSnapshot, onRetryNode, onRecoverInterrupted } = params

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

    // ── Phase 0: 检查是否有遗留的中断任务树 ──
    if (onRecoverInterrupted && saveSnapshot) {
      const { choice, tree } = await onRecoverInterrupted()
      if (choice === 'resume' && tree) {
        // 用户选择继续中断的任务树（树由回调直接从持久化存储提供）
        if (tree.state === 'interrupted') {
          for (const node of Object.values(tree.nodes)) {
            if (node.status === 'interrupted') {
              transitionStatus(tree, node.id, 'ready', '用户确认继续')
            }
          }
          tree.state = 'running'
          saveSnapshot(tree)
        }

        // 直接启动调度器（跳过丞相拆解）
        await this.startSchedulerAndWait(tree, {
          workers, resolveLLM, addSpeech, getReactiveSpeech, shouldContinue,
          workingDirectory, onBeforeToolExecute, saveSnapshot, onRetryNode,
          agentsMdHint, memoryHint, topic
        })
        this.emit({ type: 'complete', data: { resumed: true } })
        return
      } else if (choice === null) {
        this.emit({ type: 'complete', data: { cancelled: true, reason: '用户取消了恢复' } })
        return
      }
    }

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

    // ── 构建任务树 ──
    const workerResults: WorkerResult[] = []
    const taskTree = this.buildTaskTree(decomposition, topic, debateId || `debate-${Date.now()}`)
    if (taskTree) {
      decomposition.taskTree = taskTree
      this.emit({ type: 'tree-created', data: { tree: taskTree } })
    }

    if (taskTree && Object.keys(taskTree.nodes).length > 1) {
      // ── Phase 2: 调度器模式执行任务树 ──
      const { workerResults: treeResults } = await this.startSchedulerAndWait(taskTree, {
        workers, resolveLLM, addSpeech, getReactiveSpeech, shouldContinue,
        workingDirectory, onBeforeToolExecute, saveSnapshot, onRetryNode,
        agentsMdHint, memoryHint, topic
      })
      workerResults.push(...treeResults)
    } else {
      // ── Phase 2 (legacy): 扁平执行模式 ──
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

        const previousWorkersSummary = this.buildPreviousWorkersSummary(workerResults)
        const taskContextWithHistory = previousWorkersSummary
          ? `${workerTask.task}${workerTask.context ? '\n补充：' + workerTask.context : ''}\n\n=== 前序成员已完成的工作 ===\n${previousWorkersSummary}\n=== 前序工作结束 ===\n重要：请不要重复创建前序成员已创建的文件，不要覆盖他们的输出。你的工作应在他们的基础上继续。`
          : `${workerTask.task}${workerTask.context ? '\n补充：' + workerTask.context : ''}`

        const startTime = Date.now()
        try {
          let result: { content: string; toolCalls: ToolCallResult[] }

          if (workerTask.autonomous) {
            const engine = new AutonomousEngine({
              maxIterations: this.config.autonomousMaxIterations,
              verifyAfterEachRound: true,
              workingDirectory,
              agentsMdHint,
              memoryHint
            })
            engine.onEvent((evt: AutonomousEvent) => {
              this.emit({ type: 'worker-autonomous', ministerId: worker.id, data: evt })
            })
            const autoResult = await engine.execute({
              provider: workerLLM,
              systemPrompt: worker.systemPrompt,
              goal: topic,
              taskContext: taskContextWithHistory,
              toolDefs,
              onContent: (text) => { reactiveWorker.content = text },
              onBeforeToolExecute
            })
            if (!reactiveWorker.toolStatuses) reactiveWorker.toolStatuses = []
            for (const tc of autoResult.toolCalls) {
              reactiveWorker.toolStatuses.push({
                toolCallId: tc.toolCallId,
                functionName: tc.functionName,
                status: tc.status === 'success' ? 'completed' : (tc.status === 'timeout' ? 'timeout' : 'error'),
                displayName: this.getToolDisplayName(tc.functionName),
                summary: tc.status === 'success' ? this.buildSummary(tc.result) : tc.error || '执行失败'
              })
            }
            result = { content: autoResult.content, toolCalls: autoResult.toolCalls }
          } else {
            const enhancedTask: WorkerTask = previousWorkersSummary
              ? { ...workerTask, task: `${workerTask.task}\n\n=== 前序成员已完成的工作 ===\n${previousWorkersSummary}\n=== 前序工作结束 ===\n重要：请不要重复创建前序成员已创建的文件。` }
              : workerTask
            result = await this.executeWorkerTask(workerLLM, worker, enhancedTask, topic, toolDefs, reactiveWorker, workingDirectory, onBeforeToolExecute, agentsMdHint, memoryHint)
          }

          reactiveWorker.status = 'completed'
          reactiveWorker.toolCalls = result.toolCalls.length > 0 ? result.toolCalls : undefined
          workerResults.push({ ministerId: worker.id, ministerName: worker.name, task: workerTask.task, content: result.content, toolCalls: result.toolCalls, duration: Date.now() - startTime, status: 'success' })
          this.emit({ type: 'worker-done', ministerId: worker.id })
        } catch (error) {
          const errMsg = `执行失败：${error instanceof Error ? error.message : '未知错误'}`
          reactiveWorker.content = errMsg
          reactiveWorker.status = 'error'
          workerResults.push({ ministerId: worker.id, ministerName: worker.name, task: workerTask.task, content: errMsg, toolCalls: [], duration: Date.now() - startTime, status: 'error' })
          this.emit({ type: 'error', ministerId: worker.id, data: { phase: 'worker', error } })
          if (!this.config.continueOnError) break
        }
      }
    }

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
        // 成本归因摘要（任务树模式）
        let costTable = ''
        if (taskTree && Object.keys(taskTree.nodes).length > 1) {
          const costs = taskScheduler.getTreeCost(taskTree.runId)
          if (costs.length > 0) {
            costTable = this.formatCostAttribution(costs)
          }
        }

        // 逐层汇总：任务树模式下使用 buildRootContext 为丞相提供分层摘要
        let hierarchicalContext = ''
        if (taskTree && Object.keys(taskTree.nodes).length > 1) {
          hierarchicalContext = buildRootContext(taskTree, taskTree.rootId)
        }

        const summary = await this.synthesizeResults(
          chancellorLLM,
          topic,
          workerResults,
          (text) => { reactiveSummary.content = (costTable ? costTable + '\n\n' : '') + text },
          hierarchicalContext
        )
        reactiveSummary.content = (costTable ? costTable + '\n\n' : '') + summary
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
      "context": "补充说明（可选）",
      "autonomous": true,
      "readOnly": false
    }
  ]
}

关于 autonomous 字段：
- true = 该成员需要自主执行（可迭代多轮：写代码→编译→报错→改代码→重跑）
- false = 一次性输出即可（如输出方案文档、分析报告）
- 判断规则：如果任务需要创建实际文件并验证结果正确性，设为 true；如果只需输出文字方案，设为 false

关于 readOnly 字段：
- true = 纯分析/调研任务，不需要创建或修改任何文件
- false = 需要创建、修改文件或执行命令

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
      "context": "补充说明（可选）",
      "autonomous": false,
      "readOnly": false
    }
  ]
}

关于 autonomous 字段：
- true = 该大臣需要自主执行（可迭代多轮：执行工具→检查结果→修正→重试）
- false = 一次性分析即可（只需输出意见和建议）
- 判断规则：如果任务需要执行实际操作（创建文件、运行命令、修改代码等），设为 true；如果只需分析和建议，设为 false

关于 readOnly 字段：
- true = 纯调研/分析任务，不需要创建或修改任何文件、不执行命令
- false = 需要执行实际操作

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
        const validTasks = parsed.tasks
          .filter((t: any) => validIds.includes(t.ministerId) && typeof t.task === 'string')
          .map((t: any) => ({
            ministerId: t.ministerId,
            task: t.task,
            context: t.context || undefined,
            autonomous: t.autonomous === true,  // 只有明确为 true 才启用
            readOnly: 'readOnly' in t ? t.readOnly === true : undefined  // 保留 undefined 让 buildTaskTree 推断默认值
          }))

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
   * 从丞相拆解结果构建任务树
   */
  private buildTaskTree(decomposition: TaskDecomposition, topic: string, debateId: string): TaskTreeSnapshot | null {
    const tree = createTree(debateId, topic, decomposition.plan, 'chancellor')

    if (decomposition.tasks.length === 0) return null

    for (let i = 0; i < decomposition.tasks.length; i++) {
      const task = decomposition.tasks[i]
      const isReadOnly = task.readOnly ?? !task.autonomous
      const node = createNode({
        title: task.task.slice(0, 50) || `任务 ${i + 1}`,
        description: task.task,
        parentId: tree.rootId,
        createdBy: 'chancellor',
        assigneeId: task.ministerId,
        mode: task.autonomous ? 'action' : 'analysis',
        autonomous: task.autonomous === true,
        readOnly: isReadOnly,
        decomposition: task.autonomous ? 'leaf' : 'unexamined',
        priority: 0,
        budget: { maxIterations: this.config.autonomousMaxIterations, maxToolCalls: 50, timeoutMs: 5 * 60 * 1000 }
      })
      const result = addNode(tree, node)
      if (!result.ok) {
        console.warn(`[Agent] 添加任务节点失败: ${task.task.slice(0, 30)} - ${result.error}`)
      }
    }

    return tree
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
    memoryHint?: string,
    onToolCall?: () => boolean | void
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
    let budgetExhausted = false  // P1: 预算耗尽标志，用于终止整个任务循环

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // P1: 如果预算已耗尽，终止整个任务循环
      if (budgetExhausted) {
        messages.push({
          role: 'user',
          content: '工具调用预算已耗尽，请输出当前进展的最终总结。'
        })
        break
      }

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

        // P0: 运行时只读授权——在执行前拦截写工具调用
        if (workerTask.readOnly && WRITE_TOOLS.has(tc.function.name)) {
          const rejected: ToolCallResult = {
            toolCallId: tc.id, functionName: tc.function.name, arguments: {},
            result: { success: false, error: '只读节点不允许调用写工具' },
            status: 'error', duration: 0, error: '只读权限拦截'
          }
          allToolCalls.push(rejected)
          messages.push({
            role: 'tool',
            content: JSON.stringify({ success: false, error: '当前任务为只读模式，不允许执行写操作。请改用分析/调研方式完成任务。' }),
            tool_call_id: tc.id, name: tc.function.name
          })
          continue
        }

        // P1: 执行前原子预留预算额度
        if (onToolCall) {
          try {
            const reserved = onToolCall()
            if (reserved === false) {
              // 预算耗尽：不执行工具，直接拒绝
              const rejected: ToolCallResult = {
                toolCallId: tc.id, functionName: tc.function.name, arguments: {},
                result: { success: false, error: '工具调用预算已耗尽' },
                status: 'error', duration: 0, error: '预算耗尽'
              }
              allToolCalls.push(rejected)
              budgetExhausted = true
              break
            }
          } catch { /* 忽略回调异常 */ }
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

      // 上下文压缩（R8：通过 ContextManager 按模型容量管理）
      if (round < MAX_TOOL_ROUNDS - 1) {
        const ctxMgr = new ContextManager(minister.llm?.model || 'unknown')
        const ctxMessages = messages.map(m => ({ role: m.role as 'system' | 'user' | 'assistant', content: typeof m.content === 'string' ? m.content : '' }))
        if (ctxMgr.exceedsContextLimit(ctxMessages)) {
          const summaryProvider = this.getSummaryProvider()
          if (summaryProvider) {
            console.log(`[Agent] 上下文超出模型容量 (${ctxMgr.estimateTokens(ctxMessages.reduce((s, m) => s + m.content, ''))} tokens > ${ctxMgr.getBudget().maxTokens})，开始压缩...`)
            try {
              const compressed = await compressContext(messages, summaryProvider, ctxMgr.getAvailableChars())
              const afterChars = countMessageChars(compressed)
              messages.splice(0, messages.length, ...compressed)
              console.log(`[Agent] 压缩完成, 消息数: ${messages.length}, 字符: ${afterChars}`)
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
    onContent: (text: string) => void,
    hierarchicalContext?: string
  ): Promise<string> {
    const workerOutputs = hierarchicalContext
      ? ''  // 树模式：只使用逐层汇总，不传入叶子全文
      : results.map(r => {
          const toolInfo = r.toolCalls.length > 0
            ? `（使用了 ${r.toolCalls.length} 个工具）`
            : ''
          return `### ${r.ministerName}的分析${toolInfo}\n**任务**：${r.task}\n\n${r.content}`
        }).join('\n\n---\n\n')

    // 任务树模式下的逐层汇总上下文
    const hierarchySection = hierarchicalContext
      ? `\n\n=== 任务树逐层汇总 ===\n${hierarchicalContext}\n=== 汇总结束 ===\n请参考以上分层摘要进行综合判断，无需重述每个叶子的细节。`
      : ''

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
            return `项目需求：${topic}\n\n以下是各团队成员的交付成果：\n\n${workerOutputs}${hierarchySection}\n\n请输出项目总结报告。`
          }
          return `议题：${topic}\n\n以下是各位大臣的分析结果：\n\n${workerOutputs}${hierarchySection}\n\n请给出你的综合奏报。`
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

    lines.push(`**📋 议题分析**\n`)
    lines.push(`${decomposition.plan}\n`)
    lines.push(`**⚔️ 任务分配**\n`)

    decomposition.tasks.forEach((task, i) => {
      const worker = workers.find(w => w.id === task.ministerId)
      const name = worker ? `${worker.avatar} ${worker.name}` : task.ministerId
      const title = worker ? `（${worker.title}）` : ''
      const autoBadge = task.autonomous ? ' 🔄' : ''
      lines.push(`${i + 1}. **${name}**${title}${autoBadge}`)
      lines.push(`   ${task.task}`)
      if (task.context) lines.push(`   > ${task.context}`)
      lines.push('')
    })

    // 展示任务树结构（如果有）
    if (decomposition.taskTree) {
      lines.push('**🌳 任务树结构**\n')
      const tree = decomposition.taskTree
      const root = tree.nodes[tree.rootId]
      if (root) {
        for (const childId of root.childIds) {
          const child = tree.nodes[childId]
          if (child) {
            const w = workers.find(m => m.id === child.assigneeId)
            const wName = w ? `${w.avatar} ${w.name}` : (child.assigneeId || '未分配')
            const badge = child.autonomous ? '🔄' : '📝'
            lines.push(`  ${badge} **${child.title}** → ${wName}`)
            lines.push(`    状态: ${child.status} | 优先级: ${child.priority}`)
          }
        }
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  /**
   * 格式化成本归因表格
   */
  private formatCostAttribution(costs: NodeCost[]): string {
    if (costs.length === 0) return ''

    const lines: string[] = [
      '**📊 执行成本归因**',
      '',
      '| 任务 | 迭代 | 工具调用 | 耗时 | 估算 Token |',
      '|------|------|----------|------|------------|'
    ]

    let totalIterations = 0
    let totalToolCalls = 0
    let totalElapsed = 0
    let totalTokens = 0

    for (const cost of costs) {
      const elapsed = cost.elapsedMs > 0 ? `${(cost.elapsedMs / 1000).toFixed(1)}s` : '-'
      const tokens = cost.estimatedTokens > 0 ? `~${cost.estimatedTokens}` : '-'
      lines.push(`| ${cost.title} | ${cost.iterations} | ${cost.toolCalls} | ${elapsed} | ${tokens} |`)
      totalIterations += cost.iterations
      totalToolCalls += cost.toolCalls
      totalElapsed += cost.elapsedMs
      totalTokens += cost.estimatedTokens
    }

    lines.push(`| **合计** | **${totalIterations}** | **${totalToolCalls}** | **${(totalElapsed / 1000).toFixed(1)}s** | **~${totalTokens}** |`)

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

  /**
   * 启动调度器并等待任务树完成（复用于恢复和正常流程）
   */
  private async startSchedulerAndWait(
    tree: TaskTreeSnapshot,
    params: {
      workers: Minister[]; resolveLLM: (llm: LLMConfig) => LLMConfig
      addSpeech: (speech: Speech) => void; getReactiveSpeech: (id: string) => Speech
      shouldContinue: () => boolean; workingDirectory?: string
      onBeforeToolExecute?: (tc: ToolCall) => Promise<boolean>
      saveSnapshot?: (tree: TaskTreeSnapshot) => void
      onRetryNode?: (nodeId: string, reason: string) => Promise<boolean>
      agentsMdHint?: string; memoryHint?: string; topic: string
    }
  ): Promise<{ workerResults: WorkerResult[] }> {
    const { workers, resolveLLM, addSpeech, getReactiveSpeech, shouldContinue, workingDirectory, onBeforeToolExecute, saveSnapshot, onRetryNode, agentsMdHint, memoryHint, topic } = params
    const workerResults: WorkerResult[] = []
    // 预算追踪器：追踪整棵树和每个节点的工具调用消耗
    const defaultMaxIterations = 10
    const budgetTracker = new BudgetTracker(tree.limits.maxToolCallsPerRun, defaultMaxIterations)
    budgetTracker.onWarning((w) => {
      this.emit({ type: 'guardian-alert', data: { runId: tree.runId, nodeId: w.nodeId, record: { type: 'budget', message: w.message }, schedulerType: 'budget-warning' } })
    })
    // 每次工具调用后的增量计数器（用于 per-tool-call budget-update）
    // P1: 从树的既有已消耗用量初始化，避免恢复任务树时重置预算
    let liveToolCallCount = tree.usage.toolCalls
    const onToolCall = (): boolean => {
      // P1: 原子预留——在执行前检查并递增，并行场景下同步操作保证原子性
      if (liveToolCallCount >= tree.limits.maxToolCallsPerRun) {
        return false  // 预算已耗尽，不执行
      }
      liveToolCallCount++
      const remaining = tree.limits.maxToolCallsPerRun - liveToolCallCount
      // P1: 即时同步预留用量到快照，防止崩溃丢失
      tree.usage.toolCalls = liveToolCallCount
      try { saveSnapshot?.(tree) } catch { /* 快照保存失败不影响执行 */ }
      const snapshot = {
        nodeId: '__live__',
        nodeUsage: { iterations: 0, toolCalls: liveToolCallCount, elapsedMs: 0 },
        treeUsage: { iterations: tree.usage.iterations, toolCalls: liveToolCallCount, elapsedMs: tree.usage.elapsedMs },
        remaining: { toolCalls: remaining, iterations: 0 },
        timestamp: Date.now()
      }
      budgetTracker.processBudgetUpdate(snapshot)
      return true
    }

    const schedulerListener = (evt: any) => {
      if (evt.type === 'node-completed' || evt.type === 'node-failed') {
        const node = tree.nodes[evt.nodeId]
        if (node && node.assigneeId) {
          const worker = workers.find(w => w.id === node.assigneeId)
          this.emit({ type: evt.type === 'node-completed' ? 'node-completed' : 'node-failed', ministerId: node.assigneeId, data: evt.data })
          workerResults.push({
            ministerId: node.assigneeId, ministerName: worker?.name || node.assigneeId,
            task: node.title, content: node.resultSummary || '', toolCalls: [], duration: 0,
            status: evt.type === 'node-completed' ? 'success' : 'error'
          })
          this.emit({ type: 'worker-done', ministerId: node.assigneeId })
        }
      }
      // 调度器的 budget-update 事件转发给 BudgetTracker（使用实时计数器避免滞后）
      if (evt.type === 'budget-update' && evt.data) {
        budgetTracker.processBudgetUpdate({
          nodeId: evt.nodeId || '__unknown__',
          nodeUsage: evt.data.nodeUsage,
          treeUsage: { iterations: evt.data.treeUsage.iterations, toolCalls: liveToolCallCount, elapsedMs: evt.data.treeUsage.elapsedMs },
          remaining: { toolCalls: tree.limits.maxToolCallsPerRun - liveToolCallCount, iterations: evt.data.remaining.iterations },
          timestamp: Date.now()
        })
      }
      if (evt.type === 'guardian-paused' || evt.type === 'guardian-warning') {
        this.emit({ type: 'guardian-alert', data: { runId: evt.runId, nodeId: evt.nodeId, record: evt.data?.record, schedulerType: evt.type } })
        if (evt.type === 'guardian-paused' && onRetryNode && evt.nodeId) {
          const reason = evt.data?.record?.detail || '监护器暂停了该节点'
          onRetryNode(evt.nodeId, reason).then(confirmed => {
            if (confirmed) taskScheduler.retryNode(evt.runId, evt.nodeId, true)
          }).catch(() => {})
        }
      }
    }
    const unsub = taskScheduler.onEvent(schedulerListener)

    await new Promise<void>((resolve) => {
      const treeDone = (evt: any) => {
        if (evt.runId !== tree.runId) return
        if (evt.type === 'tree-completed' || evt.type === 'tree-failed') {
          unsub()
          resolve()
        }
      }
      taskScheduler.onEvent(treeDone)

      const context: ExecutionContext = {
        ministers: workers, resolveLLM,
        createSpeech: (ministerId: string) => ({ id: `${ministerId}-${Date.now()}`, ministerId, content: '', timestamp: Date.now(), status: 'streaming' }),
        getReactiveSpeech, shouldContinue, workingDirectory, onBeforeToolExecute,
        agentsMdHint, memoryHint,
        saveSnapshot: (t: TaskTreeSnapshot) => { saveSnapshot?.(t) },
        requestWorkerDecomposition: async (w, n, t) => this.requestWorkerDecomposition(w, n, t, topic, addSpeech, getReactiveSpeech, resolveLLM),
        executeLeaf: async (n, lc, as) => this.executeLeafNode(n, lc, as, topic, workers, resolveLLM, addSpeech, getReactiveSpeech, onBeforeToolExecute, workingDirectory, agentsMdHint, memoryHint, onToolCall)
      }

      taskScheduler.start(tree, context)
    })

    return { workerResults }
  }

  /**
   * 执行叶子节点（调度器调用）
   */
  private async executeLeafNode(
    node: TaskNode, leafContext: LeafExecContext, abortSignal: AbortSignal | undefined,
    topic: string, workers: Minister[], resolveLLM: (llm: LLMConfig) => LLMConfig,
    addSpeech: (speech: Speech) => void, getReactiveSpeech: (id: string) => Speech,
    onBeforeToolExecute?: (tc: ToolCall) => Promise<boolean>,
    workingDirectory?: string, agentsMdHint?: string, memoryHint?: string,
    onToolCall?: () => boolean | void
  ): Promise<LeafResult> {
    const worker = workers.find(w => w.id === node.assigneeId)
    if (!worker) return { content: `未找到执行者: ${node.assigneeId}`, toolCalls: [], duration: 0, status: 'error' }

    const workerSpeechId = `${worker.id}-tree-${Date.now()}`
    const workerSpeech: Speech = { id: workerSpeechId, ministerId: worker.id, content: '', timestamp: Date.now(), status: 'streaming', toolStatuses: [] }
    addSpeech(workerSpeech)
    const reactiveWorker = getReactiveSpeech(workerSpeechId)
    const workerLLM = createProvider(resolveLLM(worker.llm))
    // 实际工具集：只读节点过滤掉写工具
    let toolDefs = skillRegistry.getToolDefinitionsForMinister(worker.id)
    if (node.readOnly) {
      toolDefs = filterToolDefinitionsForReadOnlyNode(toolDefs)
    }
    const taskContextWithHistory = leafContext.previousResultsSummary
      ? `${node.description}\n\n${leafContext.previousResultsSummary}`
      : node.description
    const startTime = Date.now()

    try {
      let result: { content: string; toolCalls: ToolCallResult[] }
      let goalReached = true
      let hasToolFailure = false
      if (node.autonomous) {
        const engine = new AutonomousEngine({ maxIterations: node.budget.maxIterations, verifyAfterEachRound: true, workingDirectory, agentsMdHint, memoryHint, modelId: worker.llm?.model, readOnly: node.readOnly })
        engine.onEvent((evt: AutonomousEvent) => { this.emit({ type: 'worker-autonomous', ministerId: worker.id, data: evt }) })
        const autoResult = await engine.execute({
          provider: workerLLM, systemPrompt: worker.systemPrompt, goal: topic, taskContext: taskContextWithHistory, toolDefs,
          onContent: (text) => { reactiveWorker.content = text }, onBeforeToolExecute, abortSignal, onToolCall
        })
        if (!reactiveWorker.toolStatuses) reactiveWorker.toolStatuses = []
        for (const tc of autoResult.toolCalls) {
          reactiveWorker.toolStatuses.push({ toolCallId: tc.toolCallId, functionName: tc.functionName, status: tc.status === 'success' ? 'completed' : 'error', displayName: this.getToolDisplayName(tc.functionName), summary: tc.status === 'success' ? this.buildSummary(tc.result) : tc.error || '执行失败' })
        }
        result = { content: autoResult.content, toolCalls: autoResult.toolCalls }
        goalReached = autoResult.goalReached
      } else {
        const wt: WorkerTask = { ministerId: worker.id, task: node.description, readOnly: node.readOnly }
        result = await this.executeWorkerTask(workerLLM, worker, wt, topic, toolDefs, reactiveWorker, workingDirectory, onBeforeToolExecute, agentsMdHint, memoryHint, onToolCall)
        // 非自主路径：检查关键写操作是否失败（同一工具同参数只看最后一次结果）
        const criticalTools = new Set(['write_file', 'create_directory', 'execute_command', 'run_tests', 'git_operation'])
        const lastAttemptByKey = new Map<string, { functionName: string; status: string }>()
        for (const tc of result.toolCalls) {
          if (!criticalTools.has(tc.functionName)) continue
          let argsKey = ''
          try { argsKey = JSON.stringify(tc.arguments) } catch { /* 忽略 */ }
          const key = `${tc.functionName}:${argsKey}`
          lastAttemptByKey.set(key, { functionName: tc.functionName, status: tc.status })
        }
        hasToolFailure = false
        for (const { status } of lastAttemptByKey.values()) {
          if (status === 'error' || status === 'timeout') {
            hasToolFailure = true
            break
          }
        }
      }
      reactiveWorker.status = 'completed'
      reactiveWorker.toolCalls = result.toolCalls.length > 0 ? result.toolCalls : undefined

      // P2: 检测 LLM 输出中的复杂度信号（明确表明任务过于复杂需要更深拆解）
      const complexitySignal = this.detectComplexitySignal(result.content)

      // 验收判定：自主引擎的 goalReached 为 false 时视为失败
      if (!goalReached) {
        return { content: result.content, toolCalls: result.toolCalls, duration: Date.now() - startTime, status: 'error', goalReached: false, complexitySignal }
      }

      // 非自主路径：关键写操作失败时视为未达标
      if (hasToolFailure) {
        return { content: result.content, toolCalls: result.toolCalls, duration: Date.now() - startTime, status: 'error', goalReached: false, complexitySignal }
      }

      return { content: result.content, toolCalls: result.toolCalls, duration: Date.now() - startTime, status: 'success', goalReached: true, complexitySignal }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : '未知错误'
      reactiveWorker.content = errMsg
      reactiveWorker.status = 'error'
      return { content: errMsg, toolCalls: [], duration: Date.now() - startTime, status: 'error' }
    }
  }

  /**
   * 请求 Worker 渐进拆解（调度器调用）
   */
  private async requestWorkerDecomposition(
    worker: Minister, node: TaskNode, tree: TaskTreeSnapshot, topic: string,
    addSpeech: (speech: Speech) => void, getReactiveSpeech: (id: string) => Speech,
    resolveLLM: (llm: LLMConfig) => LLMConfig
  ): Promise<TaskTreeSnapshot> {
    const speechId = `${worker.id}-decompose-${Date.now()}`
    const speech: Speech = { id: speechId, ministerId: worker.id, content: '', timestamp: Date.now(), status: 'streaming' }
    addSpeech(speech)
    const reactive = getReactiveSpeech(speechId)
    const provider = createProvider(resolveLLM(worker.llm))

    const messages: ChatMessage[] = [{
      role: 'system',
      content: `${worker.systemPrompt}\n\n你被分配了一个任务，请将其拆解为 2-4 个具体子任务。\n\n父任务：${node.description}\n总体目标：${topic}\n\n请按 JSON 格式输出：\n{\n  "subtasks": [\n    { "title": "子任务标题", "description": "详细描述", "assigneeId": "执行者ID（可留空表示自己）", "autonomous": true }\n  ]\n}`
    }, { role: 'user', content: `请拆解任务：${node.title}` }]

    try {
      const content = await provider.chatStream(messages, (t) => { reactive.content = t })
      reactive.status = 'completed'
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || content.match(/\{[\s\S]*\}/)
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content
      const parsed = JSON.parse(jsonStr)
      if (parsed.subtasks && Array.isArray(parsed.subtasks) && parsed.subtasks.length > 0) {
        for (const st of parsed.subtasks) {
          const child = createNode({ title: st.title || '子任务', description: st.description || '', parentId: node.id, createdBy: worker.id, assigneeId: st.assigneeId || worker.id, autonomous: st.autonomous === true, readOnly: st.readOnly === true || (!st.autonomous), decomposition: 'leaf', mode: 'action' })
          addNode(tree, child)
        }
      }
    } catch { /* 拆解失败，保持为叶子 */ }

    return tree
  }

  /**
   * 构建前序 Worker 的输出摘要，传递给后续 Worker
   * 确保后面的 Worker 知道前面已经创建了什么文件、完成了什么工作
   */
  private buildPreviousWorkersSummary(results: WorkerResult[]): string {
    if (results.length === 0) return ''

    const parts: string[] = []
    for (const r of results) {
      // 提取已创建/修改的文件列表
      const createdFiles: string[] = []
      for (const tc of r.toolCalls) {
        if (tc.functionName === 'write_file' && tc.status === 'success') {
          try {
            const args = tc.arguments as Record<string, any>
            if (args.path) createdFiles.push(args.path)
          } catch { /* 忽略 */ }
        }
        if (tc.functionName === 'create_directory' && tc.status === 'success') {
          try {
            const args = tc.arguments as Record<string, any>
            if (args.path) createdFiles.push(args.path + '/')
          } catch { /* 忽略 */ }
        }
      }

      // 截断输出内容（避免过长，每个 Worker 最多 1500 字符）
      const contentPreview = r.content.length > 1500
        ? r.content.slice(0, 1500) + '...(已截断)'
        : r.content

      let summary = `### ${r.ministerName}（${r.ministerId}）\n`
      summary += `**任务**：${r.task}\n`
      if (createdFiles.length > 0) {
        summary += `**已创建/修改的文件**：\n${createdFiles.map(f => `- ${f}`).join('\n')}\n`
      }
      summary += `**输出**：${contentPreview}\n`

      parts.push(summary)
    }

    return parts.join('\n---\n\n')
  }

  /**
   * 检测 LLM 输出中是否包含复杂度信号
   * 即明确表明任务过于复杂、需要进一步拆解的文本特征
   */
  private detectComplexitySignal(content: string): boolean {
    if (!content || content.length < 10) return false
    // 仅扫描前 2000 字符，避免长输出全量扫描
    const text = content.slice(0, 2000).toLowerCase()
    const patterns = [
      '任务过于复杂', '需要进一步拆解', '需要更细的拆分', '需要更深入的拆解',
      '建议拆分为', '建议分解为', '拆分成多个步骤', '分解为多个子任务',
      '无法在一次执行中完成', '无法在单次', '超出单次执行范围',
      'too complex', 'needs further decomposition', 'should be broken down',
      'requires more granular', 'needs to be split'
    ]
    return patterns.some(p => text.includes(p))
  }
}

/** 全局 Coordinator Agent 单例 */
export const coordinatorAgent = new CoordinatorAgent()
