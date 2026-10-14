/**
 * 轻量级向量索引 — TF-IDF + 余弦相似度（基线） + 嵌入 API 预留
 *
 * 设计目标：
 * 1. 无外部依赖，纯 JS 实现
 * 2. 默认使用 TF-IDF 向量化 + 余弦相似度检索
 * 3. 预留 embed(text) 接口：如果配置了嵌入 API（如 OpenAI embeddings），
 *    自动切换为真实向量；否则降级为 TF-IDF
 * 4. 支持增量添加文档、批量索引、Top-K 检索
 *
 * 设计依据：编码能力二期升级 Phase 5。
 */

// ============ 类型 ============

/** 文档条目 */
export interface VectorDocument {
  /** 唯一 ID */
  id: string
  /** 文本内容 */
  text: string
  /** 元数据（如文件路径、行号等） */
  metadata?: Record<string, any>
}

/** 检索结果 */
export interface VectorSearchResult {
  /** 文档 ID */
  id: string
  /** 相似度得分（0-1） */
  score: number
  /** 文档文本 */
  text: string
  /** 元数据 */
  metadata?: Record<string, any>
}

/** 嵌入函数类型 */
export type EmbedFunction = (text: string) => Promise<number[]>

/** 向量索引配置 */
export interface VectorIndexConfig {
  /** 嵌入函数（可选，不提供则使用 TF-IDF） */
  embedFn?: EmbedFunction
  /** TF-IDF 最大词汇量（默认 10000） */
  maxVocabSize?: number
  /** 是否使用 IDF 加权（默认 true） */
  useIdf?: boolean
}

// ============ TF-IDF 实现 ============

/**
 * 简易分词器：支持中英文
 * 英文按空格/标点分词，中文按字符 bigram
 */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()

  // 英文单词
  const words = lower.match(/[a-z_][a-z0-9_]{2,}/g)
  if (words) tokens.push(...words)

  // 中文 bigram
  const chineseChars = lower.match(/[\u4e00-\u9fff]+/g)
  if (chineseChars) {
    for (const segment of chineseChars) {
      for (let i = 0; i < segment.length - 1; i++) {
        tokens.push(segment.slice(i, i + 2))
      }
      // 单字也加入（用于短查询匹配）
      if (segment.length <= 2) {
        tokens.push(segment)
      }
    }
  }

  // 代码标识符（驼峰/下划线拆分）
  const camelParts = lower.match(/[a-z]+[A-Z][a-z]*/g)
  if (camelParts) {
    for (const part of camelParts) {
      const split = part.replace(/[A-Z]/g, m => ' ' + m.toLowerCase()).trim().split(/\s+/)
      tokens.push(...split.filter(s => s.length >= 2))
    }
  }

  return tokens
}

/**
 * 停用词表（中英文常见词）
 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'at', 'by', 'with', 'from', 'as', 'into', 'through', 'during',
  'and', 'but', 'or', 'not', 'no', 'if', 'then', 'than', 'so', 'that',
  'this', 'it', 'its', 'he', 'she', 'they', 'we', 'you', 'i', 'me',
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都',
  '一', '一个', '上', '也', '很', '到', '说', '为', '去', '能', '会'
])

/**
 * TF-IDF 向量索引
 */
class TfIdfIndex {
  private maxVocabSize: number
  private useIdf: boolean

  /** 词汇表：token → 维度索引 */
  private vocab = new Map<string, number>()
  /** 文档频率：token → 包含该 token 的文档数 */
  private docFreq = new Map<string, number>()
  /** 已索引的文档：id → { tokens, text, metadata } */
  private docs = new Map<string, { tokens: string[]; text: string; metadata?: Record<string, any> }>()
  /** 总文档数 */
  private docCount = 0

  constructor(maxVocabSize = 10000, useIdf = true) {
    this.maxVocabSize = maxVocabSize
    this.useIdf = useIdf
  }

  /**
   * 添加文档到索引
   */
  add(doc: VectorDocument): void {
    const tokens = tokenize(doc.text).filter(t => !STOP_WORDS.has(t))
    this.docs.set(doc.id, { tokens, text: doc.text, metadata: doc.metadata })
    this.docCount++

    // 更新文档频率
    const uniqueTokens = new Set(tokens)
    for (const token of uniqueTokens) {
      this.docFreq.set(token, (this.docFreq.get(token) || 0) + 1)
    }

    // 词汇表按需扩展
    for (const token of uniqueTokens) {
      if (!this.vocab.has(token) && this.vocab.size < this.maxVocabSize) {
        this.vocab.set(token, this.vocab.size)
      }
    }
  }

  /**
   * 批量添加文档
   */
  addAll(docs: VectorDocument[]): void {
    for (const doc of docs) {
      this.add(doc)
    }
  }

  /**
   * 移除文档
   */
  remove(id: string): void {
    const doc = this.docs.get(id)
    if (!doc) return

    // 更新文档频率
    const uniqueTokens = new Set(doc.tokens)
    for (const token of uniqueTokens) {
      const freq = this.docFreq.get(token) || 0
      if (freq <= 1) {
        this.docFreq.delete(token)
      } else {
        this.docFreq.set(token, freq - 1)
      }
    }

    this.docs.delete(id)
    this.docCount--
  }

  /**
   * 清空索引
   */
  clear(): void {
    this.vocab.clear()
    this.docFreq.clear()
    this.docs.clear()
    this.docCount = 0
  }

  /**
   * 检索 Top-K 相关文档
   */
  search(query: string, topK = 5): VectorSearchResult[] {
    if (this.docCount === 0) return []

    const queryTokens = tokenize(query).filter(t => !STOP_WORDS.has(t))
    if (queryTokens.length === 0) return []

    // 计算查询 TF-IDF 向量
    const queryTf = this.computeTf(queryTokens)
    const queryVec = this.buildTfIdfVector(queryTf)

    // 计算每个文档的 TF-IDF 向量并求余弦相似度
    const results: VectorSearchResult[] = []

    for (const [id, doc] of this.docs) {
      const docTf = this.computeTf(doc.tokens)
      const docVec = this.buildTfIdfVector(docTf)
      const score = cosineSimilarity(queryVec, docVec)

      if (score > 0) {
        results.push({
          id,
          score,
          text: doc.text,
          metadata: doc.metadata
        })
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }

  /** 计算词频（归一化） */
  private computeTf(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>()
    if (tokens.length === 0) return tf
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1)
    }
    // 归一化
    const max = Math.max(...tf.values())
    if (max > 0) {
      for (const [k, v] of tf) {
        tf.set(k, v / max)
      }
    }
    return tf
  }

  /** 构建 TF-IDF 稀疏向量（用 Map 表示） */
  private buildTfIdfVector(tf: Map<string, number>): Map<string, number> {
    if (!this.useIdf) return tf

    const vec = new Map<string, number>()
    const N = Math.max(this.docCount, 1)

    for (const [token, tfVal] of tf) {
      const df = this.docFreq.get(token) || 1
      const idf = Math.log(N / df) + 1 // 平滑 IDF
      vec.set(token, tfVal * idf)
    }

    return vec
  }

  /** 获取索引大小 */
  get size(): number {
    return this.docCount
  }
}

// ============ 余弦相似度 ============

/**
 * 计算两个稀疏向量的余弦相似度
 * 稀疏向量用 Map<string, number> 表示
 */
function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  // 计算点积（只遍历较小的向量）
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a]

  for (const [key, valA] of smaller) {
    const valB = larger.get(key)
    if (valB !== undefined) {
      dotProduct += valA * valB
    }
  }

  for (const val of a.values()) normA += val * val
  for (const val of b.values()) normB += val * val

  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom > 0 ? dotProduct / denom : 0
}

/**
 * 计算两个稠密向量的余弦相似度
 */
function cosineSimilarityDense(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom > 0 ? dotProduct / denom : 0
}

// ============ 向量索引（统一接口） ============

/**
 * 统一向量索引
 *
 * 如果配置了 embed 函数，使用真实嵌入向量；
 * 否则降级为 TF-IDF 检索。
 */
export class VectorIndex {
  private config: VectorIndexConfig
  private tfidf: TfIdfIndex
  /** 嵌入向量缓存：id → vector */
  private embedCache = new Map<string, number[]>()
  /** 文档缓存（嵌入模式）：id → { text, metadata } */
  private docStore = new Map<string, { text: string; metadata?: Record<string, any> }>()
  /** 是否使用嵌入模式 */
  private useEmbed: boolean

  constructor(config: VectorIndexConfig = {}) {
    this.config = {
      maxVocabSize: 10000,
      useIdf: true,
      ...config
    }
    this.tfidf = new TfIdfIndex(this.config.maxVocabSize, this.config.useIdf)
    this.useEmbed = !!config.embedFn
  }

  /**
   * 添加文档
   */
  async add(doc: VectorDocument): Promise<void> {
    // TF-IDF 模式始终维护（作为降级方案）
    this.tfidf.add(doc)

    // 嵌入模式：额外计算并缓存向量
    if (this.useEmbed && this.config.embedFn) {
      try {
        const vector = await this.config.embedFn(doc.text)
        this.embedCache.set(doc.id, vector)
        this.docStore.set(doc.id, { text: doc.text, metadata: doc.metadata })
      } catch {
        // 嵌入失败，降级为 TF-IDF
      }
    }
  }

  /**
   * 批量添加文档
   */
  async addAll(docs: VectorDocument[]): Promise<void> {
    for (const doc of docs) {
      await this.add(doc)
    }
  }

  /**
   * 移除文档
   */
  remove(id: string): void {
    this.tfidf.remove(id)
    this.embedCache.delete(id)
    this.docStore.delete(id)
  }

  /**
   * 清空索引
   */
  clear(): void {
    this.tfidf.clear()
    this.embedCache.clear()
    this.docStore.clear()
  }

  /**
   * 语义检索
   *
   * 如果配置了嵌入函数且缓存中有向量，使用真实嵌入检索；
   * 否则降级为 TF-IDF 检索。
   */
  async search(query: string, topK = 5): Promise<VectorSearchResult[]> {
    // 嵌入模式
    if (this.useEmbed && this.config.embedFn && this.embedCache.size > 0) {
      try {
        const queryVector = await this.config.embedFn(query)
        return this.searchByEmbedding(queryVector, topK)
      } catch {
        // 嵌入失败，降级为 TF-IDF
      }
    }

    // TF-IDF 降级
    return this.tfidf.search(query, topK)
  }

  /**
   * 使用嵌入向量检索
   */
  private searchByEmbedding(queryVector: number[], topK: number): VectorSearchResult[] {
    const results: VectorSearchResult[] = []

    for (const [id, docVector] of this.embedCache) {
      if (docVector.length !== queryVector.length) continue
      const score = cosineSimilarityDense(queryVector, docVector)
      if (score > 0) {
        const doc = this.docStore.get(id)
        results.push({
          id,
          score,
          text: doc?.text || '',
          metadata: doc?.metadata
        })
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }

  /** 获取索引大小 */
  get size(): number {
    return this.tfidf.size
  }

  /** 是否使用嵌入模式 */
  get isEmbedMode(): boolean {
    return this.useEmbed && this.embedCache.size > 0
  }
}

// ============ 便捷工厂 ============

/**
 * 创建 TF-IDF 向量索引（无需外部依赖）
 */
export function createTfIdfIndex(config?: Omit<VectorIndexConfig, 'embedFn'>): VectorIndex {
  return new VectorIndex(config)
}

/**
 * 创建嵌入向量索引（需要嵌入 API）
 */
export function createEmbedIndex(embedFn: EmbedFunction, config?: Omit<VectorIndexConfig, 'embedFn'>): VectorIndex {
  return new VectorIndex({ ...config, embedFn })
}
