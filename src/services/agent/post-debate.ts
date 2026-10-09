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

import type { Debate, Minister, ChatMessage, LLMConfig } from '@/types'
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
export type PostDebateAction = 'decree' | 'action-items' | 'report'

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
