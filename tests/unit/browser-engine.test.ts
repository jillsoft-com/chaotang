/**
 * 浏览器通道与动作能力表测试（内嵌浏览器 M7 单轨版）
 *
 * Playwright 通道删除后，这里守的是单轨时代最容易翻车的三件事：
 * 1. 能力表要覆盖 BrowserActionName 全集 —— 表里漏一个，调用就会以「宿主不支持」失败；
 * 2. 宿主通道缺失（Web 模式、旧安装包）必须明确报错，绝不静默返回成功；
 * 3. actor 要原样送到主进程，接管锁与控制面拦截全靠它，缺省按 'user' 算。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HOST_ACTIONS, isHostAction, isHostChannelAvailable } from '@/services/browser/browser-engine'
import { browserAction, isBrowserAvailable, type BrowserActionName } from '@/services/browser/browser-manager'

/** BrowserActionName 里的每一个动作都必须真的被宿主提供 */
const ALL_ACTIONS: BrowserActionName[] = [
  'navigate', 'screenshot', 'snapshot', 'click', 'type', 'evaluate', 'close',
  'set-policy', 'back', 'forward', 'reload', 'state', 'viewport',
  'mouse-click', 'mouse-wheel', 'keyboard',
  'tab-list', 'tab-open', 'tab-select', 'tab-close', 'stop',
  'set-bounds', 'detach', 'attach', 'set-auto-raise', 'set-hold',
  'query', 'hover', 'scroll', 'frame-evaluate'
]

let calls: Array<{ action: string; params: any; actor?: string }>

/** 只暴露宿主通道，记录送出去的载荷；host=false 给的是「有 preload 但没有宿主通道」的旧安装包 */
function mockHostApi(opts: { host?: boolean } = { host: true }) {
  calls = []
  const api: Record<string, any> = {}
  if (opts.host) {
    api.browserHostAction = vi.fn(({ action, params, actor }: any) => {
      calls.push({ action, params, actor })
      return { success: true, action }
    })
  }
  ;(window as any).electronAPI = api
}

beforeEach(() => {
  ;(window as any).electronAPI = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('动作能力表', () => {
  it('接口声明的动作全部由宿主提供', () => {
    for (const action of ALL_ACTIONS) expect(isHostAction(action)).toBe(true)
    expect(HOST_ACTIONS.size).toBe(ALL_ACTIONS.length)
  })

  it('未知动作不会混进能力表', () => {
    expect(isHostAction('teleport')).toBe(false)
    expect(isHostAction('')).toBe(false)
  })

  it('通道可用性只认宿主通道', () => {
    mockHostApi({ host: false })
    expect(isHostChannelAvailable()).toBe(false)
    mockHostApi()
    expect(isHostChannelAvailable()).toBe(true)
  })
})

describe('单一路由', () => {
  it('动作一律送到宿主，actor 原样透传', async () => {
    mockHostApi()
    await browserAction('tab-list', {}, { actor: 'agent' })
    await browserAction('navigate', { url: 'https://example.com' })
    expect(calls[0]).toEqual({ action: 'tab-list', params: {}, actor: 'agent' })
    // actor 缺省按用户算：面板按钮不能被自己的接管锁挡在门外
    expect(calls[1]).toEqual({ action: 'navigate', params: { url: 'https://example.com' }, actor: 'user' })
  })

  it('能力表外的动作直接拒绝，不浪费一次 IPC', async () => {
    mockHostApi()
    const res = await browserAction('teleport' as BrowserActionName, {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('宿主不支持的动作')
    expect(calls.length).toBe(0)
  })

  it('宿主通道缺失时报错，不伪造成功', async () => {
    mockHostApi({ host: false })
    const res = await browserAction('tab-open', { url: 'https://example.com' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('内嵌宿主通道不可用')
    expect(isBrowserAvailable()).toBe(false)
  })

  it('Web 模式下给出可读提示', async () => {
    ;(window as any).electronAPI = undefined
    const res = await browserAction('screenshot', {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('Web 模式')
    expect(isBrowserAvailable()).toBe(false)
  })
})
