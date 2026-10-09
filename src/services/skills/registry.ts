/**
 * SkillRegistry — 技能注册中心
 *
 * 管理所有 Skill 的注册、查询、角色绑定。
 * 将 Skill 中的 ToolDefinition 自动注册到 ToolExecutor。
 */

import type { Skill, SkillCategory, MinisterSkillBinding } from '@/types'
import type { ToolDefinition } from '@/types'
import { toolExecutor } from '@/services/tools/executor'
import type { ToolHandler } from '@/types'

/** Skill 注册条目 */
interface RegisteredSkill {
  skill: Skill
  handlers: Map<string, ToolHandler> // functionName → handler
}

export class SkillRegistry {
  private skills = new Map<string, RegisteredSkill>()
  private bindings = new Map<string, Set<string>>() // ministerId → Set<skillId>

  constructor() {
    this.loadBindings()
  }

  /**
   * 注册一个 Skill
   */
  register(skill: Skill, handlers: Record<string, ToolHandler>): void {
    const handlerMap = new Map<string, ToolHandler>()

    for (const tool of skill.tools) {
      const fnName = tool.function.name
      const handler = handlers[fnName]
      if (handler) {
        handlerMap.set(fnName, handler)
        // 自动注册到 ToolExecutor
        toolExecutor.register(tool, handler, {
          displayName: `${skill.icon || ''}${skill.name} - ${tool.function.description}`
        })
      }
    }

    this.skills.set(skill.id, { skill, handlers: handlerMap })
  }

  /**
   * 注销一个 Skill
   */
  unregister(skillId: string): void {
    const registered = this.skills.get(skillId)
    if (!registered) return

    // 从 ToolExecutor 注销所有工具
    for (const tool of registered.skill.tools) {
      toolExecutor.unregister(tool.function.name)
    }

    // 移除所有绑定
    for (const [, skillIds] of this.bindings) {
      skillIds.delete(skillId)
    }

    this.skills.delete(skillId)
  }

  /**
   * 获取 Skill 定义
   */
  getSkill(skillId: string): Skill | undefined {
    return this.skills.get(skillId)?.skill
  }

  /**
   * 获取所有已注册的 Skills
   */
  getAllSkills(): Skill[] {
    return Array.from(this.skills.values()).map(r => r.skill)
  }

  /**
   * 按分类获取 Skills
   */
  getSkillsByCategory(category: SkillCategory): Skill[] {
    return this.getAllSkills().filter(s => s.category === category)
  }

  /**
   * 获取角色可用的 Skills
   */
  getSkillsForMinister(ministerId: string): Skill[] {
    const skillIds = this.bindings.get(ministerId)
    if (!skillIds) return []

    return Array.from(skillIds)
      .map(id => this.skills.get(id)?.skill)
      .filter((s): s is Skill => s !== undefined && s.enabled)
  }

  /**
   * 获取角色可用的 ToolDefinitions（发给 LLM）
   */
  getToolDefinitionsForMinister(ministerId: string): ToolDefinition[] {
    const skills = this.getSkillsForMinister(ministerId)
    return skills.flatMap(s => s.tools)
  }

  /**
   * 绑定 Skill 到角色
   */
  bindSkillToMinister(skillId: string, ministerId: string): void {
    if (!this.bindings.has(ministerId)) {
      this.bindings.set(ministerId, new Set())
    }
    this.bindings.get(ministerId)!.add(skillId)
    this.saveBindings()
  }

  /**
   * 解绑 Skill
   */
  unbindSkillFromMinister(skillId: string, ministerId: string): void {
    this.bindings.get(ministerId)?.delete(skillId)
    this.saveBindings()
  }

  /**
   * 获取角色所有绑定
   */
  getBindingsForMinister(ministerId: string): MinisterSkillBinding[] {
    const skillIds = this.bindings.get(ministerId)
    if (!skillIds) return []

    return Array.from(skillIds).map(skillId => ({
      ministerId,
      skillId,
      enabled: this.skills.get(skillId)?.skill.enabled ?? false
    }))
  }

  /**
   * 持久化绑定配置
   */
  private saveBindings(): void {
    const data: Record<string, string[]> = {}
    for (const [ministerId, skillIds] of this.bindings) {
      data[ministerId] = Array.from(skillIds)
    }
    localStorage.setItem('minister_skill_bindings', JSON.stringify(data))
  }

  /**
   * 加载绑定配置
   */
  private loadBindings(): void {
    const saved = localStorage.getItem('minister_skill_bindings')
    if (saved) {
      try {
        const data: Record<string, string[]> = JSON.parse(saved)
        for (const [ministerId, skillIds] of Object.entries(data)) {
          this.bindings.set(ministerId, new Set(skillIds))
        }
      } catch {
        // 解析失败，使用空绑定
      }
    }
  }
}

/** 全局 SkillRegistry 单例 */
export const skillRegistry = new SkillRegistry()
