/**
 * 浏览器面板共享状态测试
 *
 * 覆盖：
 * - 访问历史指针（前进/后退可用性）
 * - IPC 返回结果同步进共享状态
 * - Agent 占用引用计数
 * - 人工接管期间的等待与超时报错
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  browserView,
  recordUrl,
  canGoBack,
  canGoForward,
  applyPageInfo,
  runBrowserAction,
  beginAgentUse,
  endAgentUse,
  awaitManualRelease,
  resetBrowserView
} from '@/services/browser/browser-session'

const mockBrowserAction = vi.fn()

beforeEach(() => {
  // 复位单例状态，避免用例间相互影响
  browserView.url = ''
  browserView.title = ''
  browserView.active = false
  browserView.image = ''
  browserView.viewport = { width: 1280, height: 720 }
  browserView.agentBusy = false
  browserView.agentLabel = ''
  browserView.manualHold = false
  browserView.lastError = ''
  browserView.navHistory = []
  browserView.navIndex = -1
  mockBrowserAction.mockReset()
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { browserAction: mockBrowserAction }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('访问历史指针', () => {
  it('首个地址建立历史且不启用后退', () => {
    recordUrl('https://a.com')
    expect(browserView.navHistory).toEqual(['https://a.com'])
    expect(browserView.navIndex).toBe(0)
    expect(canGoBack()).toBe(false)
    expect(canGoForward()).toBe(false)
  })

  it('新导航截断尾部的前进记录', () => {
    recordUrl('https://a.com')
    recordUrl('https://b.com')
    recordUrl('https://c.com')
    recordUrl('https://b.com', true)
    expect(browserView.navIndex).toBe(1)
    expect(canGoForward()).toBe(true)
    recordUrl('https://d.com')
    expect(browserView.navHistory).toEqual(['https://a.com', 'https://b.com', 'https://d.com'])
    expect(canGoForward()).toBe(false)
  })

  it('同一地址重复记录不增长历史', () => {
    recordUrl('https://a.com')
    recordUrl('https://a.com')
    expect(browserView.navHistory).toHaveLength(1)
  })

  it('about:blank 不进入历史', () => {
    recordUrl('about:blank')
    expect(browserView.navHistory).toEqual([])
    expect(browserView.navIndex).toBe(-1)
  })

  it('后退命中历史时移动指针而不是追加', () => {
    recordUrl('https://a.com')
    recordUrl('https://b.com')
    recordUrl('https://a.com', true)
    expect(browserView.navHistory).toHaveLength(2)
    expect(browserView.navIndex).toBe(0)
    expect(canGoBack()).toBe(false)
    expect(canGoForward()).toBe(true)
  })
})

describe('applyPageInfo', () => {
  it('成功时刷新地址、标题与视口', () => {
    applyPageInfo({ success: true, url: 'https://a.com', title: '站点 A', viewport: { width: 900, height: 600 } })
    expect(browserView.url).toBe('https://a.com')
    expect(browserView.title).toBe('站点 A')
    expect(browserView.active).toBe(true)
    expect(browserView.viewport).toEqual({ width: 900, height: 600 })
    expect(browserView.lastError).toBe('')
  })

  it('失败时只记录错误，不动地址', () => {
    recordUrl('https://a.com')
    applyPageInfo({ success: false, error: 'DOMAIN_BLOCKED: evil.com' })
    expect(browserView.lastError).toContain('DOMAIN_BLOCKED')
    expect(browserView.url).toBe('')
  })

  it('回到空白页时 active 置否', () => {
    applyPageInfo({ success: true, url: 'https://a.com' })
    applyPageInfo({ success: true, active: false, url: 'about:blank' })
    expect(browserView.active).toBe(false)
  })
})

describe('runBrowserAction', () => {
  it('透传动作并把结果同步到共享状态', async () => {
    mockBrowserAction.mockResolvedValue({ success: true, url: 'https://a.com', title: 'A' })
    const res = await runBrowserAction('navigate', { url: 'https://a.com' })
    expect(res.success).toBe(true)
    expect(mockBrowserAction).toHaveBeenCalledWith({ action: 'navigate', params: { url: 'https://a.com' } })
    expect(browserView.title).toBe('A')
  })

  it('历史类动作以 viaHistory 方式记录地址', async () => {
    recordUrl('https://a.com')
    recordUrl('https://b.com')
    mockBrowserAction.mockResolvedValue({ success: true, moved: true, url: 'https://a.com', title: 'A' })
    await runBrowserAction('back', {}, true)
    expect(browserView.navIndex).toBe(0)
    expect(browserView.navHistory).toHaveLength(2)
  })

  it('失败时把错误写进 lastError 并原样返回', async () => {
    mockBrowserAction.mockResolvedValue({ success: false, error: 'Playwright 未安装' })
    const res = await runBrowserAction('navigate', { url: 'https://a.com' })
    expect(res.success).toBe(false)
    expect(browserView.lastError).toBe('Playwright 未安装')
  })
})

describe('Agent 占用标记', () => {
  it('引用计数归零才清除占用状态', () => {
    beginAgentUse('browser_navigate')
    beginAgentUse('browser_screenshot')
    expect(browserView.agentBusy).toBe(true)
    expect(browserView.agentLabel).toBe('browser_screenshot')

    endAgentUse()
    expect(browserView.agentBusy).toBe(true)

    endAgentUse()
    expect(browserView.agentBusy).toBe(false)
    expect(browserView.agentLabel).toBe('')
  })

  it('多余的释放不会把计数压成负数', () => {
    beginAgentUse('browser_click')
    endAgentUse()
    endAgentUse()
    expect(browserView.agentBusy).toBe(false)
  })
})

describe('人工接管', () => {
  it('未接管时立即返回', async () => {
    browserView.manualHold = false
    expect(await awaitManualRelease(50)).toBe(0)
  })

  it('接管期间被释放则继续执行', async () => {
    browserView.manualHold = true
    const release = setTimeout(() => { browserView.manualHold = false }, 120)
    const waited = await awaitManualRelease(2000)
    expect(waited).toBeGreaterThanOrEqual(100)
    clearTimeout(release)
  })

  it('超时仍未释放则报错提醒模型', async () => {
    browserView.manualHold = true
    await expect(awaitManualRelease(100)).rejects.toThrow(/用户正在接管浏览器操作/)
    browserView.manualHold = false
  })
})

describe('resetBrowserView', () => {
  it('关闭实例后清空全部状态', async () => {
    recordUrl('https://a.com')
    browserView.image = 'data:image/jpeg;base64,AA'
    mockBrowserAction.mockResolvedValue({ success: true, message: '浏览器已关闭' })

    await resetBrowserView()

    expect(mockBrowserAction).toHaveBeenCalledWith({ action: 'close', params: {} })
    expect(browserView.navHistory).toEqual([])
    expect(browserView.navIndex).toBe(-1)
    expect(browserView.image).toBe('')
    expect(browserView.active).toBe(false)
    expect(browserView.manualHold).toBe(false)
  })
})
