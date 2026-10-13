/**
 * 动态工具选择器 — 两级制智能筛选
 *
 * 解决问题：角色绑定的 Skill 过多时，全量 ToolDefinition 会消耗大量上下文窗口。
 *
 * 两级制流程：
 *   第一级 — 关键词召回（extractKeywords + scoreSkill，含 N-gram 补充）
 *          → 筛出候选集
 *   第二级 — 幕僚排序（LLM advisor 在候选中排序/补充）
 *          → 最终推荐列表
 *   程序把关 — 过滤权限 + 控制数量（maxTools 硬顶）
 *          → 最终 ToolDefinition 列表
 *
 * 三个步骤严格分离：
 *   1. Skill 被推荐（幕僚排序）→ 只是建议
 *   2. 工具定义送给模型（selectToolsForTopic 返回）→ 发给 LLM
 *   3. 工具获准执行（toolExecutor 权限检查）→ 程序把关
 *
 * 降级策略：
 *   - 工具总数 <= maxTools → 全量返回（无需筛选）
 *   - 幕僚不可用/超时/格式错误 → 回退到关键词匹配
 *   - 关键词匹配始终可用（无外部依赖）
 */

import type { ToolDefinition } from '@/types'
import type { Skill } from '@/types'
import { skillRegistry } from '@/services/skills/registry'
import { estimateTokens } from '@/utils/token-utils'
import { appStorage } from '@/services/storage'
import { analyzeAndRecommend } from '@/services/skills/llm-advisor'
import type { AdvisorMetrics, AdvisorResult } from '@/services/skills/llm-advisor'

// ============ 配置 ============

/** 始终包含的工具（核心基础设施，无论议题都需要） */
const ALWAYS_ON_TOOLS: ReadonlySet<string> = new Set([
  // 文件操作：几乎所有任务都需要读写文件
  'read_file', 'write_file', 'create_directory', 'read_directory',
  // 记忆：跨会话知识
  'save_memory', 'search_memory',
])

/** 默认最大工具数量 */
const DEFAULT_MAX_TOOLS = 12

/** 中文停用词（简化版，过滤无意义词） */
const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
  '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那', '些',
  '什么', '怎么', '如何', '为什么', '可以', '需要', '应该', '请', '帮',
  '做', '用', '把', '被', '让', '给', '从', '对', '与', '及', '等',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than',
  'too', 'very', 'just', 'because', 'if', 'when', 'while', 'about',
  'between', 'after', 'before', 'above', 'below', 'up', 'down',
])

// ============ 关键词提取 ============

/**
 * 从文本中提取有意义的关键词
 *
 * 包含 N-gram 补充：对中文文本额外生成 2-gram 和 3-gram，
 * 确保"代码质量""运行测试"等词组不被丢失。
 */
export function extractKeywords(text: string): string[] {
  if (!text) return []

  const lower = text.toLowerCase()

  // 1. 按非字母数字字符分割（支持中英文）
  const tokens = lower
    .split(/[^a-z0-9\u4e00-\u9fff\u3400-\u4dbf]+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t))

  const result = new Set(tokens)

  // 2. N-gram 补充：提取中文连续字符的 2-gram 和 3-gram
  const chineseChars = lower.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) || []
  for (const segment of chineseChars) {
    if (segment.length < 2) continue
    // 2-gram
    for (let i = 0; i <= segment.length - 2; i++) {
      const gram = segment.slice(i, i + 2)
      if (!STOP_WORDS.has(gram)) result.add(gram)
    }
    // 3-gram
    for (let i = 0; i <= segment.length - 3; i++) {
      const gram = segment.slice(i, i + 3)
      if (!STOP_WORDS.has(gram)) result.add(gram)
    }
  }

  return [...result]
}

// ============ 评分 ============

/**
 * 计算 Skill 与议题的相关性得分
 *
 * 评分维度：
 * 1. Skill 名称匹配（权重 3）
 * 2. Skill 描述匹配（权重 2）
 * 3. 工具描述匹配（权重 1）
 */
export function scoreSkill(skill: Skill, keywords: string[]): number {
  let score = 0

  const skillName = skill.name.toLowerCase()
  const skillDesc = skill.description.toLowerCase()
  const toolDescs = skill.tools.map(t => t.function.description.toLowerCase()).join(' ')

  for (const kw of keywords) {
    // 名称完全包含关键词
    if (skillName.includes(kw)) score += 3
    // 描述包含关键词
    if (skillDesc.includes(kw)) score += 2
    // 工具描述包含关键词
    if (toolDescs.includes(kw)) score += 1
  }

  return score
}

// ============ 第一级：关键词召回 ============

/**
 * 关键词召回：按相关性打分，筛出候选 Skill 集
 */
function recallByKeywords(
  allSkills: Skill[],
  keywords: string[]
): Array<{ skill: Skill; score: number }> {
  return allSkills
    .map(skill => ({ skill, score: scoreSkill(skill, keywords) }))
    .sort((a, b) => b.score - a.score)
}

// ============ 关键词兜底选择 ============

/**
 * 纯关键词匹配选择（幕僚不可用时的兜底）
 */
function selectByKeyword(
  allSkills: Skill[],
  keywords: string[],
  maxTools: number
): ToolDefinition[] {
  // 分类：核心工具 vs 可选工具
  const coreSkills: Skill[] = []
  const optionalSkills: Skill[] = []

  for (const skill of allSkills) {
    const hasAlwaysOnTool = skill.tools.some(t => ALWAYS_ON_TOOLS.has(t.function.name))
    if (hasAlwaysOnTool) {
      coreSkills.push(skill)
    } else {
      optionalSkills.push(skill)
    }
  }

  // 对可选 Skill 按相关性打分并排序
  const scored = recallByKeywords(optionalSkills, keywords)

  // 构建结果
  const selected: ToolDefinition[] = []
  const selectedNames = new Set<string>()

  // 1. 先添加核心工具（优先，但计入上限）
  for (const skill of coreSkills) {
    for (const tool of skill.tools) {
      if (selected.length >= maxTools) break
      if (!selectedNames.has(tool.function.name)) {
        selected.push(tool)
        selectedNames.add(tool.function.name)
      }
    }
  }

  // 2. 按分数添加可选工具，直到达到上限
  for (const { skill } of scored) {
    if (selected.length >= maxTools) break
    for (const tool of skill.tools) {
      if (selected.length >= maxTools) break
      if (!selectedNames.has(tool.function.name)) {
        selected.push(tool)
        selectedNames.add(tool.function.name)
      }
    }
  }

  return selected
}

// ============ 幕僚推荐应用 ============

/**
 * 将幕僚的推荐结果应用到工具选择中
 *
 * 程序把关：
 * - 核心工具始终包含
 * - 按幕僚推荐的优先级排序
 * - 受 maxTools 上限和 absoluteCap 硬顶保护
 */
function applyAdvisorRecommendations(
  allSkills: Skill[],
  advisorResult: AdvisorResult,
  maxTools: number
): ToolDefinition[] {
  // 构建 skillId → Skill 映射
  const skillMap = new Map<string, Skill>()
  for (const s of allSkills) skillMap.set(s.id, s)

  // 分类：核心 vs 可选
  const coreSkills: Skill[] = []
  const coreSkillIds = new Set<string>()
  for (const skill of allSkills) {
    if (skill.tools.some(t => ALWAYS_ON_TOOLS.has(t.function.name))) {
      coreSkills.push(skill)
      coreSkillIds.add(skill.id)
    }
  }

  // 按幕僚推荐排序可选 Skill
  const priorityOrder = { high: 0, medium: 1, low: 2 }
  const recommendedSkillIds = advisorResult.recommendations
    .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])
    .map(r => r.skillId)

  // 构建结果：maxTools 为绝对上限
  const selected: ToolDefinition[] = []
  const selectedNames = new Set<string>()

  // 1. 先添加核心工具（优先，但计入上限）
  for (const skill of coreSkills) {
    for (const tool of skill.tools) {
      if (selected.length >= maxTools) break
      if (!selectedNames.has(tool.function.name)) {
        selected.push(tool)
        selectedNames.add(tool.function.name)
      }
    }
  }

  // 2. 按幕僚推荐顺序添加可选工具
  for (const skillId of recommendedSkillIds) {
    if (selected.length >= maxTools) break
    if (coreSkillIds.has(skillId)) continue // 核心工具已添加

    const skill = skillMap.get(skillId)
    if (!skill) continue

    for (const tool of skill.tools) {
      if (selected.length >= maxTools) break
      if (!selectedNames.has(tool.function.name)) {
        selected.push(tool)
        selectedNames.add(tool.function.name)
      }
    }
  }

  return selected
}

// ============ 度量日志 ============

/** 记录幕僚调用度量 */
function logMetrics(metrics: AdvisorMetrics): void {
  const status = metrics.fallbackUsed ? '回退' : '幕僚'
  console.log(
    `[ToolSelector] ${status} | ${metrics.ministerId} | ` +
    `推荐 ${metrics.recommendedSkills} 个 | 最终 ${metrics.finalToolCount} 个 | ` +
    `~${metrics.estimatedTokens} tokens | ${metrics.latencyMs}ms | ` +
    `模型: ${metrics.advisorModelId}`
  )
}

// ============ 主入口 ============

/**
 * 根据议题为指定角色选择最相关的工具子集（两级制）
 *
 * 流程：
 * 1. 全量 <= maxTools → 直接返回
 * 2. 第一级：关键词召回候选
 * 3. 第二级：幕僚排序（如果启用且可用）
 * 4. 程序把关：过滤权限 + 控制数量
 * 5. 失败回退：关键词匹配
 *
 * @param ministerId 角色 ID
 * @param topic 当前议题/任务描述
 * @param maxTools 最大工具数量（默认 12）
 * @returns 筛选后的 ToolDefinition 列表
 */
export async function selectToolsForTopic(
  ministerId: string,
  topic: string,
  maxTools: number = DEFAULT_MAX_TOOLS
): Promise<ToolDefinition[]> {
  // 获取该角色绑定的所有 Skill
  const allSkills = skillRegistry.getSkillsForMinister(ministerId)
  if (allSkills.length === 0) return []

  // 如果总工具数 <= 上限，直接全量返回（无需筛选）
  const allToolDefs = allSkills.flatMap(s => s.tools)
  if (allToolDefs.length <= maxTools) return allToolDefs

  // 提取议题关键词
  const keywords = extractKeywords(topic)

  // 检查幕僚是否启用
  const enableAdvisor = appStorage.getItem('enable_llm_advisor') !== 'false'

  if (enableAdvisor) {
    const startTime = Date.now()
    try {
      // 第二级：幕僚排序
      const advisorResult = await analyzeAndRecommend({
        ministerId,
        userMessage: topic,
        availableSkills: allSkills,
        topic,
      })

      // 程序把关：应用推荐并控制数量
      const selected = applyAdvisorRecommendations(allSkills, advisorResult, maxTools)

      // 记录度量
      logMetrics({
        timestamp: startTime,
        ministerId,
        topicPreview: topic.slice(0, 80),
        totalSkills: allSkills.length,
        recommendedSkills: advisorResult.recommendations.length,
        finalToolCount: selected.length,
        estimatedTokens: estimateToolTokens(selected),
        latencyMs: Date.now() - startTime,
        fallbackUsed: false,
        advisorModelId: appStorage.getItem('summary_model_id') || 'default',
      })

      return selected
    } catch (err) {
      // 幕僚失败，静默回退到关键词匹配
      const latencyMs = Date.now() - startTime
      console.warn(`[ToolSelector] 幕僚调用失败，回退关键词匹配: ${err instanceof Error ? err.message : '未知错误'} (${latencyMs}ms)`)

      // 记录回退度量
      logMetrics({
        timestamp: startTime,
        ministerId,
        topicPreview: topic.slice(0, 80),
        totalSkills: allSkills.length,
        recommendedSkills: 0,
        finalToolCount: 0,
        estimatedTokens: 0,
        latencyMs,
        fallbackUsed: true,
        advisorModelId: 'fallback',
      })
    }
  }

  // 兜底：关键词匹配
  return selectByKeyword(allSkills, keywords, maxTools)
}

/**
 * 估算工具定义的总 token 消耗
 */
export function estimateToolTokens(tools: ToolDefinition[]): number {
  const json = JSON.stringify(tools)
  return estimateTokens(json)
}

/**
 * 获取工具选择建议日志（调试用）
 */
export async function getToolSelectionReport(
  ministerId: string,
  topic: string,
  maxTools?: number
): Promise<string> {
  const allSkills = skillRegistry.getSkillsForMinister(ministerId)
  const allTools = allSkills.flatMap(s => s.tools)
  const selected = await selectToolsForTopic(ministerId, topic, maxTools)
  const keywords = extractKeywords(topic)

  const lines: string[] = [
    `[ToolSelector] 角色: ${ministerId}`,
    `  议题: ${topic.slice(0, 80)}${topic.length > 80 ? '...' : ''}`,
    `  关键词: ${keywords.slice(0, 10).join(', ')}`,
    `  总工具: ${allTools.length} → 选择: ${selected.length}`,
    `  估算 tokens: ~${estimateToolTokens(selected)}`,
    `  选中: ${selected.map(t => t.function.name).join(', ')}`,
  ]

  // 被排除的工具
  const excluded = allTools.filter(t => !selected.some(s => s.function.name === t.function.name))
  if (excluded.length > 0) {
    lines.push(`  排除: ${excluded.map(t => t.function.name).join(', ')}`)
  }

  return lines.join('\n')
}
