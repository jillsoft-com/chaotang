/**
 * Skill 行为契约注入（M4.5）
 *
 * 一份能力该怎么用，光靠工具 description 说不清：16 个浏览器工具的描述里各塞一段
 * 小作文，既撑爆工具 JSON，也会被工具选择器按数量截断（DEFAULT_MAX_TOOLS=12）。
 * 所以纪律单独写在 skill.guidance 里，这里只负责一件事：
 * **本轮真的把这组工具发给了模型，才把这组工具的契约一起发出去。**
 *
 * 「跟着工具走」而不是「跟着角色走」是这个设计的关键，它让三种情况自动正确：
 * 1. 工具被筛选掉了 —— 契约也不会出现，不占上下文；
 * 2. 子 Agent 用黑白名单过滤过工具 —— 用过滤后的列表算，不会留下越权的说明书；
 * 3. 同一角色绑定多个 Skill —— 各段契约并列，互不覆盖。
 *
 * 注意：本模块只依赖 registry，不要图省事改成从 './index' 引入，
 * 那会把 defaults.ts（以及它 import 的全部工具实现）拖进每个调用方的依赖链。
 */

import type { Skill, ToolDefinition } from '@/types'
import { skillRegistry } from './registry'

/**
 * 单个 Skill 契约的字符上限。
 * 契约是常驻上下文的东西，插件作者写飞了（整篇博客粘进 SKILL.md）必须截断，
 * 宁可缺一半纪律，也不能把任务描述与代码上下文挤掉。
 */
export const MAX_GUIDANCE_CHARS = 4000

/** 契约段落的总预算：多条 Skill 并列时后面的按整段丢弃，不做半句截断，免得读起来像乱码 */
const MAX_TOTAL_GUIDANCE_CHARS = 8000

function toolNames(tools: ToolDefinition[]): string[] {
  return tools.map(t => t.function?.name).filter((n): n is string => typeof n === 'string' && !!n)
}

/** 取单个 Skill 的契约文本（已注册与未注册的 Skill 都兼容） */
export function guidanceOf(skill: Pick<Skill, 'guidance'> | undefined): string {
  const text = (skill?.guidance || '').trim()
  if (!text) return ''
  return text.length > MAX_GUIDANCE_CHARS ? `${text.slice(0, MAX_GUIDANCE_CHARS)}\n…（契约过长已截断）` : text
}

/**
 * 按「本轮实际发给模型的工具列表」组装契约段落。
 *
 * @param toolDefs 已经过工具选择器/子 Agent 过滤的最终工具列表
 * @returns 以空行分隔的完整段落；没有任何契约命中时返回空串（调用方可直接拼）
 */
export function buildSkillGuidance(toolDefs: ToolDefinition[]): string {
  const sent = new Set(toolNames(toolDefs || []))
  if (sent.size === 0) return ''

  const blocks: string[] = []
  let budget = MAX_TOTAL_GUIDANCE_CHARS
  // getAllSkills 的顺序即注册顺序，保证同一轮多次调用的拼串稳定（可复现、可比对）
  for (const skill of skillRegistry.getAllSkills()) {
    const text = guidanceOf(skill)
    if (!text) continue
    // 只要该 Skill 有一个工具真的出现在本轮工具列表里，它的契约就该被读到
    if (!toolNames(skill.tools).some(name => sent.has(name))) continue
    if (text.length > budget) continue
    budget -= text.length
    blocks.push(text)
  }

  if (blocks.length === 0) return ''
  return `\n\n=== 能力使用契约（由程序按本轮工具自动注入） ===\n${blocks.join('\n\n')}\n=== 契约结束 ===`
}
