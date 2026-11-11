/**
 * 能力使用契约注入测试（M4.5）
 *
 * 契约的作用是让模型按实测事实操作浏览器（先 state、读页面优先于看画面、
 * 遮挡时不原地重试、多标签显式 tabId）。这里守四条会被改坏的边界：
 * 1. 契约正文必须在 services/browser 下，绝不能挪进 src/prompts/：
 *    那个目录被 prompt-config 用 import.meta.glob 扫，文件名会被当成角色 id；
 * 2. 契约里推荐的工具名必须真的存在，否则模型会去调一个不存在的工具；
 * 3. 契约跟着「本轮实际发出的工具」走：工具被筛掉就不该占上下文，
 *    子 Agent 过滤掉浏览器工具后也不该留下浏览器的说明书；
 * 4. 长度必须有硬上限，插件作者把整篇文档粘进 SKILL.md 也不能挤掉任务上下文。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resetAppStorageForTest, initializeAppStorage, appStorage } from '@/services/storage/app-storage'
import { resetStorageBackend, setStorageBackend } from '@/services/storage/factory'
import { FileStorageBackend } from '@/services/storage/file-storage'

// happy-dom 里 import.meta.url 不是 file: 协议，反推不出磁盘路径；vitest 的工作目录就是项目根
const projectRoot = process.cwd()

/** 造一个最小工具定义，只关心 function.name */
function tool(name: string) {
  return {
    type: 'function' as const,
    function: { name, description: `${name} 的说明`, parameters: { type: 'object' as const, properties: {} } }
  }
}

function skill(id: string, toolNames: string[], guidance = '') {
  return {
    id,
    name: id,
    description: id,
    category: 'system' as const,
    tools: toolNames.map(tool),
    guidance,
    enabled: true
  }
}

describe('契约正文的位置与内容', () => {
  // 动态导入：先建好存储再拉模块，避免 appStorage 早期读取抛错
  let BROWSER_GUIDANCE: string
  let browserToolNames: string[]

  beforeEach(async () => {
    localStorage.clear()
    resetAppStorageForTest()
    resetStorageBackend()
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        storeGetAll: async () => ({}),
        storeGetPath: async () => 'test/chaotang-store.json',
        storeSet: async () => true,
        storeSetSync: () => {},
        loadApiKeys: async () => ({}),
        saveApiKeys: async () => true,
        scanPlugins: async () => []
      }
    })
    setStorageBackend(new FileStorageBackend())
    await initializeAppStorage()

    const guidanceModule = await import('@/services/browser/browser-guidance')
    BROWSER_GUIDANCE = guidanceModule.BROWSER_GUIDANCE
    const { browserToolDefinitions } = await import('@/services/browser/browser-tools')
    browserToolNames = browserToolDefinitions.map(t => t.function.name)
  })

  afterEach(() => {
    resetAppStorageForTest()
    resetStorageBackend()
    delete (window as { electronAPI?: unknown }).electronAPI
    localStorage.clear()
  })

  it('契约文件在 services/browser 下，且没有混进 prompts 目录', () => {
    expect(existsSync(join(projectRoot, 'src', 'services', 'browser', 'browser-guidance.md'))).toBe(true)
    // prompts 目录里的每个 md 都会被当成一个角色，多一个文件即凭空多一个「角色」
    expect(existsSync(join(projectRoot, 'src', 'prompts', 'browser-guidance.md'))).toBe(false)
    expect(existsSync(join(projectRoot, 'src', 'prompts', 'browser.md'))).toBe(false)
  })

  it('通过 ?raw 拿到的是正文本身，不是模块对象', () => {
    expect(typeof BROWSER_GUIDANCE).toBe('string')
    expect(BROWSER_GUIDANCE.startsWith('#')).toBe(true)
    expect(BROWSER_GUIDANCE).toBe(BROWSER_GUIDANCE.trim())
  })

  it('实测出来的几条纪律都在文案里', () => {
    // 这几条各对应一个真实事故：盲目重试、拿截图当读取、以为后台也能点击、跨域 iframe 读不到
    expect(BROWSER_GUIDANCE).toContain('browser_state')
    expect(BROWSER_GUIDANCE).toContain('retryable')
    expect(BROWSER_GUIDANCE).toContain('synthetic')
    expect(BROWSER_GUIDANCE).toContain('browser_frame_query')
    expect(BROWSER_GUIDANCE).toContain('tabId')
    expect(BROWSER_GUIDANCE).toContain('browser_tab_list')
  })

  it('契约推荐的工具名都必须真实存在', () => {
    const declared = new Set(browserToolNames)
    const mentioned = [...BROWSER_GUIDANCE.matchAll(/browser_[a-z_]+/g)].map(m => m[0])
    expect(mentioned.length).toBeGreaterThan(5)
    for (const name of mentioned) expect(declared.has(name)).toBe(true)
  })

  it('内置 browser skill 挂上了这份契约', async () => {
    const { initializeSkills } = await import('@/services/skills/defaults')
    const { skillRegistry } = await import('@/services/skills/registry')
    initializeSkills()
    expect(skillRegistry.getSkill('browser')?.guidance).toBe(BROWSER_GUIDANCE)
    // 其余内置 skill 暂时不带契约：契约是可选字段，不该被当成必填而到处塞空串
    const withGuidance = skillRegistry.getAllSkills().filter(s => (s.guidance || '').length > 0)
    expect(withGuidance.map(s => s.id)).toEqual(['browser'])
  })
})

describe('buildSkillGuidance 按工具命中', () => {
  let buildSkillGuidance: (t: any[]) => string
  let guidanceOf: (s: any) => string
  let MAX_GUIDANCE_CHARS: number

  beforeEach(async () => {
    localStorage.clear()
    resetAppStorageForTest()
    resetStorageBackend()
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        storeGetAll: async () => ({}),
        storeGetPath: async () => 'test/chaotang-store.json',
        storeSet: async () => true,
        storeSetSync: () => {},
        loadApiKeys: async () => ({}),
        saveApiKeys: async () => true
      }
    })
    setStorageBackend(new FileStorageBackend())
    await initializeAppStorage()

    const g = await import('@/services/skills/guidance')
    buildSkillGuidance = g.buildSkillGuidance
    guidanceOf = g.guidanceOf
    MAX_GUIDANCE_CHARS = g.MAX_GUIDANCE_CHARS

    const { skillRegistry } = await import('@/services/skills/registry')
    skillRegistry.register(skill('browser', ['browser_navigate', 'browser_state'], '浏览器契约正文') as any, {})
    skillRegistry.register(skill('git', ['git_operation'], 'Git 契约正文') as any, {})
    skillRegistry.register(skill('plain', ['read_file']), {})
  })

  afterEach(() => {
    resetAppStorageForTest()
    resetStorageBackend()
    delete (window as { electronAPI?: unknown }).electronAPI
    localStorage.clear()
  })

  it('命中谁就只念谁，标头标尾明确是程序注入', () => {
    const text = buildSkillGuidance([tool('browser_state')])
    expect(text).toContain('浏览器契约正文')
    expect(text).not.toContain('Git 契约正文')
    expect(text).toContain('能力使用契约')
    expect(text.trimEnd().endsWith('=== 契约结束 ===')).toBe(true)
  })

  it('一个工具都没发出去时不产生任何段落', () => {
    expect(buildSkillGuidance([])).toBe('')
    // 只剩没有名字的工具（异常定义）也不能误命中
    expect(buildSkillGuidance([{ type: 'function', function: { name: '', description: '', parameters: {} } }] as any)).toBe('')
  })

  it('没有契约的 skill 不会挤进段落，也不会因为工具同名串味', () => {
    const text = buildSkillGuidance([tool('read_file'), tool('git_operation')])
    expect(text).toContain('Git 契约正文')
    expect(text).not.toContain('read_file')
  })

  it('多条契约按注册顺序并列', () => {
    const text = buildSkillGuidance([tool('browser_navigate'), tool('git_operation')])
    expect(text.indexOf('浏览器契约正文')).toBeLessThan(text.indexOf('Git 契约正文'))
  })

  it('单个契约过长会被截断并标注', () => {
    const long = 'x'.repeat(MAX_GUIDANCE_CHARS + 500)
    const cut = guidanceOf({ guidance: long })
    expect(cut.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARS + 20)
    expect(cut).toContain('截断')
    expect(guidanceOf({ guidance: '   ' })).toBe('')
    expect(guidanceOf(undefined)).toBe('')
  })

  it('总量超预算时整段丢弃后面的契约，不做半句截断', async () => {
    const { skillRegistry } = await import('@/services/skills/registry')
    const pad = (ch: string) => ch.repeat(MAX_GUIDANCE_CHARS - 100)
    skillRegistry.register(skill('a', ['tool_a'], pad('A')) as any, {})
    skillRegistry.register(skill('b', ['tool_b'], pad('B')) as any, {})
    skillRegistry.register(skill('c', ['tool_c'], pad('C')) as any, {})

    const text = buildSkillGuidance([tool('tool_a'), tool('tool_b'), tool('tool_c')])
    expect(text).toContain('AAAA')
    expect(text).toContain('BBBB')
    expect(text).not.toContain('CCCC')
  })
})

describe('真实链路：筛选后的工具决定契约是否出现', () => {
  beforeEach(async () => {
    localStorage.clear()
    resetAppStorageForTest()
    resetStorageBackend()
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        storeGetAll: async () => ({}),
        storeGetPath: async () => 'test/chaotang-store.json',
        storeSet: async () => true,
        storeSetSync: () => {},
        loadApiKeys: async () => ({}),
        saveApiKeys: async () => true,
        scanPlugins: async () => []
      }
    })
    setStorageBackend(new FileStorageBackend())
    await initializeAppStorage()
    appStorage.setItem('enable_llm_advisor', 'false')

    const { initializeSkills } = await import('@/services/skills/defaults')
    initializeSkills()
  })

  afterEach(() => {
    resetAppStorageForTest()
    resetStorageBackend()
    delete (window as { electronAPI?: unknown }).electronAPI
    localStorage.clear()
  })

  it('浏览器议题选出了浏览器工具，契约随之进入上下文', async () => {
    const { selectToolsForTopic } = await import('@/services/skills/tool-selector')
    const { buildSkillGuidance } = await import('@/services/skills/guidance')
    const tools = await selectToolsForTopic('chancellor', '打开网页并点击按钮，读取页面内容', 12)
    expect(tools.map(t => t.function.name)).toContain('browser_navigate')
    expect(buildSkillGuidance(tools)).toContain('浏览器操作契约')
  })

  it('与浏览器无关的议题没选中浏览器工具，浏览器契约也不会出现', async () => {
    const { selectToolsForTopic } = await import('@/services/skills/tool-selector')
    const { buildSkillGuidance } = await import('@/services/skills/guidance')
    const tools = await selectToolsForTopic('finance', '计算这个预算的百分比并生成图表', 12)
    expect(tools.map(t => t.function.name).filter(n => n.startsWith('browser_'))).toEqual([])
    // 同一单例 registry 里可能还挂着前面小节注册的其它契约，所以只针对浏览器契约下断言
    expect(buildSkillGuidance(tools)).not.toContain('浏览器操作契约')
  })

  it('浏览器工具被截断到只剩一个时契约仍然完整', async () => {
    const { skillRegistry } = await import('@/services/skills/registry')
    const { buildSkillGuidance } = await import('@/services/skills/guidance')
    const browserTools = skillRegistry.getSkill('browser')!.tools
    expect(browserTools.length).toBeGreaterThan(10)
    // 工具选择器超上限时按声明顺序截断，最坏只剩第一个工具；
    // 契约不能跟着一起被截，否则模型看得到 navigate 却看不到 iframe/遮挡这些纪律
    const text = buildSkillGuidance(browserTools.slice(0, 1))
    expect(text).toContain('浏览器操作契约')
    expect(text).toContain('browser_frame_query')
  })
})
