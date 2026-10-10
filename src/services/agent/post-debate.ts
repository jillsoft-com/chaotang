/**
 * Post-Debate Executor — 退朝后执行服务
 *
 * 朝议结束（用户拍板）后，Agent 继续执行后续动作：
 * 1. 生成圣旨（综合朝议结论的正式文档）
 * 2. 生成行动清单（Action Items）
 * 3. 生成完整报告（Markdown 格式）
 *
 * 所有动作通过 LLM 生成，基于朝议过程中各大臣的发言记录。
 */

import type { Debate, Minister, ChatMessage, LLMConfig, DecisionReport, DecisionEntry } from '@/types'
import { createProvider } from '@/services/llm'

// ============ 类型定义 ============

/** 圣旨生成结果 */
export interface ImperialDecree {
  title: string          // 圣旨标题
  content: string        // 圣旨正文
  keyPoints: string[]    // 核心要点
  decidedAt: number      // 拍板时间
}

/** 行动条目 */
export interface ActionItem {
  id: string
  title: string
  description: string
  assignee?: string      // 负责的大臣
  priority: 'high' | 'medium' | 'low'
  status: 'pending' | 'in-progress' | 'done'
}

/** 退朝执行结果 */
export interface PostDebateResult {
  decree?: ImperialDecree
  actionItems?: ActionItem[]
  report?: string
  errors: string[]
}

/** 执行动作类型 */
export type PostDebateAction = 'decree' | 'action-items' | 'report' | 'decision-report'

// ============ Post-Debate Executor ============

export class PostDebateExecutor {

  /**
   * 生成圣旨
   * 基于朝议内容生成一份正式的"圣旨"总结
   */
  async generateImperialDecree(
    debate: Debate,
    ministers: Minister[],
    llmConfig: LLMConfig
  ): Promise<ImperialDecree> {
    const provider = createProvider(llmConfig)
    const debateSummary = this.buildDebateSummary(debate, ministers)

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是帝王的书记官，负责将朝议内容整理为正式的"圣旨"。
圣旨格式要求：
- 标题简洁有力
- 正文以"奉天承运，皇帝诏曰"开头
- 概括朝议的核心结论和决策
- 列出关键要点
- 语气庄重、正式
- 适当使用古风用语，但内容要清晰易懂`
      },
      {
        role: 'user',
        content: `议题：${debate.topic}\n\n朝议记录：\n${debateSummary}\n\n请生成圣旨。输出格式：
标题：（圣旨标题）

（圣旨正文）

要点：
1. ...
2. ...
3. ...`
      }
    ]

    const content = await provider.chatStream(messages, () => {})

    // 解析结果
    const titleMatch = content.match(/标题[：:]\s*(.+)/)
    const pointsMatch = content.match(/要点[：:]([\s\S]*)/)

    return {
      title: titleMatch?.[1]?.trim() || `关于"${debate.topic}"的圣旨`,
      content: content,
      keyPoints: pointsMatch
        ? pointsMatch[1].split('\n').map(p => p.replace(/^\d+\.\s*/, '').trim()).filter(Boolean)
        : [],
      decidedAt: Date.now()
    }
  }

  /**
   * 生成行动清单
   * 从朝议讨论中提取可执行的行动项
   */
  async generateActionItems(
    debate: Debate,
    ministers: Minister[],
    llmConfig: LLMConfig
  ): Promise<ActionItem[]> {
    const provider = createProvider(llmConfig)
    const debateSummary = this.buildDebateSummary(debate, ministers)

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是一个任务管理专家。请基于朝议讨论内容，提取出可执行的行动项（Action Items）。

要求：
1. 每个行动项要具体、可执行
2. 指定负责的大臣（如果适用）
3. 标注优先级
4. 以 JSON 数组格式输出（不要使用 markdown 代码块）

格式：
[
  {
    "title": "行动项标题",
    "description": "详细描述",
    "assignee": "负责大臣的名字（可选）",
    "priority": "high/medium/low"
  }
]`
      },
      {
        role: 'user',
        content: `议题：${debate.topic}\n\n朝议记录：\n${debateSummary}\n\n请提取行动清单。`
      }
    ]

    const content = await provider.chatStream(messages, () => {})

    try {
      let jsonStr = content
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (jsonMatch) jsonStr = jsonMatch[1].trim()

      const braceMatch = jsonStr.match(/\[[\s\S]*\]/)
      if (braceMatch) jsonStr = braceMatch[0]

      const items = JSON.parse(jsonStr)
      if (Array.isArray(items)) {
        return items.map((item: any, i: number) => ({
          id: `action-${Date.now()}-${i}`,
          title: item.title || `行动项 ${i + 1}`,
          description: item.description || '',
          assignee: item.assignee,
          priority: ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium',
          status: 'pending' as const
        }))
      }
    } catch {
      // 解析失败
    }

    return []
  }

  /**
   * 生成完整报告
   * 基于朝议内容生成 Markdown 格式的分析报告
   */
  async generateReport(
    debate: Debate,
    ministers: Minister[],
    llmConfig: LLMConfig
  ): Promise<string> {
    const provider = createProvider(llmConfig)
    const debateSummary = this.buildDebateSummary(debate, ministers)

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是一位专业的分析师。请基于朝议讨论内容，生成一份结构化的分析报告。

报告格式要求（Markdown）：
1. 标题和概述
2. 各方观点摘要
3. 共识与分歧分析
4. 关键发现和洞察
5. 建议和下一步行动

语气专业、客观、有条理。使用 Markdown 格式。`
      },
      {
        role: 'user',
        content: `议题：${debate.topic}\n\n朝议记录：\n${debateSummary}\n\n请生成分析报告。`
      }
    ]

    return await provider.chatStream(messages, () => {})
  }

  /**
   * 生成决策质量报告（四象限）
   * 拍板后由丞相汇总产出：共识点 / 分歧点 / 风险清单 / 待验证假设
   * 用于把辩论结果变成可执行、可复盘的决策产物
   */
  async generateDecisionReport(
    debate: Debate,
    ministers: Minister[],
    llmConfig: LLMConfig
  ): Promise<DecisionReport> {
    const provider = createProvider(llmConfig)
    const debateSummary = this.buildDebateSummary(debate, ministers)

    // 准备角色列表，让 LLM 能准确映射 source
    const ministerCatalog = ministers
      .map(m => `- ${m.name}（id: ${m.id}，title: ${m.title}）`)
      .join('\n')

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是帝王的谋士兼书记官。你的任务是把一场朝议整理成结构化的「决策报告」，按四个象限分类：

1. consensus（共识点）：多位角色共同支持的观点、事实或结论
2. disagreements（分歧点）：角色间存在争议或不同立场的内容
3. risks（风险清单）：需要注意的潜在问题、障碍或代价
4. assumptions（待验证假设）：尚未确认、需要后续验证的前提、数据或结论

每个象限输出 0-5 条，每条包含：
- title：简洁标题（不超过 15 字）
- detail：具体说明（不超过 80 字）
- sources：提出这条的角色 id 数组（如 ["chancellor", "censor"]），必须使用下面提供的角色 id
- importance：1-5 的重要程度

另外输出：
- verdict：一句话决策结论（不超过 30 字）
- nextSteps：下一步行动建议（3-5 条，按优先级排序，每条不超过 40 字）

严格以 JSON 格式输出，不要使用 markdown 代码块包裹，不要包含其他文字。`
      },
      {
        role: 'user',
        content: `议题：${debate.topic}\n\n参与角色目录：\n${ministerCatalog}\n\n朝议记录：\n${debateSummary}\n\n请生成决策报告 JSON。`
      }
    ]

    const content = await provider.chatStream(messages, () => {})

    // 容错解析 JSON
    const emptyReport = (): DecisionReport => ({
      consensus: [],
      disagreements: [],
      risks: [],
      assumptions: [],
      generatedAt: Date.now(),
      generatedBy: `${llmConfig.provider}:${llmConfig.model}`
    })

    try {
      let jsonStr = content
      const codeMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (codeMatch) jsonStr = codeMatch[1].trim()
      const braceMatch = jsonStr.match(/\{[\s\S]*\}/)
      if (braceMatch) jsonStr = braceMatch[0]

      const parsed = JSON.parse(jsonStr)
      const normalize = (items: any[]): DecisionEntry[] => {
        if (!Array.isArray(items)) return []
        return items.slice(0, 8).map((it, i) => ({
          id: `entry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          title: String(it.title || '').slice(0, 40) || `条目 ${i + 1}`,
          detail: String(it.detail || '').slice(0, 200),
          sources: Array.isArray(it.sources) ? it.sources.filter((s: any) => typeof s === 'string') : [],
          importance: Math.max(1, Math.min(5, Number(it.importance) || 3))
        }))
      }

      return {
        consensus: normalize(parsed.consensus),
        disagreements: normalize(parsed.disagreements),
        risks: normalize(parsed.risks),
        assumptions: normalize(parsed.assumptions),
        verdict: typeof parsed.verdict === 'string' ? parsed.verdict.slice(0, 200) : undefined,
        nextSteps: Array.isArray(parsed.nextSteps)
          ? parsed.nextSteps.slice(0, 8).map((s: any) => String(s).slice(0, 100))
          : undefined,
        generatedAt: Date.now(),
        generatedBy: `${llmConfig.provider}:${llmConfig.model}`
      }
    } catch (err) {
      console.warn('[PostDebate] 决策报告 JSON 解析失败，返回空报告:', err)
      return emptyReport()
    }
  }

  /**
   * 批量执行退朝动作
   */
  async executePostDebate(
    debate: Debate,
    ministers: Minister[],
    llmConfig: LLMConfig,
    actions: PostDebateAction[]
  ): Promise<PostDebateResult> {
    const result: PostDebateResult = { errors: [] }

    for (const action of actions) {
      try {
        switch (action) {
          case 'decree':
            result.decree = await this.generateImperialDecree(debate, ministers, llmConfig)
            break
          case 'action-items':
            result.actionItems = await this.generateActionItems(debate, ministers, llmConfig)
            break
          case 'report':
            result.report = await this.generateReport(debate, ministers, llmConfig)
            break
          case 'decision-report':
            const report = await this.generateDecisionReport(debate, ministers, llmConfig)
            ;(result as any).decisionReport = report
            break
        }
      } catch (error) {
        result.errors.push(`${action}: ${error instanceof Error ? error.message : '未知错误'}`)
      }
    }

    return result
  }

  /**
   * 构建朝议摘要（供 LLM 使用）
   */
  private buildDebateSummary(debate: Debate, ministers: Minister[]): string {
    return debate.speeches
      .filter(s => s.status === 'completed' && s.content)
      .map(s => {
        if (s.ministerId === 'emperor') {
          return `【圣上】：${s.content}`
        }
        const minister = ministers.find(m => m.id === s.ministerId)
        const name = minister?.name || s.ministerId
        const title = minister?.title || ''
        const toolInfo = s.toolCalls && s.toolCalls.length > 0
          ? `（使用了 ${s.toolCalls.length} 个工具辅助分析）`
          : ''
        return `【${name}（${title}）】${toolInfo}：${s.content}`
      })
      .join('\n\n')
  }
}

/** 全局 PostDebateExecutor 单例 */
export const postDebateExecutor = new PostDebateExecutor()
