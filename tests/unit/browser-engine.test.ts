/**
 * 浏览器引擎开关与通道路由测试（内嵌浏览器 M2）
 *
 * 覆盖两条容易出事的地方：
 * 1. 宿主专属动作不能静默退回 Playwright —— Playwright 没有 tab 概念，退回只会得到
 *    「未知的浏览器操作」，用户看不到真实原因；
 * 2. 存储尚未初始化时读引擎偏好会抛错，必须退回默认值而不是让面板崩掉。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { appStorage } from '@/services/storage'
import {
  BROWSER_ENGINE_KEY,
  EMBEDDED_ACTIONS,
  canRouteEmbedded,
  getBrowserEngine,
  resetBrowserEngineCache,
  setBrowserEngine
} from '@/services/browser/browser-engine'
import { browserAction, isBrowserAvailable } from '@/services/browser/browser-manager'

/** 造一个假的 electronAPI，记录被调用的是哪条通道 */
function mockApi(opts: { legacy?: boolean; host?: boolean }) {
  const calls: Array<{ channel: string; action: string }> = []
  const reply = (channel: string) => async ({ action }: { action: string }) => {
    calls.push({ channel, action })
    return { success: true, message: channel }
  }
  const api: Record<string, any> = {}
  if (opts.legacy) api.browserAction = vi.fn(reply('legacy'))
  if (opts.host) api.browserHostAction = vi.fn(reply('host'))
  ;(window as any).electronAPI = Object.keys(api).length ? api : undefined
  return calls
}

/** 把持久层换成内存表，避免未初始化存储招致干扰 */
let store: Map<string, string>

beforeEach(() => {
  store = new Map()
  vi.spyOn(appStorage, 'getItem').mockImplementation((key: string) => store.get(key) ?? null)
  vi.spyOn(appStorage, 'setItem').mockImplementation((key: string, value: string) => { store.set(key, value) })
  resetBrowserEngineCache()
  ;(window as any).electronAPI = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('引擎偏好', () => {
  it('存储不可用时退回 Playwright 默认值而不抛错', () => {
    // 未 initializeAppStorage 时 getItem 会抛「本地存储尚未初始化」
    vi.spyOn(appStorage, 'getItem').mockImplementation(() => {
      throw new Error('本地存储尚未初始化')
    })
    expect(getBrowserEngine()).toBe('playwright')
  })

  it('非法存储值也退回默认值', () => {
    store.set(BROWSER_ENGINE_KEY, 'webkit')
    expect(getBrowserEngine()).toBe('playwright')
  })

  it('存储值可生效', () => {
    store.set(BROWSER_ENGINE_KEY, 'embedded')
    expect(getBrowserEngine()).toBe('embedded')
  })

  it('写入失败不影响本次生效', () => {
    vi.spyOn(appStorage, 'setItem').mockImplementation(() => {
      throw new Error('本地存储尚未初始化')
    })
    expect(setBrowserEngine('embedded')).toBe('embedded')
    expect(getBrowserEngine()).toBe('embedded')
  })

  it('写入成功时下次读取一致', () => {
    setBrowserEngine('embedded')
    expect(store.get(BROWSER_ENGINE_KEY)).toBe('embedded')
    resetBrowserEngineCache()
    expect(getBrowserEngine()).toBe('embedded')
  })
})

describe('动作能力表', () => {
  it('宿主支持全部老通道动作，切引擎不会丢能力', () => {
    for (const legacy of ['navigate', 'screenshot', 'snapshot', 'click', 'type', 'evaluate', 'close',
      'set-policy', 'back', 'forward', 'reload', 'state', 'viewport', 'mouse-click', 'mouse-wheel', 'keyboard']) {
      expect(canRouteEmbedded(legacy)).toBe(true)
    }
    expect([...EMBEDDED_ACTIONS].length).toBeGreaterThan(16)
  })

  it('未知动作不会被路由到宿主', () => {
    expect(canRouteEmbedded('teleport')).toBe(false)
  })
})

describe('通道路由', () => {
  it('默认引擎下共用动作走 Playwright', async () => {
    const calls = mockApi({ legacy: true, host: true })
    setBrowserEngine('playwright')
    await browserAction('navigate', { url: 'https://example.com' })
    expect(calls[0]).toEqual({ channel: 'legacy', action: 'navigate' })
  })

  it('切到内嵌后共用动作走宿主', async () => {
    const calls = mockApi({ legacy: true, host: true })
    setBrowserEngine('embedded')
    await browserAction('navigate', { url: 'https://example.com' })
    expect(calls[0]).toEqual({ channel: 'host', action: 'navigate' })
  })

  it('宿主专属动作即使引擎没切也走宿主', async () => {
    const calls = mockApi({ legacy: true, host: true })
    setBrowserEngine('playwright')
    await browserAction('tab-list', {})
    expect(calls[0]).toEqual({ channel: 'host', action: 'tab-list' })
  })

  it('宿主专属动作在宿主通道缺失时报错，不伪造成功', async () => {
    mockApi({ legacy: true })
    setBrowserEngine('playwright')
    const res = await browserAction('tab-open', { url: 'https://example.com' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('内嵌宿主通道不可用')
  })

  it('Web 模式下给出可读提示', async () => {
    ;(window as any).electronAPI = undefined
    const res = await browserAction('screenshot', {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('Web 模式')
    expect(isBrowserAvailable()).toBe(false)
  })
})
