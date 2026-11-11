/**
 * 浏览器工具层测试（M4）
 *
 * 这一层是模型唯一能看见的浏览器接口，测的是四条容易被改坏的契约：
 * 1. tabId 透传 —— 多标签能力全靠它，且不带 tabId 时不能塞个空字段进去；
 * 2. 身份标注 —— 模型发的每一个动作都得带 actor='agent'，否则主进程的接管锁与控制面拦截形同虚设；
 * 3. 失败语义 —— 「此刻没有合成层」不能被说成「这一步做错了」，否则模型会原地重试；
 * 4. 占用标记 —— 出错时也要释放，不然面板永久显示「Agent 正在操作」。
 *
 * 声明顺序也被测了一次：工具选择器超上限时按顺序截断，顺序变了等于模型拿到的能力变了。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { browserView } from '@/services/browser/browser-session'
import {
  browserToolDefinitions,
  browserToolHandlers,
  browserNavigateHandler,
  browserSnapshotHandler,
  browserClickHandler,
  browserTypeHandler,
  browserEvaluateHandler,
  browserScrollHandler,
  browserStateHandler,
  browserTabListHandler,
  browserTabOpenHandler,
  browserQueryHandler,
  browserHoverHandler,
  browserFrameQueryHandler,
  browserScreenshotHandler,
  browserPressHandler,
  browserTabSelectHandler,
  browserTabCloseHandler
} from '@/services/browser/browser-tools'

type Call = { action: string; params: Record<string, any>; actor?: string }

let calls: Call[]
/** 宿主通道的回包工厂，用例按需覆盖 */
let reply: (action: string, params: Record<string, any>) => any

function mockChannels() {
  calls = []
  reply = () => ({ success: true, url: 'https://example.com', title: 'Example', tabId: 'b1' })
  ;(window as any).electronAPI = {
    browserHostAction: vi.fn(async ({ action, params, actor }: any) => {
      calls.push({ action, params, actor })
      return reply(action, params)
    })
  }
}

async function expectRejected(fn: () => Promise<any>): Promise<string> {
  const message = await fn().then(() => '').catch((e: any) => e.message)
  expect(message).not.toBe('')
  return message
}

beforeEach(() => {
  Object.assign(browserView, {
    url: '', title: '', active: false, agentBusy: false, agentLabel: '', manualHold: false
  })
  mockChannels()
})

afterEach(() => {
  vi.restoreAllMocks()
  ;(window as any).electronAPI = undefined
})

describe('工具集构成', () => {
  it('定义与处理器一一对应且没有重名', () => {
    const names = browserToolDefinitions.map(t => t.function.name)
    expect(names).toHaveLength(16)
    expect(new Set(names).size).toBe(names.length)
    expect(Object.keys(browserToolHandlers).sort()).toEqual([...names].sort())
  })

  it('每个工具都有参数对象与描述，描述里不出现未定义的工具名', () => {
    const declared = new Set(browserToolDefinitions.map(t => t.function.name))
    for (const tool of browserToolDefinitions) {
      expect(tool.function.description.length).toBeGreaterThan(20)
      expect(tool.function.parameters.type).toBe('object')
      // 描述里推荐的「改用 X」必须真的存在，否则模型会去调一个不存在的工具
      for (const m of tool.function.description.matchAll(/browser_[a-z_]+/g)) {
        if (m[0] !== tool.function.name) expect(declared.has(m[0])).toBe(true)
      }
    }
  })

  it('高频动作排在前面，因为工具数超上限时按声明顺序截断', () => {
    expect(browserToolDefinitions.slice(0, 6).map(t => t.function.name)).toEqual([
      'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_evaluate'
    ])
    // 画面不可用时最该先看到的自检手段排在老工具之后、标签页管理之前
    expect(browserToolDefinitions.slice(6, 9).map(t => t.function.name)).toEqual([
      'browser_state', 'browser_query', 'browser_frame_query'
    ])
  })

  it('页面级工具都收可选 tabId，tab_select 的 tabId 则必填', () => {
    for (const name of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
      'browser_screenshot', 'browser_evaluate', 'browser_state', 'browser_query', 'browser_scroll',
      'browser_hover', 'browser_press', 'browser_frame_query', 'browser_tab_close']) {
      const tool = browserToolDefinitions.find(t => t.function.name === name)!
      const tabId = tool.function.parameters.properties?.tabId as any
      expect(tabId?.type).toBe('string')
      expect(tool.function.parameters.required || []).not.toContain('tabId')
    }
    const select = browserToolDefinitions.find(t => t.function.name === 'browser_tab_select')!
    expect(select.function.parameters.required).toEqual(['tabId'])
    // 列表与新建不指向某个已有标签页
    expect(browserToolDefinitions.find(t => t.function.name === 'browser_tab_list')!.function.parameters.properties).toEqual({})
    const open = browserToolDefinitions.find(t => t.function.name === 'browser_tab_open')!
    expect(open.function.parameters.properties?.tabId).toBeFalsy()
  })

  it('按键只放开功能键，文字输入留给 browser_type', () => {
    const tool = browserToolDefinitions.find(t => t.function.name === 'browser_press')!
    const key = tool.function.parameters.properties?.key as any
    expect(key.enum).toContain('Enter')
    expect(key.enum).toContain('Escape')
    expect(key.enum).not.toContain('a')
  })
})

describe('tabId 透传', () => {
  it('不带 tabId 时不往参数里塞空字段，宿主才会落在活动标签页', async () => {
    await browserNavigateHandler({ url: 'https://example.com' })
    expect(calls[0]).toEqual({ action: 'navigate', params: { url: 'https://example.com' }, actor: 'agent' })
  })

  it('带 tabId 时原样传给宿主', async () => {
    await browserNavigateHandler({ url: 'https://example.com', tabId: 'b3' })
    expect(calls[0].params.tabId).toBe('b3')
  })

  it('输入类工具把 tabId 与选择器一起送出去', async () => {
    await browserClickHandler({ selector: '#go', tabId: 'b2' })
    expect(calls[0].action).toBe('click')
    expect(calls[0].params).toEqual({ selector: '#go', tabId: 'b2' })

    await browserTypeHandler({ selector: '#q', text: '关键词', append: true, tabId: 'b2' })
    expect(calls[1].params).toEqual({ selector: '#q', text: '关键词', append: true, tabId: 'b2' })
  })

  it('默认不显式声明 jsFallback，只有设为 false 才要求可信事件', async () => {
    await browserClickHandler({ selector: '#go' })
    expect('jsFallback' in calls[0].params).toBe(false)

    await browserClickHandler({ selector: '#go', jsFallback: false })
    expect(calls[1].params.jsFallback).toBe(false)
  })

  it('标签页管理映射到宿主动作名', async () => {
    await browserTabListHandler({})
    expect(calls[0].action).toBe('tab-list')

    await browserTabOpenHandler({ url: 'https://a.test' })
    expect(calls[1].action).toBe('tab-open')
    expect(calls[1].params).toEqual({ url: 'https://a.test' })

    await browserTabOpenHandler({ background: true })
    expect(calls[2].params.activate).toBe(false)

    await browserTabSelectHandler({ tabId: 'b7' })
    expect(calls[3].action).toBe('tab-select')
    expect(calls[3].params).toEqual({ tabId: 'b7' })

    await browserTabCloseHandler({})
    expect(calls[4].action).toBe('tab-close')
    expect(calls[4].params).toEqual({})
  })

  it('滚动与按键用宿主原语而不是选择器模拟', async () => {
    await browserScrollHandler({ deltaY: 600 })
    expect(calls[0].action).toBe('scroll')
    expect(calls[0].params.deltaY).toBe(600)

    await browserScrollHandler({ selector: '#late', block: 'start' })
    expect(calls[1].params).toEqual({ selector: '#late', block: 'start' })

    await browserPressHandler({ key: 'Enter' })
    expect(calls[2].action).toBe('keyboard')
    expect(calls[2].params.key).toBe('Enter')
  })

  it('读取类工具把 attribute/all 交给宿主，不在渲染层重复实现', async () => {
    await browserQueryHandler({ selector: 'a', attribute: 'href', all: true })
    expect(calls[0].action).toBe('query')
    expect(calls[0].params).toEqual({ selector: 'a', attribute: 'href', all: true })

    await browserFrameQueryHandler({ expression: 'document.body.innerText', urlPart: 'pay' })
    expect(calls[1].action).toBe('frame-evaluate')
    expect(calls[1].params.urlPart).toBe('pay')
  })
})

describe('身份标注：模型发的动作一律带 actor=agent', () => {
  it('全部入口都打上身份章，接管锁才有得拦', async () => {
    await browserNavigateHandler({ url: 'https://a.test' })
    await browserSnapshotHandler({})
    await browserClickHandler({ selector: '#go' })
    await browserTypeHandler({ selector: '#q', text: 'x' })
    await browserScreenshotHandler({})
    await browserEvaluateHandler({ expression: '1' })
    await browserStateHandler({})
    await browserQueryHandler({ selector: 'a' })
    await browserFrameQueryHandler({ expression: '1' })
    await browserScrollHandler({ deltaY: 100 })
    await browserHoverHandler({ selector: '#menu' })
    await browserPressHandler({ key: 'Enter' })
    await browserTabListHandler({})
    await browserTabOpenHandler({ url: 'https://a.test' })
    await browserTabSelectHandler({ tabId: 'b1' })
    await browserTabCloseHandler({})
    expect(calls).toHaveLength(16)
    expect(calls.filter(c => c.actor !== 'agent')).toEqual([])
  })

  it('滚动只有宿主原语一条路（旧通道的 mouse-wheel 已下线）', async () => {
    await browserScrollHandler({ deltaY: 300 })
    await browserScrollHandler({ selector: '#late' })
    expect(calls.map(c => c.action)).toEqual(['scroll', 'scroll'])
    expect(calls[1].params.selector).toBe('#late')
  })
})

describe('失败语义转述', () => {
  it('暂时拿不到画面时说清可以重试，并给出不依赖画面的替代手段', async () => {
    reply = () => ({ success: false, error: 'CAPTURE_TIMEOUT: 未取得画面', retryable: true, visibility: 'hidden' })
    const message = await expectRejected(() => browserScreenshotHandler({}))
    expect(message).toContain('暂时性')
    expect(message).toContain('browser_query')
  })

  it('主进程给了 hint 就原样带上，模型才有可执行的下一步', async () => {
    reply = () => ({ success: false, error: 'NEED_TRUSTED_CLICK: 鼠标点击当前不会送达页面', hint: '请把应用窗口切到前台' })
    const message = await expectRejected(() => browserClickHandler({ selector: '#go' }))
    expect(message).toContain('请把应用窗口切到前台')
  })

  it('退化为 JS 合成事件时结果里标 synthetic，并把风控警告带给模型', async () => {
    reply = () => ({
      success: true, fallback: true, url: 'https://example.com',
      warning: '窗口被遮挡，已退化为 JS 合成事件：isTrusted 为 false'
    })
    const res: any = await browserClickHandler({ selector: '#go' })
    expect(res.synthetic).toBe(true)
    expect(res.warning).toContain('isTrusted')
    expect(res.url).toBe('https://example.com')
  })

  it('画面不可用不伪装成成功：canCapture 与 visibility 一并返回', async () => {
    reply = () => ({ success: true, canCapture: false, visibility: 'detached', url: 'https://a.test' })
    const res: any = await browserHoverHandler({ selector: '#menu' })
    expect(res.screenAvailable).toBe(false)
    expect(res.visibility).toBe('detached')
  })
})

describe('状态归一', () => {
  it('browser_state 把标签页与画面可用性归成模型好读的字段', async () => {
    reply = () => ({
      success: true,
      url: 'https://a.test', title: 'A', active: true,
      canBack: true, canForward: false,
      visibility: 'hidden', canCapture: false, captureHint: '窗口被其它程序完全遮挡',
      viewport: { width: 800, height: 600 },
      tabs: [
        { id: 'b1', url: 'https://a.test', title: 'A', active: true, mounted: true },
        { id: 'b2', url: 'https://b.test', title: 'B', active: false, mounted: false }
      ]
    })
    const res: any = await browserStateHandler({})
    expect(res.canBack).toBe(true)
    expect(res.tabCount).toBe(2)
    // mounted 是主进程用词，对模型改成「是不是正画在界面上」
    expect(res.tabs[1]).toEqual({ tabId: 'b2', url: 'https://b.test', title: 'B', active: false, onScreen: false })
    expect(res.message).toContain('画面不可用')
    expect(res.message).toContain('窗口被其它程序完全遮挡')
  })

  it('能力位逐位透传：拿不到画面不等于输入也停了', async () => {
    reply = () => ({
      success: true, url: 'https://a.test', title: 'A', active: true,
      visibility: 'minimized', canCapture: false, captureHint: '应用窗口已最小化。键盘与滚动仍可用',
      canClick: false, clickHint: '应用窗口已最小化。鼠标点击不送达页面',
      canWheel: true, canKey: true,
      tabs: [{ id: 'b1', url: 'https://a.test', title: 'A', active: true, mounted: true }]
    })
    const res: any = await browserStateHandler({})
    expect(res.canClick).toBe(false)
    expect(res.canWheel).toBe(true)
    expect(res.canKey).toBe(true)
    expect(res.clickHint).toContain('鼠标点击')
    // 点击不可达要单独说清，否则模型会以为输入类动作全都停了
    expect(res.message).toContain('鼠标点击不可达')
  })

  it('后台承载（carrier=bg）透传：面板不可见但真点击/截图可用，不再抹成画面不可用', async () => {
    reply = () => ({
      success: true, url: 'https://a.test', title: 'A', active: true,
      visibility: 'hidden', carrier: 'bg', offscreen: true,
      canCapture: true, canClick: true, canWheel: true, canKey: true,
      tabs: [{ id: 'b1', url: 'https://a.test', title: 'A', active: true, mounted: true }]
    })
    const res: any = await browserStateHandler({})
    expect(res.carrier).toBe('bg')
    expect(res.offscreen).toBe(true)
    expect(res.canClick).toBe(true)
    // bg 承载时话术改成“后台运行中”，不能再报“画面不可用”误导模型绕路
    expect(res.message).toContain('后台运行中')
    expect(res.message).not.toContain('画面不可用')
  })

  it('tab-list 的活动页 id 优先取 activeTabId，缺失时退回 tabId', async () => {
    reply = () => ({
      success: true, activeTabId: 'b9',
      tabs: [{ id: 'b9', url: 'https://a.test', title: 'A', active: true, mounted: false }]
    })
    const res: any = await browserTabListHandler({})
    expect(res.activeTabId).toBe('b9')
    expect(res.message).toContain('b9')

    reply = () => ({ success: true, tabId: 'b8', tabs: [] })
    const res2: any = await browserTabListHandler({})
    expect(res2.activeTabId).toBe('b8')
  })
})

describe('Agent 占用与人工接管', () => {
  it('调用结束就释放占用标记，失败时也要释放', async () => {
    await browserNavigateHandler({ url: 'https://example.com' })
    expect(browserView.agentBusy).toBe(false)

    reply = () => ({ success: false, error: '仅支持 http/https 协议' })
    await expect(browserNavigateHandler({ url: 'file:///etc/passwd' })).rejects.toThrow('http')
    expect(browserView.agentBusy).toBe(false)
    expect(browserView.agentLabel).toBe('')
  })

  it('用户接管期间先等待，退出接管后才发动作', async () => {
    browserView.manualHold = true
    setTimeout(() => { browserView.manualHold = false }, 80)
    const started = Date.now()
    await browserClickHandler({ selector: '#go' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(60)
    expect(calls[0].action).toBe('click')
  })

  it('宿主专属工具在接管期间也不会绕过等待先去碰页面', async () => {
    browserView.manualHold = true
    setTimeout(() => { browserView.manualHold = false }, 60)
    await browserTabOpenHandler({ url: 'https://a.test' })
    expect(calls[0].action).toBe('tab-open')
  })
})
