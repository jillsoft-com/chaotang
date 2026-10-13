/**
 * 动态工具选择器测试
 *
 * 覆盖：
 * - 关键词提取
 * - 工具数量不足时全量返回
 * - 工具数量过多时智能筛选
 * - 核心工具始终包含
 * - 议题相关性排序
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resetAppStorageForTest, initializeAppStorage, appStorage } from '@/services/storage/app-storage'
import { resetStorageBackend, setStorageBackend } from '@/services/storage/factory'
import { FileStorageBackend } from '@/services/storage/file-storage'

describe('动态工具选择器', () => {
  const file = new Map<string, string>()

  beforeEach(async () => {
    localStorage.clear()
    file.clear()
    resetAppStorageForTest()
    resetStorageBackend()

    // Mock Electron 存储 API
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        storeGetAll: async () => Object.fromEntries(file),
        storeGetPath: async () => 'test/chaotang-store.json',
        storeSet: async (key: string, value: string) => { file.set(key, value); return true },
        storeDelete: async (key: string) => { file.delete(key); return true },
        storeSetSync: (key: string, value: string) => { file.set(key, value) },
        storeDeleteSync: (key: string) => { file.delete(key) },
        loadApiKeys: async () => ({}),
        saveApiKeys: async () => true
      }
    })

    // 初始化存储后端
    setStorageBackend(new FileStorageBackend())
    await initializeAppStorage()
  })

  afterEach(() => {
    resetAppStorageForTest()
    resetStorageBackend()
    delete (window as { electronAPI?: unknown }).electronAPI
    localStorage.clear()
  })

  it('工具总数 <= 上限时全量返回', async () => {
    // 动态导入，确保在存储初始化后加载
    const { selectToolsForTopic } = await import('@/services/skills/tool-selector')
    const { skillRegistry } = await import('@/services/skills/registry')
    const { initializeSkills } = await import('@/services/skills/defaults')

    // 禁用幕僚，确保走关键词匹配路径
    appStorage.setItem('enable_llm_advisor', 'false')
    initializeSkills()

    // 御史只有 7 个 Skill，上限 12，应该全量返回
    const tools = await selectToolsForTopic('censor', '请分析一下这个问题', 12)
    const allTools = skillRegistry.getSkillsForMinister('censor').flatMap(s => s.tools)
    expect(tools.length).toBe(allTools.length)
  })

  it('核心工具始终包含', async () => {
    const { selectToolsForTopic } = await import('@/services/skills/tool-selector')
    const { initializeSkills } = await import('@/services/skills/defaults')

    appStorage.setItem('enable_llm_advisor', 'false')
    initializeSkills()

    // 即使议题不相关，核心工具也应该被选中
    const tools = await selectToolsForTopic('chancellor', '随便聊聊天气', 12)
    const toolNames = tools.map((t: any) => t.function.name)

    // 核心工具：文件操作 + 记忆
    expect(toolNames).toContain('read_file')
    expect(toolNames).toContain('write_file')
    expect(toolNames).toContain('save_memory')
    expect(toolNames).toContain('search_memory')
  })

  it('议题相关工具被优先选中', async () => {
    const { selectToolsForTopic } = await import('@/services/skills/tool-selector')
    const { initializeSkills } = await import('@/services/skills/defaults')
  
    appStorage.setItem('enable_llm_advisor', 'false')
    initializeSkills()
  
    // 议题包含“搜索”、“网络”关键词，web_search 应该被选中
    const tools = await selectToolsForTopic('chancellor', '请在网络上搜索最新的AI技术动态', 8)
    const toolNames = tools.map((t: any) => t.function.name)
    expect(toolNames).toContain('web_search')
  })

  it('议题包含代码/测试关键词时选中相关工具', async () => {
    const { selectToolsForTopic } = await import('@/services/skills/tool-selector')
    const { initializeSkills } = await import('@/services/skills/defaults')

    appStorage.setItem('enable_llm_advisor', 'false')
    initializeSkills()

    // 御史有 code_quality 绑定，议题包含“代码”“质量”关键词
    const tools = await selectToolsForTopic('censor', '请检查代码质量并搜索相关问题', 10)
    const toolNames = tools.map((t: any) => t.function.name)
    expect(toolNames).toContain('lint_check')
    expect(toolNames).toContain('web_search')
  })

  it('议题包含 Git 关键词时选中 Git 工具', async () => {
    const { selectToolsForTopic } = await import('@/services/skills/tool-selector')
    const { initializeSkills } = await import('@/services/skills/defaults')

    appStorage.setItem('enable_llm_advisor', 'false')
    initializeSkills()

    const tools = await selectToolsForTopic('general', '请查看 git 分支并提交代码', 8)
    const toolNames = tools.map((t: any) => t.function.name)
    expect(toolNames).toContain('git_operation')
  })

  it('maxTools 参数生效', async () => {
    const { selectToolsForTopic } = await import('@/services/skills/tool-selector')
    const { initializeSkills } = await import('@/services/skills/defaults')

    appStorage.setItem('enable_llm_advisor', 'false')
    initializeSkills()

    // 设置一个很小的上限
    const tools = await selectToolsForTopic('chancellor', '搜索网络并执行命令运行测试检查代码质量', 5)
    // 核心工具 + 最多 5 个，绝对硬顶 5 * 2 = 10
    expect(tools.length).toBeLessThanOrEqual(10)
  })

  it('角色无绑定时返回空', async () => {
    const { selectToolsForTopic } = await import('@/services/skills/tool-selector')
    const { initializeSkills } = await import('@/services/skills/defaults')

    appStorage.setItem('enable_llm_advisor', 'false')
    initializeSkills()

    const tools = await selectToolsForTopic('nonexistent_role', '任意议题', 12)
    expect(tools.length).toBe(0)
  })

  it('estimateToolTokens 返回正数', async () => {
    const { selectToolsForTopic, estimateToolTokens } = await import('@/services/skills/tool-selector')
    const { initializeSkills } = await import('@/services/skills/defaults')

    appStorage.setItem('enable_llm_advisor', 'false')
    initializeSkills()

    const tools = await selectToolsForTopic('chancellor', '测试', 12)
    const tokens = estimateToolTokens(tools)
    expect(tokens).toBeGreaterThan(0)
  })

  it('getToolSelectionReport 返回格式化报告', async () => {
    const { getToolSelectionReport } = await import('@/services/skills/tool-selector')
    const { initializeSkills } = await import('@/services/skills/defaults')

    appStorage.setItem('enable_llm_advisor', 'false')
    initializeSkills()

    const report = await getToolSelectionReport('chancellor', '搜索网络并分析代码', 10)
    expect(report).toContain('[ToolSelector]')
    expect(report).toContain('chancellor')
    expect(report).toContain('总工具:')
    expect(report).toContain('选择:')
  })
})

describe('插件 bindTo 默认绑定', () => {
  it('所有内置角色 ID 列表正确', async () => {
    // 动态导入避免初始化顺序问题
    const { defaultMinisterSkills } = await import('@/services/skills/defaults')
    const ministerIds = Object.keys(defaultMinisterSkills)
    expect(ministerIds).toContain('chancellor')
    expect(ministerIds).toContain('finance')
    expect(ministerIds).toContain('tutor')
    expect(ministerIds).toContain('general')
    expect(ministerIds).toContain('censor')
    expect(ministerIds).toContain('eunuch')
  })
})
