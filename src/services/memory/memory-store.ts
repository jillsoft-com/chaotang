/**
 * 持久记忆系统 — 跨会话记住项目知识和用户偏好
 *
 * 存储结构：存储后端 key = 'agent_memories'
 * 每条记忆包含：类型、内容、标签、时间戳、来源会话
 *
 * 使用方式：
 * 1. Agent 通过 save_memory 工具主动存储重要信息
 * 2. 会话启动时自动加载相关记忆注入系统提示词
 * 3. 用户可在设置页查看/删除记忆
 */

import { getStorageBackend } from '@/services/storage'
import { createTfIdfIndex } from '@/services/agent/vector-index'
import type { VectorDocument } from '@/services/agent/vector-index'

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
  private writeQueue: Promise<void> = Promise.resolve()
  readonly ready: Promise<void>

  constructor() {
    this.ready = this.load()
  }

  private async load(): Promise<void> {
    const saved = await getStorageBackend().get(STORAGE_KEY)
    if (saved) this.memories = JSON.parse(saved)
  }

  private async save(values: Memory[]): Promise<void> {
    await getStorageBackend().set(STORAGE_KEY, JSON.stringify(values))
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation)
    this.writeQueue = result.then(() => {}, () => {})
    return result
  }

  /**
   * 添加一条记忆
   */
  async add(params: {
    type: MemoryType
    content: string
    tags?: string[]
    importance?: number
    sessionId?: string
  }): Promise<Memory> {
    await this.ready
    return this.enqueue(async () => {
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

    let next = [...this.memories, memory]

    // 超出上限时删除最旧的记忆（按 importance 和 updatedAt 排序）
    if (next.length > MAX_MEMORIES) {
      next.sort((a, b) => {
        // 先按 importance 降序，再按 updatedAt 降序
        if (b.importance !== a.importance) return b.importance - a.importance
        return b.updatedAt - a.updatedAt
      })
      next = next.slice(0, MAX_MEMORIES)
    }

    await this.save(next)
    this.memories = next
    return memory
    })
  }

  /**
   * 更新记忆内容
   */
  async update(id: string, content: string): Promise<Memory | null> {
    await this.ready
    return this.enqueue(async () => {
    const memory = this.memories.find(m => m.id === id)
    if (!memory) return null
    const updated = { ...memory, content, updatedAt: Date.now() }
    const next = this.memories.map(item => item.id === id ? updated : item)
    await this.save(next)
    this.memories = next
    return updated
    })
  }

  /**
   * 删除记忆
   */
  async delete(id: string): Promise<boolean> {
    await this.ready
    return this.enqueue(async () => {
    const index = this.memories.findIndex(m => m.id === id)
    if (index === -1) return false
    const next = this.memories.filter(m => m.id !== id)
    await this.save(next)
    this.memories = next
    return true
    })
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
   * 语义搜索记忆 — 使用 VectorIndex 按语义相似度排序
   *
   * 将每条记忆作为文档构建向量索引，然后按与 query 的语义相似度排序。
   * 如果未配置嵌入 API，降级为 TF-IDF 检索。
   */
  async semanticSearch(query: string, topK = 10): Promise<Array<Memory & { score: number }>> {
    if (this.memories.length === 0 || !query.trim()) return []

    const vectorIndex = createTfIdfIndex()
    const docs: VectorDocument[] = this.memories.map(m => ({
      id: m.id,
      text: `${m.content} ${m.tags.join(' ')}`,
      metadata: { memoryId: m.id }
    }))
    await vectorIndex.addAll(docs)

    const results = await vectorIndex.search(query, topK)
    const memoryMap = new Map(this.memories.map(m => [m.id, m]))

    return results
      .map(r => {
        const memory = memoryMap.get(r.id)
        if (!memory) return null
        return { ...memory, score: r.score }
      })
      .filter((m): m is Memory & { score: number } => m !== null)
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
  async clear(): Promise<void> {
    await this.ready
    return this.enqueue(async () => {
      await this.save([])
      this.memories = []
    })
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
    // 2. 与当前话题相关的记忆（关键词 + 语义匹配）
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
          // 语义匹配：分词后检查任意词是否出现在内容中
          const topicWords = topic.toLowerCase().split(/[\s,;，；、]+/).filter(w => w.length >= 2)
          if (topicWords.some(w => m.content.toLowerCase().includes(w))) return true
          if (topicWords.some(w => m.tags.some(t => t.toLowerCase().includes(w)))) return true
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
