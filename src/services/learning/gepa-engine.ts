/**
 * GEPA 自学习引擎 — Generative Embedded Policy Architecture
 *
 * 参考 Hermes 的 GEPA 机制，实现跨会话自学习：
 * 1. 从朝议结果中提取经验模式
 * 2. 识别重复出现的问题和解决方案
 * 3. 自动生成/更新 Skill 配置
 * 4. 跟踪学习进度和效果
 *
 * Sprint D - #17
 */

import type { Debate, DecisionReport } from '@/types'

// ============ 类型 ============

export interface LearningPattern {
  id: string
  /** 模式名称 */
  name: string
  /** 触发条件 */
  trigger: string
  /** 解决方案/建议 */
  solution: string
  /** 出现次数 */
  occurrenceCount: number
  /** 最近触发时间 */
  lastTriggered: number
  /** 用户反馈评分 1-5 */
  feedbackScore?: number
  /** 是否已转化为 Skill */
  promotedToSkill: boolean
  /** 来源辩论 ID 列表 */
  sourceDebates: string[]
}

export interface LearningEvent {
  id: string
  debateId: string
  timestamp: number
  type: 'pattern_discovered' | 'pattern_reinforced' | 'skill_promoted' | 'feedback_received'
  description: string
  patternId?: string
}

export interface LearningStats {
  totalPatterns: number
  promotedSkills: number
  totalEvents: number
  lastLearningTime: number
  averageFeedback: number
}

// ============ GEPA 引擎 ============

class GEPAEngine {
  private patterns = new Map<string, LearningPattern>()
  private events: LearningEvent[] = []
  private initialized = false

  constructor() {
    this.loadData()
  }

  /**
   * 初始化引擎（应用启动时调用）
   */
  initialize(): void {
    if (this.initialized) return
    this.initialized = true
    console.log(`[GEPA] 初始化完成，已加载 ${this.patterns.size} 个学习模式`)
  }

  /**
   * 从朝议结果中学习
   * 分析决策报告，提取可复用的模式
   */
  async learnFromDebate(debate: Debate, report?: DecisionReport): Promise<LearningEvent[]> {
    const newEvents: LearningEvent[] = []

    // 1. 从 nextSteps 中提取行动模式
    if (report?.nextSteps && report.nextSteps.length > 0) {
      for (const step of report.nextSteps) {
        const event = this.extractPattern(debate.id, debate.topic, step)
        if (event) newEvents.push(event)
      }
    }

    // 2. 从风险和假设中提取预防模式
    if (report?.risks && report.risks.length > 0) {
      for (const risk of report.risks) {
        const event = this.extractPreventionPattern(debate.id, debate.topic, risk.title, risk.detail)
        if (event) newEvents.push(event)
      }
    }

    // 3. 从共识中提取最佳实践
    if (report?.consensus && report.consensus.length > 0) {
      for (const item of report.consensus) {
        const event = this.extractBestPractice(debate.id, debate.topic, item.title)
        if (event) newEvents.push(event)
      }
    }

    // 4. 保存到持久记忆
    for (const event of newEvents) {
      this.events.push(event)
    }
    this.saveData()

    return newEvents
  }

  /**
   * 从行动项提取模式
   */
  private extractPattern(debateId: string, topic: string, actionStep: string): LearningEvent | null {
    // 提取关键动作和对象
    const keywords = this.extractKeywords(actionStep)
    if (keywords.length < 2) return null

    const patternKey = keywords.slice(0, 3).join('_')
    const existing = this.patterns.get(patternKey)

    if (existing) {
      // 模式已存在，增强计数
      existing.occurrenceCount++
      existing.lastTriggered = Date.now()
      if (!existing.sourceDebates.includes(debateId)) {
        existing.sourceDebates.push(debateId)
      }

      return {
        id: `event_${Date.now()}`,
        debateId,
        timestamp: Date.now(),
        type: 'pattern_reinforced',
        description: `模式 "${existing.name}" 再次出现（第 ${existing.occurrenceCount} 次）`,
        patternId: existing.id
      }
    }

    // 新模式
    const pattern: LearningPattern = {
      id: `pattern_${Date.now()}`,
      name: actionStep.slice(0, 50),
      trigger: topic,
      solution: actionStep,
      occurrenceCount: 1,
      lastTriggered: Date.now(),
      promotedToSkill: false,
      sourceDebates: [debateId]
    }

    this.patterns.set(patternKey, pattern)

    return {
      id: `event_${Date.now()}`,
      debateId,
      timestamp: Date.now(),
      type: 'pattern_discovered',
      description: `发现新模式: ${actionStep.slice(0, 50)}`,
      patternId: pattern.id
    }
  }

  /**
   * 从风险提取预防模式
   */
  private extractPreventionPattern(debateId: string, _topic: string, title: string, detail: string): LearningEvent | null {
    const keywords = this.extractKeywords(`${title} ${detail}`)
    if (keywords.length < 2) return null

    const patternKey = `risk_${keywords.slice(0, 2).join('_')}`
    const existing = this.patterns.get(patternKey)

    if (existing) {
      existing.occurrenceCount++
      existing.lastTriggered = Date.now()
      return {
        id: `event_${Date.now()}`,
        debateId,
        timestamp: Date.now(),
        type: 'pattern_reinforced',
        description: `预防模式 "${existing.name}" 再次出现`,
        patternId: existing.id
      }
    }

    const pattern: LearningPattern = {
      id: `pattern_${Date.now()}`,
      name: `[风险] ${title}`,
      trigger: `当 ${title} 相关场景出现时`,
      solution: detail.slice(0, 200),
      occurrenceCount: 1,
      lastTriggered: Date.now(),
      promotedToSkill: false,
      sourceDebates: [debateId]
    }

    this.patterns.set(patternKey, pattern)

    return {
      id: `event_${Date.now()}`,
      debateId,
      timestamp: Date.now(),
      type: 'pattern_discovered',
      description: `发现预防模式: ${title}`,
      patternId: pattern.id
    }
  }

  /**
   * 从共识提取最佳实践
   */
  private extractBestPractice(debateId: string, _topic: string, consensus: string): LearningEvent | null {
    const keywords = this.extractKeywords(consensus)
    if (keywords.length < 2) return null

    const patternKey = `bp_${keywords.slice(0, 2).join('_')}`
    const existing = this.patterns.get(patternKey)

    if (existing) {
      existing.occurrenceCount++
      existing.lastTriggered = Date.now()
      return {
        id: `event_${Date.now()}`,
        debateId,
        timestamp: Date.now(),
        type: 'pattern_reinforced',
        description: `最佳实践 "${existing.name}" 再次验证`,
        patternId: existing.id
      }
    }

    const pattern: LearningPattern = {
      id: `pattern_${Date.now()}`,
      name: `[最佳实践] ${consensus.slice(0, 40)}`,
      trigger: `当涉及 ${keywords.join(', ')} 时`,
      solution: consensus,
      occurrenceCount: 1,
      lastTriggered: Date.now(),
      promotedToSkill: false,
      sourceDebates: [debateId]
    }

    this.patterns.set(patternKey, pattern)

    return {
      id: `event_${Date.now()}`,
      debateId,
      timestamp: Date.now(),
      type: 'pattern_discovered',
      description: `发现最佳实践: ${consensus.slice(0, 40)}`,
      patternId: pattern.id
    }
  }

  /**
   * 简单的关键词提取（基于中文分词和停用词过滤）
   */
  private extractKeywords(text: string): string[] {
    const stopWords = new Set(['的', '了', '和', '与', '或', '在', '是', '为', '以', '将', '需要', '应该', '可以', '进行', '使用'])

    // 提取 2-4 字的词组
    const words: string[] = []
    const matches = text.match(/[\u4e00-\u9fff]{2,4}/g) || []

    for (const word of matches) {
      if (!stopWords.has(word) && word.length >= 2) {
        words.push(word)
      }
    }

    // 去重并按出现频率排序
    const freq = new Map<string, number>()
    for (const w of words) {
      freq.set(w, (freq.get(w) || 0) + 1)
    }

    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .map(e => e[0])
      .slice(0, 5)
  }

  /**
   * 记录用户反馈
   */
  recordFeedback(patternId: string, score: number): void {
    for (const pattern of this.patterns.values()) {
      if (pattern.id === patternId) {
        pattern.feedbackScore = score
        break
      }
    }
    this.events.push({
      id: `event_${Date.now()}`,
      debateId: '',
      timestamp: Date.now(),
      type: 'feedback_received',
      description: `模式 ${patternId} 收到评分: ${score}/5`
    })
    this.saveData()
  }

  /**
   * 将高频模式升级为 Skill
   */
  promoteToSkill(patternId: string): LearningEvent | null {
    for (const [, pattern] of this.patterns) {
      if (pattern.id === patternId) {
        if (pattern.promotedToSkill) return null

        pattern.promotedToSkill = true

        const event: LearningEvent = {
          id: `event_${Date.now()}`,
          debateId: '',
          timestamp: Date.now(),
          type: 'skill_promoted',
          description: `模式 "${pattern.name}" 已升级为 Skill`,
          patternId: pattern.id
        }

        this.events.push(event)
        this.saveData()

        // 保存到持久记忆（使用 localStorage 作为简化存储）
        const gepaMemories = JSON.parse(localStorage.getItem('gepa_promoted_skills') || '[]')
        gepaMemories.push({
          name: pattern.name,
          trigger: pattern.trigger,
          solution: pattern.solution,
          promotedAt: Date.now()
        })
        localStorage.setItem('gepa_promoted_skills', JSON.stringify(gepaMemories))

        return event
      }
    }
    return null
  }

  /**
   * 获取所有学习模式
   */
  getPatterns(): LearningPattern[] {
    return Array.from(this.patterns.values())
      .sort((a, b) => b.lastTriggered - a.lastTriggered)
  }

  /**
   * 获取可升级的模式（出现次数 >= 3 且未升级）
   */
  getPromotablePatterns(): LearningPattern[] {
    return this.getPatterns().filter(p => p.occurrenceCount >= 3 && !p.promotedToSkill)
  }

  /**
   * 获取学习统计
   */
  getStats(): LearningStats {
    const patterns = this.getPatterns()
    const promoted = patterns.filter(p => p.promotedToSkill).length
    const feedbacks = patterns.filter(p => p.feedbackScore).map(p => p.feedbackScore!)
    const avgFeedback = feedbacks.length > 0
      ? feedbacks.reduce((a, b) => a + b, 0) / feedbacks.length
      : 0

    return {
      totalPatterns: patterns.length,
      promotedSkills: promoted,
      totalEvents: this.events.length,
      lastLearningTime: this.events.length > 0
        ? this.events[this.events.length - 1].timestamp
        : 0,
      averageFeedback: avgFeedback
    }
  }

  /**
   * 获取最近的学习事件
   */
  getRecentEvents(limit: number = 20): LearningEvent[] {
    return this.events.slice(-limit).reverse()
  }

  /**
   * 根据当前话题检索相关模式
   */
  getRelevantPatterns(topic: string): LearningPattern[] {
    const keywords = this.extractKeywords(topic)
    if (keywords.length === 0) return []

    return this.getPatterns().filter(p => {
      const haystack = `${p.name} ${p.trigger} ${p.solution}`.toLowerCase()
      return keywords.some(k => haystack.includes(k.toLowerCase()))
    })
  }

  // ============ 持久化 ============

  private loadData(): void {
    try {
      const savedPatterns = localStorage.getItem('gepa_patterns')
      if (savedPatterns) {
        const arr: LearningPattern[] = JSON.parse(savedPatterns)
        for (const p of arr) {
          // 用触发关键词生成 key
          const keywords = this.extractKeywords(`${p.trigger} ${p.solution}`)
          const key = keywords.slice(0, 3).join('_') || p.id
          this.patterns.set(key, p)
        }
      }

      const savedEvents = localStorage.getItem('gepa_events')
      if (savedEvents) {
        this.events = JSON.parse(savedEvents)
      }
    } catch { /* 解析失败使用空集合 */ }
  }

  private saveData(): void {
    const patternsArr = Array.from(this.patterns.values())
    localStorage.setItem('gepa_patterns', JSON.stringify(patternsArr))
    localStorage.setItem('gepa_events', JSON.stringify(this.events))
  }
}

/** 全局 GEPA 引擎单例 */
export const gepaEngine = new GEPAEngine()
