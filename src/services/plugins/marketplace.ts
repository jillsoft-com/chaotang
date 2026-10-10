/**
 * 插件市场 — 搜索、发现、安装和管理社区插件
 *
 * 功能：
 * 1. 内置插件目录（预置推荐插件）
 * 2. 从远程注册表搜索插件
 * 3. 安装/卸载插件到本地目录
 * 4. 版本跟踪与更新检查
 *
 * Sprint C - #14
 */

import { pluginManager_loadAll, pluginManager_unload, pluginManager_getAll } from './plugin-manager'
import type { LoadedPlugin } from './types'

// ============ 类型 ============

export interface MarketplacePlugin {
  id: string
  name: string
  description: string
  author: string
  version: string
  icon?: string
  category: string
  tags: string[]
  /** 插件仓库 URL 或下载地址 */
  source: string
  /** SKILL.md 内容模板（内置插件） */
  template?: string
  /** 已安装版本号（undefined = 未安装） */
  installedVersion?: string
  /** 下载次数（统计） */
  downloads?: number
  /** 评分 1-5 */
  rating?: number
}

export interface InstallResult {
  success: boolean
  pluginId: string
  version?: string
  error?: string
}

// ============ 内置插件目录 ============

const BUILTIN_PLUGINS: MarketplacePlugin[] = [
  {
    id: 'web-fetcher',
    name: '网页抓取',
    description: '抓取指定 URL 的网页内容，自动提取正文和关键信息',
    author: 'ChaoTang Official',
    version: '1.0.0',
    icon: '🌐',
    category: 'information',
    tags: ['web', 'scraping', 'html'],
    source: 'builtin',
    template: `---
id: web-fetcher
name: 网页抓取
description: 抓取指定 URL 的网页内容，提取正文和关键信息
icon: 🌐
category: information
tools:
  - name: fetch_webpage
    description: 抓取网页内容并提取正文
    parameters:
      type: object
      properties:
        url:
          type: string
          description: 网页 URL
        extractMode:
          type: string
          enum: [full, summary, links]
          description: 提取模式：完整内容/摘要/链接列表
      required: [url]
handler: |
  async function fetch_webpage(args) {
    const { url, extractMode = 'summary' } = args
    try {
      const response = await fetch(url)
      const html = await response.text()
      const parser = new DOMParser()
      const doc = parser.parseFromString(html, 'text/html')
      const title = doc.title || ''
      if (extractMode === 'links') {
        const links = Array.from(doc.querySelectorAll('a[href]'))
          .slice(0, 30)
          .map(a => ({ text: a.textContent?.trim() || '', href: a.getAttribute('href') || '' }))
        return { url, title, links }
      }
      const body = doc.body?.textContent?.trim() || ''
      const content = extractMode === 'summary' ? body.slice(0, 3000) : body
      return { url, title, content_length: content.length, content }
    } catch (err) {
      throw new Error('网页抓取失败: ' + (err?.message || '未知错误'))
    }
  }
`
  },
  {
    id: 'json-analyzer',
    name: 'JSON 分析器',
    description: '解析和分析 JSON 数据，支持查询、统计、格式化',
    author: 'ChaoTang Official',
    version: '1.0.0',
    icon: '📊',
    category: 'analysis',
    tags: ['json', 'data', 'analysis'],
    source: 'builtin',
    template: `---
id: json-analyzer
name: JSON 分析器
description: 解析和分析 JSON 数据
icon: 📊
category: analysis
tools:
  - name: analyze_json
    description: 分析 JSON 数据结构、统计字段分布
    parameters:
      type: object
      properties:
        data:
          type: string
          description: JSON 字符串
        query:
          type: string
          description: 可选的查询表达式（如 data.users.length）
      required: [data]
handler: |
  async function analyze_json(args) {
    const { data, query } = args
    try {
      const parsed = JSON.parse(data)
      const info = {
        type: Array.isArray(parsed) ? 'array' : typeof parsed,
        size: JSON.stringify(parsed).length,
        keys: typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [],
        arrayLength: Array.isArray(parsed) ? parsed.length : undefined
      }
      let queryResult
      if (query) {
        try {
          queryResult = new Function('data', 'return ' + query)(parsed)
        } catch { queryResult = '查询表达式无效' }
      }
      return { info, queryResult, sample: JSON.stringify(parsed).slice(0, 500) }
    } catch (err) {
      throw new Error('JSON 解析失败: ' + (err?.message || '无效 JSON'))
    }
  }
`
  },
  {
    id: 'datetime-tools',
    name: '日期时间工具',
    description: '日期计算、格式化、时区转换等工具',
    author: 'ChaoTang Official',
    version: '1.0.0',
    icon: '📅',
    category: 'system',
    tags: ['date', 'time', 'timezone'],
    source: 'builtin',
    template: `---
id: datetime-tools
name: 日期时间工具
description: 日期计算、格式化、时区转换
icon: 📅
category: system
tools:
  - name: datetime_calc
    description: 日期计算和格式化
    parameters:
      type: object
      properties:
        operation:
          type: string
          enum: [now, add, diff, format]
          description: 操作类型
        date:
          type: string
          description: 日期字符串（ISO 格式）
        value:
          type: string
          description: 附加值（如 +7d, -1M, 格式化模板）
      required: [operation]
handler: |
  async function datetime_calc(args) {
    const { operation, date, value } = args
    const d = date ? new Date(date) : new Date()
    switch (operation) {
      case 'now':
        return { iso: d.toISOString(), locale: d.toLocaleString('zh-CN'), timestamp: d.getTime() }
      case 'add': {
        const match = value?.match(/([+-]?\\d+)([dDwWmMyYhH])/)
        if (!match) throw new Error('value 格式应为 +7d / -1M 等')
        const num = parseInt(match[1])
        const unit = match[2].toUpperCase()
        const ms = { D: 86400000, W: 604800000, M: 2592000000, Y: 31536000000, H: 3600000 }[unit] || 86400000
        const result = new Date(d.getTime() + num * ms)
        return { original: d.toISOString(), result: result.toISOString(), locale: result.toLocaleString('zh-CN') }
      }
      case 'diff': {
        const target = new Date(value || '')
        const diffMs = target.getTime() - d.getTime()
        return { from: d.toISOString(), to: target.toISOString(), diffDays: Math.round(diffMs / 86400000), diffHours: Math.round(diffMs / 3600000) }
      }
      case 'format':
        return { formatted: d.toLocaleString('zh-CN'), iso: d.toISOString() }
      default:
        throw new Error('不支持的操作: ' + operation)
    }
  }
`
  },
  {
    id: 'text-summarizer',
    name: '文本摘要',
    description: '对长文本进行结构化摘要，提取关键信息',
    author: 'ChaoTang Official',
    version: '1.0.0',
    icon: '📝',
    category: 'generation',
    tags: ['nlp', 'summary', 'text'],
    source: 'builtin',
    template: `---
id: text-summarizer
name: 文本摘要
description: 对长文本提取关键句子和主题
icon: 📝
category: generation
tools:
  - name: summarize_text
    description: 提取文本中的关键句子
    parameters:
      type: object
      properties:
        text:
          type: string
          description: 原始文本
        maxSentences:
          type: integer
          description: 最大摘要句子数，默认 5
      required: [text]
handler: |
  async function summarize_text(args) {
    const { text, maxSentences = 5 } = args
    const sentences = text.split(/[。！？\\n]/).filter(s => s.trim().length > 10)
    const scored = sentences.map(s => ({
      text: s.trim(),
      score: s.length + (s.match(/[\\u4e00-\\u9fff]/g) || []).length
    })).sort((a, b) => b.score - a.score)
    const top = scored.slice(0, maxSentences)
    return {
      originalLength: text.length,
      sentenceCount: sentences.length,
      summary: top.map(s => s.text).join('。') + '。',
      keyPoints: top.map(s => s.text)
    }
  }
`
  }
]

// ============ 市场服务 ============

class PluginMarketplace {
  private registry: MarketplacePlugin[] = [...BUILTIN_PLUGINS]

  constructor() {
    this.refreshInstallStatus()
  }

  /**
   * 搜索插件
   */
  search(query: string): MarketplacePlugin[] {
    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (keywords.length === 0) return this.registry

    return this.registry.filter(p => {
      const haystack = `${p.name} ${p.description} ${p.tags.join(' ')} ${p.category} ${p.author}`.toLowerCase()
      return keywords.some(k => haystack.includes(k))
    })
  }

  /**
   * 按分类筛选
   */
  getByCategory(category: string): MarketplacePlugin[] {
    if (!category || category === 'all') return this.registry
    return this.registry.filter(p => p.category === category)
  }

  /**
   * 获取所有分类
   */
  getCategories(): string[] {
    const cats = new Set(this.registry.map(p => p.category))
    return Array.from(cats)
  }

  /**
   * 获取单个插件详情
   */
  getPlugin(id: string): MarketplacePlugin | undefined {
    return this.registry.find(p => p.id === id)
  }

  /**
   * 安装插件（将 SKILL.md 模板写入本地插件目录）
   */
  async install(pluginId: string): Promise<InstallResult> {
    const plugin = this.registry.find(p => p.id === pluginId)
    if (!plugin) {
      return { success: false, pluginId, error: '插件不存在' }
    }
    if (plugin.installedVersion === plugin.version) {
      return { success: false, pluginId, error: '已安装最新版本' }
    }

    // 仅内置插件支持直接安装
    if (plugin.source !== 'builtin' || !plugin.template) {
      return { success: false, pluginId, error: '暂不支持远程安装，请手动下载 SKILL.md 到插件目录' }
    }

    try {
      // 获取插件目录
      if (!window.electronAPI?.getPluginDir) {
        return { success: false, pluginId, error: '当前环境不支持插件安装' }
      }
      const pluginDir = await window.electronAPI.getPluginDir()

      // 创建插件目录并写入 SKILL.md
      const dirPath = `${pluginDir}/${pluginId}`
      if (window.electronAPI?.createDirectory) {
        await window.electronAPI.createDirectory(dirPath)
      }
      if (window.electronAPI?.writeFile) {
        await window.electronAPI.writeFile(`${dirPath}/SKILL.md`, plugin.template)
      }

      // 重新加载所有插件
      await pluginManager_loadAll()

      plugin.installedVersion = plugin.version
      this.saveInstallStatus()

      return { success: true, pluginId, version: plugin.version }
    } catch (error) {
      return {
        success: false,
        pluginId,
        error: error instanceof Error ? error.message : '安装失败'
      }
    }
  }

  /**
   * 卸载插件
   */
  async uninstall(pluginId: string): Promise<InstallResult> {
    try {
      pluginManager_unload(pluginId)
      const plugin = this.registry.find(p => p.id === pluginId)
      if (plugin) {
        plugin.installedVersion = undefined
        this.saveInstallStatus()
      }
      return { success: true, pluginId }
    } catch (error) {
      return {
        success: false,
        pluginId,
        error: error instanceof Error ? error.message : '卸载失败'
      }
    }
  }

  /**
   * 检查更新
   */
  checkUpdates(): MarketplacePlugin[] {
    return this.registry.filter(p =>
      p.installedVersion && p.installedVersion !== p.version
    )
  }

  /**
   * 获取所有已安装的插件
   */
  getInstalled(): LoadedPlugin[] {
    return pluginManager_getAll()
  }

  /**
   * 刷新安装状态
   */
  private refreshInstallStatus(): void {
    const installedIds = this.getInstalledIds()
    for (const plugin of this.registry) {
      if (installedIds.has(plugin.id)) {
        plugin.installedVersion = plugin.version
      }
    }
  }

  private getInstalledIds(): Set<string> {
    const installed = pluginManager_getAll()
    return new Set(installed.map(p => p.manifest.id))
  }

  private saveInstallStatus(): void {
    const status: Record<string, string> = {}
    for (const p of this.registry) {
      if (p.installedVersion) status[p.id] = p.installedVersion
    }
    localStorage.setItem('marketplace_installed', JSON.stringify(status))
  }
}

/** 全局插件市场单例 */
export const pluginMarketplace = new PluginMarketplace()
