/**
 * 内嵌浏览器宿主会话测试（M3 面板内嵌）
 *
 * 这一层是内嵌模式的地基，测的就是三件最容易做错的事：
 * 1. 区域上报的坐标换算与去抖 —— 报错坐标页面就会画歪，漏报就会画在旧尺寸上；
 * 2. 「尺寸没变但页面换了」必须带 force，否则宿主不会把新页面挂上界面；
 * 3. 主进程推来的状态要落到响应式镜像里，并且同步进 browser-session 那份共享状态，
 *    否则 HomeView 的标签标题联动和 Agent 占用徽标会失效；
 * 4. 动作事件进的是有界日志而不是单个当前值（M5）—— 同帧里连着两个动作，
 *    只记最后一个就等于界面丢了一个动作；
 * 5. 接管锁以主进程为准（M6）：渲染层只是镜像，面板按钮、用户真实操作、
 *    空闲自动放开都来自主进程广播，本地自己改一份会跟主进程打架。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  hostState,
  hostAction,
  syncSurface,
  releaseSurface,
  resetSurfaceTracking,
  resetGestureLog,
  ensureHostListeners,
  disposeHostListeners,
  isHostAvailable,
  setHold
} from '@/services/browser/browser-host-session'
import { browserView } from '@/services/browser/browser-session'

type Listener = (payload: any) => void

/** 造一个宿主通道：记录动作调用，并留着事件口给测试主动推送 */
function mockHost() {
  const calls: Array<{ action: string; params: Record<string, any>; actor: string }> = []
  const listeners = new Map<string, Listener[]>()
  const emit = (channel: string, payload: any) => {
    for (const fn of listeners.get(channel) || []) fn(payload)
  }
  const on = (channel: string) => (callback: Listener) => {
    const list = listeners.get(channel) || []
    list.push(callback)
    listeners.set(channel, list)
    return () => {
      listeners.set(channel, list.filter(f => f !== callback))
    }
  }

  const api: Record<string, any> = {
    browserHostAction: vi.fn(async ({ action, params = {}, actor = 'user' }: any) => {
      calls.push({ action, params, actor })
      return { success: true, action }
    }),
    onBrowserState: on('browser-state'),
    onBrowserRaise: on('browser-raise'),
    onBrowserBlocked: on('browser-blocked'),
    onBrowserGesture: on('browser-gesture'),
    onBrowserTabOpened: on('browser-tab-opened'),
    onBrowserHold: on('browser-hold')
  }
  ;(window as any).electronAPI = api
  return { calls, emit, api }
}

/** 占位区替身：只需要 getBoundingClientRect */
function fakeRect(x: number, y: number, width: number, height: number) {
  return { getBoundingClientRect: () => ({ left: x, top: y, width, height }) } as unknown as HTMLElement
}

let host: ReturnType<typeof mockHost>

beforeEach(() => {
  host = mockHost()
  disposeHostListeners()
  // 去抖缓存是模块级的，不清就会让上一个用例的矩形吃掉本用例的第一次上报
  resetSurfaceTracking()
  // 动作日志也是模块级的；序号故意不往回退，所以用例只能按相对量断言
  resetGestureLog()
})

afterEach(() => {
  vi.restoreAllMocks()
  disposeHostListeners()
  ;(window as any).electronAPI = undefined
})

describe('通道可用性', () => {
  it('宿主通道缺失时明确报错，不假装成功', async () => {
    // 旧安装包只有别的通道、没有 browserHostAction，这时内嵌能力必须整体判为不可用
    ;(window as any).electronAPI = {}
    expect(isHostAvailable()).toBe(false)
    const res = await hostAction('tab-list', {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('宿主通道不可用')
  })

  it('preload 暴露了 browserHostAction 即可用', () => {
    expect(isHostAvailable()).toBe(true)
  })
})

describe('区域上报', () => {
  it('按占位区矩形原样上报，不做额外换算', async () => {
    await syncSurface(fakeRect(812, 48, 596, 700))
    const call = host.calls[0]
    expect(call.action).toBe('set-bounds')
    expect(call.params).toEqual({ x: 812, y: 48, width: 596, height: 700, force: false })
  })

  it('矩形没变时不重复发 IPC，避免拖拽期间刷屏', async () => {
    await syncSurface(fakeRect(812, 48, 596, 700))
    await syncSurface(fakeRect(812, 48, 596, 700))
    expect(host.calls.filter(c => c.action === 'set-bounds')).toHaveLength(1)
  })

  it('2 像素以内的抖动不算变化', async () => {
    await syncSurface(fakeRect(812, 48, 596, 700))
    await syncSurface(fakeRect(813, 48, 596, 701))
    expect(host.calls.filter(c => c.action === 'set-bounds')).toHaveLength(1)
  })

  it('force 用来处理「尺寸没变但页面换了」：新建/切换标签页全靠它把画面挂上来', async () => {
    await syncSurface(fakeRect(812, 48, 596, 700))
    await syncSurface(fakeRect(812, 48, 596, 700), { force: true })
    const bounds = host.calls.filter(c => c.action === 'set-bounds')
    expect(bounds).toHaveLength(2)
    expect(bounds[1].params.force).toBe(true)
  })

  it('占位区被折叠成 0 尺寸时改发 detach，不把主进程拒收的尺寸报上去', async () => {
    await syncSurface(fakeRect(812, 48, 596, 700))
    host.calls.length = 0
    const ok = await syncSurface(fakeRect(812, 48, 0, 0))
    expect(ok).toBe(false)
    expect(host.calls.map(c => c.action)).toEqual(['detach'])
  })

  it('面板收起时卸下页面，但内存里的标签页不归它管', async () => {
    await syncSurface(fakeRect(812, 48, 596, 700))
    host.calls.length = 0
    await releaseSurface()
    expect(host.calls).toEqual([{ action: 'detach', params: {}, actor: 'user' }])
    // 已经卸下了就不该再发一次
    await releaseSurface()
    expect(host.calls).toHaveLength(1)
  })

  it('Web 模式下不上报', async () => {
    ;(window as any).electronAPI = {}
    host.calls.length = 0
    expect(await syncSurface(fakeRect(0, 0, 600, 400))).toBe(false)
    expect(host.calls).toHaveLength(0)
  })
})

describe('状态镜像', () => {
  it('动作返回值里的页面信息会并进 hostState，缺字段不抹掉已有值', async () => {
    host.api.browserHostAction.mockImplementation(async () => ({
      success: true,
      url: 'https://example.com',
      title: 'Example Domain',
      active: true,
      canBack: true,
      canCapture: false,
      visibility: 'minimized',
      viewport: { width: 596, height: 700 },
      tabs: [{ id: 'b1', url: 'https://example.com', title: 'Example Domain', partition: 'p', active: true, mounted: true }]
    }))
    await hostAction('navigate', { url: 'https://example.com' })
    expect(hostState.url).toBe('https://example.com')
    expect(hostState.canBack).toBe(true)
    expect(hostState.visibility).toBe('minimized')
    expect(hostState.tabs).toHaveLength(1)

    // 只回 url/title 的动作（back）不应把 tabs 清空
    host.api.browserHostAction.mockImplementation(async () => ({ success: true, url: 'https://a.test', title: 'A' }))
    await hostAction('back', {})
    expect(hostState.url).toBe('https://a.test')
    expect(hostState.tabs).toHaveLength(1)
  })

  it('同步一份到 browser-session 的共享状态，HomeView 的联动才不会断', async () => {
    host.api.browserHostAction.mockImplementation(async () => ({
      success: true, url: 'https://example.com', title: 'Example Domain', active: true
    }))
    await hostAction('state', {})
    expect(browserView.url).toBe('https://example.com')
    expect(browserView.title).toBe('Example Domain')
    expect(browserView.active).toBe(true)
  })

  it('失败原因记在 lastError 里，供面板原样显示', async () => {
    host.api.browserHostAction.mockImplementation(async () => ({ success: false, error: 'TAB_NOT_FOUND: 标签页不存在' }))
    const res = await hostAction('tab-select', { tabId: 'b9' })
    expect(res.success).toBe(false)
    expect(hostState.lastError).toContain('TAB_NOT_FOUND')
  })

  it('接管锁以主进程返回值为准，同时镜像进共享状态', async () => {
    host.api.browserHostAction.mockImplementation(async () => ({ success: true, manualHold: true, holdSource: 'panel' }))
    await hostAction('set-hold', { on: true })
    expect(hostState.manualHold).toBe(true)
    expect(hostState.holdSource).toBe('panel')
    expect(browserView.manualHold).toBe(true)

    host.api.browserHostAction.mockImplementation(async () => ({ success: true, manualHold: false, holdSource: '' }))
    await hostAction('state', {})
    expect(hostState.manualHold).toBe(false)
    expect(browserView.manualHold).toBe(false)
  })
})

describe('主进程事件', () => {
  it('browser-state 广播直接落进状态镜像', () => {
    ensureHostListeners()
    host.emit('browser-state', { active: true, url: 'https://b.test', title: 'B', tabs: [], canCapture: true, visibility: 'visible' })
    expect(hostState.url).toBe('https://b.test')
    expect(hostState.canCapture).toBe(true)
  })

  it('browser-raise 用计数通知界面，面板不在界面上时也得有人接', () => {
    ensureHostListeners()
    const before = hostState.raiseSeq
    host.emit('browser-raise', { reason: 'screenshot', tabId: 'b1' })
    expect(hostState.raiseSeq).toBe(before + 1)
    expect(hostState.raiseReason).toBe('screenshot')
  })

  it('白名单拦截与 Agent 手势各占一个计数，重复推送也能被界面看到', () => {
    ensureHostListeners()
    host.emit('browser-blocked', { url: 'https://evil.test', host: 'evil.test' })
    host.emit('browser-blocked', { url: 'https://evil.test', host: 'evil.test' })
    expect(hostState.blockedSeq).toBe(2)
    expect(hostState.blockedHost).toBe('evil.test')

    host.emit('browser-gesture', { type: 'click', tabId: 'b1', x: 120, y: 80 })
    const seqAfterClick = hostState.gestureSeq
    const click = hostState.gestures[hostState.gestures.length - 1]
    expect(click.type).toBe('click')
    expect([click.x, click.y]).toEqual([120, 80])

    // 同帧内连发两个动作：两个都要在日志里，不能只留最后一个
    host.emit('browser-gesture', { type: 'type', tabId: 'b1', x: 120, y: 80, length: 6 })
    expect(hostState.gestureSeq).toBe(seqAfterClick + 1)
    expect(hostState.gestures.slice(-2).map(g => g.type)).toEqual(['click', 'type'])
    // 填写动作只带字数：正文可能就在密码框里，不进渲染进程的状态
    expect(hostState.gestures[hostState.gestures.length - 1].length).toBe(6)

    // 看不懂的动作直接丢，不要推进界面计数（画一个含义不明的箭头比不画更误人）
    host.emit('browser-gesture', { type: 'drag', x: 1, y: 1 })
    expect(hostState.gestureSeq).toBe(seqAfterClick + 1)
    expect(hostState.gestures).toHaveLength(2)
  })

  it('弹窗转成的新标签会被选为活动标签', () => {
    ensureHostListeners()
    host.emit('browser-tab-opened', { tabId: 'b2', url: 'https://c.test', fromTabId: 'b1' })
    expect(hostState.activeTabId).toBe('b2')
  })

  it('browser-hold 广播带着上锁来源，界面要能说清是谁锁的', () => {
    ensureHostListeners()
    host.emit('browser-hold', { on: true, source: 'input' })
    expect(hostState.manualHold).toBe(true)
    expect(hostState.holdSource).toBe('input')
    expect(browserView.manualHold).toBe(true)

    host.emit('browser-hold', { on: false, source: '' })
    expect(hostState.manualHold).toBe(false)
    expect(browserView.manualHold).toBe(false)
  })

  it('重复订阅只会挂一份监听', () => {
    const off = vi.fn()
    const spy = vi.spyOn(host.api, 'onBrowserState').mockImplementation(() => off)
    ensureHostListeners()
    ensureHostListeners()
    expect(spy).toHaveBeenCalledTimes(1)
    void spy
  })

  it('卸载监听后不再更新镜像', () => {
    ensureHostListeners()
    disposeHostListeners()
    const before = hostState.raiseSeq
    host.emit('browser-raise', { reason: 'screenshot' })
    expect(hostState.raiseSeq).toBe(before)
  })
})

describe('接管锁与身份', () => {
  it('面板发起的 set-hold 默认按用户身份上报，on 缺省时不传参数（主进程取反）', async () => {
    await setHold()
    expect(host.calls[0]).toEqual({ action: 'set-hold', params: {}, actor: 'user' })
    await setHold(true)
    expect(host.calls[1].params).toEqual({ on: true })
  })

  it('显式传 actor 时原样带过去，Agent 与用户走的是主进程两道关卡', async () => {
    await hostAction('click', { x: 10, y: 20 }, { actor: 'agent' })
    expect(host.calls[0].actor).toBe('agent')
  })
})
