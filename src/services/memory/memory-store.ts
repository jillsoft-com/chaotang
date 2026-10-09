/**
 * 持久记忆系统 — 跨会话记住项目知识和用户偏好
 *
 * 存储结构：localStorage key = 'agent_memories'
 * 每条记忆包含：类型、内容、标签、时间戳、来源会话
 *
 * 使用方式：
 * 1. Agent 通过 save_memory 工具主动存储重要信息
 * 2. 会话启动时自动加载相关记忆注入系统提示词
 * 3. 用户可在设置页查看/删除记忆
 */

// ============ 类型定义 ============

export type MemoryType = 'project' | 'preference' | 'fact' | 'decision' | 'pattern'

export interface Memory {
  id: string
  type: MemoryType
  content: string
  tags: string[]
  createdAt: number
  updatedAt: number
  sessionId?: string   // 来源会话
  importance: number   // 1-5，越高越重要
}

// ============ 记忆存储 ============

const STORAGE_KEY = 'agent_memories'
const MAX_MEMORIES = 200  // 最多存储 200 条记忆

class MemoryStore {
  private memories: Memory[] = []

  constructor() {
    this.load()
  }

  private load() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        this.memories = JSON.parse(saved)
      }
    } catch {
      this.memories = []
    }
  }

  private save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.memories))
  }

  /**
   * 添加一条记忆
   */
  add(params: {
    type: MemoryType
    content: string
    tags?: string[]
    importance?: number
    sessionId?: string
  }): Memory {
    const memory: Memory = {
      id: `mem-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      type: params.type,
      content: params.content,
      tags: params.tags || [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: params.sessionId,
      importance: params.importance || 3
    }

    this.memories.push(memory)

    // 超出上限时删除最旧的记忆（按 importance 和 updatedAt 排序）
    if (this.memories.length > MAX_MEMORIES) {
      this.memories.sort((a, b) => {
        // 先按 importance 降序，再按 updatedAt 降序
        if (b.importance !== a.importance) return b.importance - a.importance
        return b.updatedAt - a.updatedAt
      })
      this.memories = this.memories.slice(0, MAX_MEMORIES)
    }

    this.save()
    return memory
  }

  /**
   * 更新记忆内容
   */
  update(id: string, content: string): Memory | null {
    const memory = this.memories.find(m => m.id === id)
    if (!memory) return null
    memory.content = content
    memory.updatedAt = Date.now()
    this.save()
    return memory
  }

  /**
   * 删除记忆
   */
  delete(id: string): boolean {
    const index = this.memories.findIndex(m => m.id === id)
    if (index === -1) return false
    this.memories.splice(index, 1)
    this.save()
    return true
  }

  /**
   * 按标签搜索记忆
   */
  searchByTags(tags: string[]): Memory[] {
    const tagSet = new Set(tags.map(t => t.toLowerCase()))
    return this.memories.filter(m =>
      m.tags.some(t => tagSet.has(t.toLowerCase()))
    )
  }

  /**
   * 全文搜索记忆
   */
  search(query: string): Memory[] {
    const q = query.toLowerCase()
    return this.memories.filter(m =>
      m.content.toLowerCase().includes(q) ||
      m.tags.some(t => t.toLowerCase().includes(q))
    )
  }

  /**
   * 按类型获取记忆
   */
  getByType(type: MemoryType): Memory[] {
    return this.memories.filter(m => m.type === type)
  }

  /**
   * 获取所有记忆
   */
  getAll(): Memory[] {
    return [...this.memories].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * 获取总数
   */
  getCount(): number {
    return this.memories.length
  }

  /**
   * 清空所有记忆
   */
  clear() {
    this.memories = []
    this.save()
  }

  /**
   * 获取与当前上下文相关的记忆摘要（用于注入提示词）
   * @param workingDirectory 当前工作目录
   * @param topic 当前议题
   * @param maxChars 最大字符数
   */
  getContextSummary(workingDirectory?: string, topic?: string, maxChars = 2000): string {
    if (this.memories.length === 0) return ''

    // 筛选相关记忆：
    // 1. 高重要性记忆（importance >= 4）
    // 2. 与当前话题相关的记忆
    // 3. 最近更新的记忆
    const relevant = this.memories
      .filter(m => {
        // 高重要性记忆总是包含
        if (m.importance >= 4) return true
        // 如果有话题，搜索相关性
        if (topic) {
          const q = topic.toLowerCase()
          if (m.content.toLowerCase().includes(q)) return true
          if (m.tags.some(t => q.includes(t.toLowerCase()))) return true
        }
        // 如果有工作目录，包含项目相关记忆
        if (workingDirectory && m.tags.some(t => t.toLowerCase() === 'project')) return true
        return false
      })
      .sort((a, b) => {
        // 按 importance 降序，再按 updatedAt 降序
        if (b.importance !== a.importance) return b.importance - a.importance
        return b.updatedAt - a.updatedAt
      })
      .slice(0, 20)  // 最多 20 条

    if (relevant.length === 0) return ''

    const typeLabels: Record<MemoryType, string> = {
      project: '项目知识',
      preference: '用户偏好',
      fact: '已知事实',
      decision: '已做决策',
      pattern: '经验模式'
    }

    const lines = relevant.map(m => {
      const typeLabel = typeLabels[m.type] || '记忆'
      const tagStr = m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : ''
      return `- [${typeLabel}]${tagStr} ${m.content}`
    })

    let result = lines.join('\n')
    if (result.length > maxChars) {
      result = result.slice(0, maxChars) + '\n...(记忆过多已截断)'
    }

    return result
  }
}

// ============ 单例导出 ============

export const memoryStore = new MemoryStore()

// ============ 类型标签映射 ============

export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  project: '📁 项目知识',
  preference: '👤 用户偏好',
  fact: '📌 已知事实',
  decision: '⚖️ 已做决策',
  pattern: '🔍 经验模式'
}
