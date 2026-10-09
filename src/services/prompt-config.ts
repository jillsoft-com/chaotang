import { getCurrentThemePrompts } from '@/services/dynasty-presets'

/**
 * Prompt 配置管理服务
 * 
 * 支持三种配置方式（优先级从高到低）：
 * 1. 主题级别提示词（自定义主题中为每个角色定义的 systemPrompt）
 * 2. 全局自定义（localStorage 中独立配置的 systemPrompt）
 * 3. MD 文件（默认配置，位于 src/prompts/）
 */

// 使用 Vite 的 import.meta.glob 加载所有 MD 文件
const promptModules = import.meta.glob('../prompts/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

export interface PromptConfig {
  systemPrompt: string
  description: string
  source: 'md' | 'custom' // 来源：md 文件 或 自定义
}

// 大臣 ID 到描述的映射（默认描述）
const defaultDescriptions: Record<string, string> = {
  chancellor: '全局视野，分析利弊，给出可执行方案',
  finance: '经济角度，数据驱动，成本收益分析',
  tutor: '历史借鉴，长远视角，因果逻辑分析',
  general: '安全与执行，风险评估，行动方案',
  censor: '发现问题漏洞，质疑假设，建设性批评',
  eunuch: '执行落地，人心博弈，阻力分析'
}

class PromptService {
  private storageKey = 'minister_prompts'

  /**
   * 从 MD 文件加载默认 Prompt
   */
  loadFromMD(ministerId: string): string {
    const path = `../prompts/${ministerId}.md`
    const content = promptModules[path]
    if (content) {
      // 将 MD 内容转换为纯文本（去掉 Markdown 标记）
      return this.mdToText(content)
    }
    return ''
  }

  /**
   * 将 Markdown 内容转换为适合 system prompt 的纯文本
   */
  private mdToText(md: string): string {
    return md
      .replace(/^# .+$/gm, '') // 去掉一级标题
      .replace(/^## /gm, '【') // 二级标题转换为标记
      .replace(/^$/gm, '\n') // 保留空行
      .replace(/^- /gm, '· ') // 列表项用中点
      .replace(/^\s*[\r\n]+/gm, '\n') // 清理多余空行
      .trim()
  }

  /**
   * 获取原始 MD 内容（用于编辑）
   */
  loadRawMD(ministerId: string): string {
    const path = `../prompts/${ministerId}.md`
    return promptModules[path] || ''
  }

  /**
   * 检查是否有对应的 MD 文件
   */
  hasMDFile(ministerId: string): boolean {
    const path = `../prompts/${ministerId}.md`
    return !!promptModules[path]
  }

  /**
   * 获取所有已保存的自定义 Prompt
   */
  getAllCustom(): Record<string, { systemPrompt: string; description?: string }> {
    const saved = localStorage.getItem(this.storageKey)
    return saved ? JSON.parse(saved) : {}
  }

  /**
   * 获取指定大臣的 Prompt 配置
   * 优先级：主题级别提示词 > localStorage 自定义 > MD 文件 > 空字符串
   */
  getPrompt(ministerId: string): PromptConfig {
    // 1. 检查当前主题的自定义提示词
    const themePrompts = getCurrentThemePrompts()
    if (themePrompts && themePrompts[ministerId]?.systemPrompt) {
      return {
        systemPrompt: themePrompts[ministerId].systemPrompt,
        description: themePrompts[ministerId].description || defaultDescriptions[ministerId] || '',
        source: 'custom'
      }
    }

    // 2. 检查 localStorage 全局自定义
    const custom = this.getAllCustom()
    if (custom[ministerId]?.systemPrompt) {
      return {
        systemPrompt: custom[ministerId].systemPrompt,
        description: custom[ministerId].description || defaultDescriptions[ministerId] || '',
        source: 'custom'
      }
    }

    // 3. 检查 MD 文件
    const mdPrompt = this.loadFromMD(ministerId)
    if (mdPrompt) {
      return {
        systemPrompt: mdPrompt,
        description: defaultDescriptions[ministerId] || '',
        source: 'md'
      }
    }

    return {
      systemPrompt: '',
      description: defaultDescriptions[ministerId] || '',
      source: 'md'
    }
  }

  /**
   * 保存自定义 Prompt
   */
  saveCustom(ministerId: string, systemPrompt: string, description?: string) {
    const all = this.getAllCustom()
    all[ministerId] = {
      systemPrompt,
      description: description || defaultDescriptions[ministerId] || ''
    }
    localStorage.setItem(this.storageKey, JSON.stringify(all))
  }

  /**
   * 删除自定义 Prompt（恢复为 MD 文件默认值）
   */
  removeCustom(ministerId: string) {
    const all = this.getAllCustom()
    delete all[ministerId]
    localStorage.setItem(this.storageKey, JSON.stringify(all))
  }

  /**
   * 重置所有自定义 Prompt
   */
  resetAll() {
    localStorage.removeItem(this.storageKey)
  }

  /**
   * 获取所有可用的大臣 ID 列表（基于 MD 文件）
   */
  getAvailableMinisterIds(): string[] {
    return Object.keys(promptModules).map(path => {
      const match = path.match(/prompts\/(.+)\.md$/)
      return match ? match[1] : ''
    }).filter(Boolean)
  }

  /**
   * 获取默认描述
   */
  getDefaultDescription(ministerId: string): string {
    return defaultDescriptions[ministerId] || ''
  }
}

export const promptService = new PromptService()
