/**
 * 树深度评估 — 用真实任务评估三层是否足够
 *
 * 收集三层不足的实际案例数据，编写评估报告。
 * 不自动开放五层，需人工评审后决策。
 *
 * 设计依据：朝堂任务树运行时改进说明 R10。
 */

// ============ 类型 ============

export interface DepthLimitCase {
  /** 案例 ID */
  id: string
  /** 辩论 ID */
  debateId: string
  /** 发生时间 */
  timestamp: number
  /** 树的运行 ID */
  runId: string
  /** 达到的最大深度 */
  maxDepthReached: number
  /** 深度限制值 */
  depthLimit: number
  /** 触发原因 */
  reason: DepthLimitReason
  /** 相关节点信息 */
  nodeContext: {
    nodeId: string
    nodeTitle: string
    childCount: number
    description: string
  }
}

export type DepthLimitReason =
  | 'leaf_too_complex'        // 叶子任务过于复杂，需进一步拆解
  | 'multi_file_coordination' // 需要跨文件协调
  | 'recursive_structure'     // 递归或嵌套结构
  | 'dependency_chain'        // 依赖链过长
  | 'other'                   // 其他

export interface DepthEvaluationReport {
  /** 报告生成时间 */
  generatedAt: number
  /** 总案例数 */
  totalCases: number
  /** 按原因分类统计 */
  reasonBreakdown: Record<DepthLimitReason, number>
  /** 最大深度分布 */
  depthDistribution: Record<number, number>
  /** 建议 */
  recommendations: string[]
  /** 是否建议扩展到五层 */
  shouldExpandToFiveLayers: boolean
  /** 详细案例列表 */
  cases: DepthLimitCase[]
}

// ============ 案例收集器 ============

const STORAGE_KEY = 'depth_evaluator_cases'

export class DepthEvaluator {
  private cases: DepthLimitCase[] = []

  constructor() {
    this.loadFromStorage()
  }

  /**
   * 记录一个深度限制案例
   *
   * 当叶子节点因深度限制无法进一步拆解时调用。
   */
  recordCase(params: Omit<DepthLimitCase, 'id' | 'timestamp'>): void {
    this.cases.push({
      ...params,
      id: `depth-case-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now()
    })
    this.saveToStorage()
  }

  /**
   * 获取所有已记录的案例
   */
  getCases(): ReadonlyArray<DepthLimitCase> {
    return this.cases
  }

  /**
   * 获取案例数量
   */
  getCaseCount(): number {
    return this.cases.length
  }

  /**
   * 清除所有案例数据
   */
  clear(): void {
    this.cases = []
    this.saveToStorage()
  }

  /**
   * 生成评估报告
   *
   * 基于收集的真实案例数据，生成深度评估报告。
   * 不自动开放五层：需人工评审后决策。
   */
  generateReport(): DepthEvaluationReport {
    // 按原因分类统计
    const reasonBreakdown: Record<string, number> = {}
    for (const c of this.cases) {
      reasonBreakdown[c.reason] = (reasonBreakdown[c.reason] || 0) + 1
    }

    // 深度分布
    const depthDistribution: Record<number, number> = {}
    for (const c of this.cases) {
      depthDistribution[c.maxDepthReached] = (depthDistribution[c.maxDepthReached] || 0) + 1
    }

    // 生成建议
    const recommendations: string[] = []
    const total = this.cases.length

    if (total === 0) {
      recommendations.push('尚未收集到深度不足案例，建议继续使用当前配置。')
    } else {
      // 分析主要原因
      const topReason = Object.entries(reasonBreakdown).sort((a, b) => b[1] - a[1])[0]
      if (topReason) {
        switch (topReason[0] as DepthLimitReason) {
          case 'leaf_too_complex':
            recommendations.push(`${topReason[1]}/${total} 案例因叶子过于复杂而需更深拆解。考虑提供更细粒度的任务描述。`)
            break
          case 'multi_file_coordination':
            recommendations.push(`${topReason[1]}/${total} 案例涉及跨文件协调。考虑在工作流中引入文件锁和协调节点。`)
            break
          case 'recursive_structure':
            recommendations.push(`${topReason[1]}/${total} 案例涉及递归结构。考虑改用迭代模式或增加深度限制。`)
            break
          case 'dependency_chain':
            recommendations.push(`${topReason[1]}/${total} 案例因依赖链过长。考虑重组任务依赖图。`)
            break
        }
      }

      // 五层扩展建议
      if (total >= 10) {
        recommendations.push('已收集 10 个以上深度不足案例，建议认真评估扩展到五层的必要性。')
      } else if (total >= 5) {
        recommendations.push('深度不足案例已达 5 个，建议持续观察并收集更多数据。')
      } else {
        recommendations.push(`仅 ${total} 个深度不足案例，建议继续使用当前配置并持续观察。`)
      }
    }

    // 是否建议扩展到五层（需要 10+ 案例且 >50% 是 leaf_too_complex）
    const leafComplexCount = reasonBreakdown['leaf_too_complex'] || 0
    const shouldExpand = total >= 10 && leafComplexCount > total * 0.5

    return {
      generatedAt: Date.now(),
      totalCases: total,
      reasonBreakdown: reasonBreakdown as Record<DepthLimitReason, number>,
      depthDistribution,
      recommendations,
      shouldExpandToFiveLayers: shouldExpand,
      cases: [...this.cases]
    }
  }

  /**
   * 序列化案例数据（用于持久化）
   */
  serialize(): string {
    return JSON.stringify(this.cases, null, 2)
  }

  /**
   * 从序列化数据恢复
   */
  deserialize(json: string): void {
    try {
      const data = JSON.parse(json)
      if (Array.isArray(data)) {
        this.cases = data
      }
    } catch { /* 解析失败保持空 */ }
  }

  // ============ 持久化 ============

  private loadFromStorage(): void {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const data = JSON.parse(saved)
        if (Array.isArray(data)) {
          this.cases = data
        }
      }
    } catch { /* 加载失败使用空集合 */ }
  }

  private saveToStorage(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.cases))
    } catch { /* 保存失败不抛错 */ }
  }
}

/** 全局深度评估器单例 */
export const depthEvaluator = new DepthEvaluator()
