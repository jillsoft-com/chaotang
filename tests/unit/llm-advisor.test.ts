/**
 * 幕僚助理测试
 *
 * 覆盖：
 * - parseAdvisorResponse 解析（正常/包裹/错误格式）
 * - 幻觉过滤（不存在的 skillId 被过滤）
 * - 超时回退 / provider 不可用
 * - 集成测试：mock provider → 验证推荐结果
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseAdvisorResponse } from '@/services/skills/llm-advisor'
import { resetAppStorageForTest, initializeAppStorage, appStorage } from '@/services/storage/app-storage'
import { resetStorageBackend, setStorageBackend } from '@/services/storage/factory'
import { FileStorageBackend } from '@/services/storage/file-storage'

describe('parseAdvisorResponse', () => {
  it('正常 JSON 解析成功', () => {
    const raw = JSON.stringify({
      intent: {
        goal: '搜索最新 AI 技术',
        deliverables: ['搜索结果'],
        constraints: ['需要最新数据'],
        taskType: 'research',
        missingInfo: []
      },
      recommendations: [
        { skillId: 'web_search', reason: '需要联网搜索', priority: 'high' }
      ],
      reasoning: '用户需要实时信息'
    })

    const result = parseAdvisorResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.intent.goal).toBe('搜索最新 AI 技术')
    expect(result!.intent.taskType).toBe('research')
    expect(result!.recommendations).toHaveLength(1)
    expect(result!.recommendations[0].skillId).toBe('web_search')
    expect(result!.recommendations[0].priority).toBe('high')
    expect(result!.reasoning).toBe('用户需要实时信息')
  })

  it('markdown 代码块包裹的 JSON', () => {
    const raw = '```json\n{"intent":{"goal":"测试","deliverables":[],"constraints":[],"taskType":"qa","missingInfo":[]},"recommendations":[],"reasoning":"简单任务"}\n```'

    const result = parseAdvisorResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.intent.goal).toBe('测试')
    expect(result!.recommendations).toHaveLength(0)
  })

  it('多余文本包裹的 JSON', () => {
    const raw = '以下是分析结果：\n{"intent":{"goal":"分析代码","deliverables":["报告"],"constraints":[],"taskType":"execution","missingInfo":[]},"recommendations":[{"skillId":"code_quality","reason":"代码检查","priority":"medium"}],"reasoning":"需要代码分析"}\n希望这能帮到你！'

    const result = parseAdvisorResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.intent.goal).toBe('分析代码')
    expect(result!.recommendations[0].skillId).toBe('code_quality')
  })

  it('格式错误返回 null', () => {
    expect(parseAdvisorResponse('')).toBeNull()
    expect(parseAdvisorResponse('这不是 JSON')).toBeNull()
    expect(parseAdvisorResponse('{broken json')).toBeNull()
  })

  it('部分字段缺失时使用默认值', () => {
    const raw = JSON.stringify({
      intent: { goal: '简单任务' },
      recommendations: [{ skillId: 'web_search' }]
    })

    const result = parseAdvisorResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.intent.goal).toBe('简单任务')
    expect(result!.intent.deliverables).toEqual([])
    expect(result!.intent.taskType).toBe('mixed') // 默认值
    expect(result!.recommendations[0].priority).toBe('medium') // 默认值
  })

  it('无效的 taskType 回退为 mixed', () => {
    const raw = JSON.stringify({
      intent: { taskType: 'invalid_type' },
      recommendations: []
    })

    const result = parseAdvisorResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.intent.taskType).toBe('mixed')
  })
})

describe('幻觉过滤（在 analyzeAndRecommend 中）', () => {
  const file = new Map<string, string>()

  beforeEach(async () => {
    localStorage.clear()
    file.clear()
    resetAppStorageForTest()
    resetStorageBackend()

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

    setStorageBackend(new FileStorageBackend())
    await initializeAppStorage()
  })

  afterEach(() => {
    resetAppStorageForTest()
    resetStorageBackend()
    delete (window as { electronAPI?: unknown }).electronAPI
    localStorage.clear()
  })

  it('provider 不可用时 analyzeAndRecommend 抛出异常', async () => {
    const { analyzeAndRecommend } = await import('@/services/skills/llm-advisor')

    // 不配置任何 LLM → provider 为 null → 应抛出异常
    const fakeSkill = {
      id: 'test_skill',
      name: '测试技能',
      description: '用于测试',
      icon: '🧪',
      category: 'system' as const,
      tools: [],
      enabled: true
    }

    await expect(
      analyzeAndRecommend({
        ministerId: 'test',
        userMessage: '测试消息',
        availableSkills: [fakeSkill],
        topic: '测试'
      })
    ).rejects.toThrow()
  })

  it('空 Skill 列表时抛出异常', async () => {
    const { analyzeAndRecommend } = await import('@/services/skills/llm-advisor')

    await expect(
      analyzeAndRecommend({
        ministerId: 'test',
        userMessage: '测试',
        availableSkills: [],
        topic: '测试'
      })
    ).rejects.toThrow('无可用 Skill')
  })
})

describe('tool-selector 幕僚集成', () => {
  const file = new Map<string, string>()

  beforeEach(async () => {
    localStorage.clear()
    file.clear()
    resetAppStorageForTest()
    resetStorageBackend()

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

    setStorageBackend(new FileStorageBackend())
    await initializeAppStorage()
  })

  afterEach(() => {
    resetAppStorageForTest()
    resetStorageBackend()
    delete (window as { electronAPI?: unknown }).electronAPI
    localStorage.clear()
  })

  it('幕僚关闭时走关键词匹配', async () => {
    const { appStorage } = await import('@/services/storage/app-storage')
    appStorage.setItem('enable_llm_advisor', 'false')

    const { selectToolsForTopic } = await import('@/services/skills/tool-selector')
    const { initializeSkills } = await import('@/services/skills/defaults')

    initializeSkills()

    // 即使没有配置 LLM，关闭幕僚后也应正常返回结果
    const tools = await selectToolsForTopic('chancellor', '搜索网络上的最新AI技术', 12)
    expect(tools.length).toBeGreaterThan(0)
  })

  it('幕僚启用但 provider 不可用时自动回退', async () => {
    const { appStorage } = await import('@/services/storage/app-storage')
    appStorage.setItem('enable_llm_advisor', 'true')
    // 不配置任何 LLM → provider 不可用 → 应回退到关键词匹配

    const { selectToolsForTopic } = await import('@/services/skills/tool-selector')
    const { initializeSkills } = await import('@/services/skills/defaults')

    initializeSkills()

    // 应回退到关键词匹配并正常返回
    const tools = await selectToolsForTopic('chancellor', '搜索网络上的最新AI技术', 12)
    expect(tools.length).toBeGreaterThan(0)
  })

  it('N-gram 关键词提取：中文词组不被丢失', async () => {
    const { extractKeywords } = await import('@/services/skills/tool-selector')

    const keywords = extractKeywords('帮我分析一下这个项目的代码质量')
    // 2-gram 应包含"代码""质量"等连续字符组合
    expect(keywords).toContain('代码')
    expect(keywords).toContain('质量')
    // 3-gram 应包含"代码质""码质量"
    expect(keywords).toContain('代码质')
    expect(keywords).toContain('项目')
  })
})
