/**
 * 辩论主题模板库 — 预设议题和角色配置
 *
 * 提供多种常用辩论场景的预设模板，用户可一键发起朝议。
 *
 * Sprint D - #2
 */

import type { DebateMode } from '@/types'

// 议题模式类型（扩展 DebateMode）
type TopicDebateMode = DebateMode | 'court'

// ============ 类型 ============

export interface TopicTemplate {
  id: string
  /** 模板名称 */
  name: string
  /** 模板分类 */
  category: 'technology' | 'business' | 'personal' | 'creative' | 'education' | 'general'
  /** 图标 */
  icon: string
  /** 议题描述 */
  topic: string
  /** 推荐的朝议模式 */
  recommendedMode?: TopicDebateMode
  /** 推荐参与的大臣 ID 列表 */
  recommendedMinisters?: string[]
  /** 附加上下文/背景信息 */
  context?: string
  /** 用户自定义字段（模板中的占位符） */
  placeholders?: TopicPlaceholder[]
  /** 预设工作目录（可选） */
  workingDirectory?: string
}

export interface TopicPlaceholder {
  /** 占位符名称（如 {project}） */
  key: string
  /** 占位符描述 */
  label: string
  /** 默认值 */
  defaultValue?: string
}

// ============ 内置模板 ============

export const TOPIC_TEMPLATES: TopicTemplate[] = [
  // === 技术类 ===
  {
    id: 'tech-architecture',
    name: '技术架构评审',
    category: 'technology',
    icon: '🏗️',
    topic: '对 {project} 项目的技术架构进行评审，分析当前架构的优缺点，评估是否需要重构，给出改进建议。',
    recommendedMode: 'agent',
    recommendedMinisters: ['chancellor', 'general', 'censor'],
    context: '请重点关注代码质量、可维护性、性能、安全性等方面。',
    placeholders: [
      { key: 'project', label: '项目名称', defaultValue: '当前项目' }
    ]
  },
  {
    id: 'tech-stack-selection',
    name: '技术栈选型',
    category: 'technology',
    icon: '🔧',
    topic: '为 {project} 项目选择合适的技术栈。需要从前端框架、后端框架、数据库、部署方案等方面给出推荐方案，并对比各方案的优劣。',
    recommendedMode: 'court',
    recommendedMinisters: ['chancellor', 'general', 'finance'],
    placeholders: [
      { key: 'project', label: '项目描述', defaultValue: '新项目' }
    ]
  },
  {
    id: 'refactor-decision',
    name: '重构决策',
    category: 'technology',
    icon: '♻️',
    topic: '{module} 模块的技术债务日益严重，需要决定是否进行重构。分析当前问题、重构成本、风险与收益，给出明确的决策建议。',
    recommendedMode: 'court',
    recommendedMinisters: ['chancellor', 'general', 'censor', 'finance'],
    placeholders: [
      { key: 'module', label: '模块名称', defaultValue: '核心模块' }
    ]
  },
  {
    id: 'bug-triage',
    name: 'Bug 优先级分析',
    category: 'technology',
    icon: '🐛',
    topic: '对当前版本的 Bug 列表进行优先级排序。需要分析每个 Bug 的影响范围、修复难度、紧急程度，给出修复计划建议。',
    recommendedMode: 'agent',
    recommendedMinisters: ['general', 'censor', 'chancellor']
  },

  // === 商业类 ===
  {
    id: 'product-strategy',
    name: '产品战略分析',
    category: 'business',
    icon: '📈',
    topic: '分析 {product} 的市场定位、竞争格局、用户需求和增长策略，给出产品发展方向建议。',
    recommendedMode: 'court',
    recommendedMinisters: ['chancellor', 'finance', 'tutor', 'general'],
    placeholders: [
      { key: 'product', label: '产品名称', defaultValue: '我们的产品' }
    ]
  },
  {
    id: 'investment-analysis',
    name: '投资可行性分析',
    category: 'business',
    icon: '💰',
    topic: '对 {target} 进行投资可行性分析。需要评估市场规模、竞争态势、财务模型、风险因素，给出投资建议。',
    recommendedMode: 'court',
    recommendedMinisters: ['chancellor', 'finance', 'censor'],
    placeholders: [
      { key: 'target', label: '投资标的/项目', defaultValue: '目标项目' }
    ]
  },
  {
    id: 'go-to-market',
    name: '上市/发布策略',
    category: 'business',
    icon: '🚀',
    topic: '制定 {product} 的上市/发布策略。需要确定目标用户、定价策略、推广渠道、时间节奏等关键要素。',
    recommendedMode: 'court',
    recommendedMinisters: ['chancellor', 'finance', 'tutor'],
    placeholders: [
      { key: 'product', label: '产品/功能名称', defaultValue: '新产品' }
    ]
  },
  {
    id: 'risk-assessment',
    name: '风险评估',
    category: 'business',
    icon: '⚠️',
    topic: '对 {project} 项目进行全面风险评估。识别技术风险、商业风险、运营风险，评估发生概率和影响程度，制定应对策略。',
    recommendedMode: 'court',
    recommendedMinisters: ['censor', 'chancellor', 'finance', 'general'],
    placeholders: [
      { key: 'project', label: '项目名称', defaultValue: '当前项目' }
    ]
  },

  // === 个人类 ===
  {
    id: 'career-decision',
    name: '职业选择',
    category: 'personal',
    icon: '🎯',
    topic: '面临 {choice} 的职业选择，需要从发展前景、薪酬待遇、成长空间、工作生活平衡等角度分析，给出建议。',
    recommendedMode: 'court',
    recommendedMinisters: ['tutor', 'chancellor', 'finance'],
    placeholders: [
      { key: 'choice', label: '选择描述', defaultValue: '工作选择' }
    ]
  },
  {
    id: 'learning-plan',
    name: '学习计划制定',
    category: 'personal',
    icon: '📚',
    topic: '为学习 {skill} 制定系统的学习计划。需要确定学习目标、学习路径、时间安排规划、推荐资源，并考虑实际可行性。',
    recommendedMode: 'court',
    recommendedMinisters: ['tutor', 'chancellor'],
    placeholders: [
      { key: 'skill', label: '学习技能', defaultValue: '编程技能' }
    ]
  },

  // === 创意类 ===
  {
    id: 'creative-brainstorm',
    name: '创意头脑风暴',
    category: 'creative',
    icon: '💡',
    topic: '围绕 {theme} 进行头脑风暴，从不同角度提出创新方案，评估各方案的可行性和吸引力。',
    recommendedMode: 'court',
    recommendedMinisters: ['tutor', 'general', 'chancellor', 'eunuch'],
    placeholders: [
      { key: 'theme', label: '创意主题', defaultValue: '新功能' }
    ]
  },
  {
    id: 'content-creation',
    name: '内容创作策划',
    category: 'creative',
    icon: '✍️',
    topic: '策划 {content_type} 的创作方案。确定目标受众、核心主题、风格定位、结构大纲和发布策略。',
    recommendedMode: 'court',
    recommendedMinisters: ['tutor', 'chancellor', 'eunuch'],
    placeholders: [
      { key: 'content_type', label: '内容类型', defaultValue: '技术博客' }
    ]
  },

  // === 教育类 ===
  {
    id: 'curriculum-design',
    name: '课程设计',
    category: 'education',
    icon: '🎓',
    topic: '设计 {course} 的课程大纲。确定教学目标、知识点体系、教学方法、考核方式和学习资源。',
    recommendedMode: 'court',
    recommendedMinisters: ['tutor', 'chancellor'],
    placeholders: [
      { key: 'course', label: '课程名称', defaultValue: '新课程' }
    ]
  },

  // === 通用类 ===
  {
    id: 'decision-analysis',
    name: '通用决策分析',
    category: 'general',
    icon: '⚖️',
    topic: '{decision}，需要从多个角度全面分析利弊，给出有理有据的建议。',
    recommendedMode: 'court',
    recommendedMinisters: ['chancellor', 'finance', 'tutor', 'censor'],
    placeholders: [
      { key: 'decision', label: '决策描述', defaultValue: '某个重要决策' }
    ]
  },
  {
    id: 'free-debate',
    name: '自由辩论',
    category: 'general',
    icon: '🗣️',
    topic: '',  // 用户自定义
    recommendedMode: 'court'
  }
]

// ============ 工具函数 ============

/**
 * 按分类获取模板
 */
export function getTemplatesByCategory(category: string): TopicTemplate[] {
  if (!category || category === 'all') return TOPIC_TEMPLATES
  return TOPIC_TEMPLATES.filter(t => t.category === category)
}

/**
 * 搜索模板
 */
export function searchTemplates(query: string): TopicTemplate[] {
  if (!query.trim()) return TOPIC_TEMPLATES
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean)
  return TOPIC_TEMPLATES.filter(t => {
    const haystack = `${t.name} ${t.topic} ${t.context || ''}`.toLowerCase()
    return keywords.some(k => haystack.includes(k))
  })
}

/**
 * 获取所有分类
 */
export function getTemplateCategories(): Array<{ id: string; name: string; icon: string }> {
  return [
    { id: 'all', name: '全部', icon: '📋' },
    { id: 'technology', name: '技术', icon: '💻' },
    { id: 'business', name: '商业', icon: '💼' },
    { id: 'personal', name: '个人', icon: '👤' },
    { id: 'creative', name: '创意', icon: '🎨' },
    { id: 'education', name: '教育', icon: '📚' },
    { id: 'general', name: '通用', icon: '⚖️' }
  ]
}

/**
 * 根据模板和占位符值生成最终议题
 */
export function applyTemplate(template: TopicTemplate, values: Record<string, string>): string {
  let result = template.topic
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value || key)
  }
  // 附加上下文
  if (template.context) {
    result += `\n\n${template.context}`
  }
  return result
}

/**
 * 获取指定模板
 */
export function getTemplate(id: string): TopicTemplate | undefined {
  return TOPIC_TEMPLATES.find(t => t.id === id)
}
