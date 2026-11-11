/**
 * 浏览器共享状态测试（单轨：内嵌宿主）
 *
 * 覆盖：
 * - IPC 返回结果同步进共享状态（人机看到同一份 URL/标题）
 * - Agent 占用引用计数
 * - 人工接管期间的等待与超时报错
 *
 * 宿主推送的那一半另有 browser-host-session.test.ts，两边不要串。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  browserView,
  applyPageInfo,
  runBrowserAction,
  beginAgentUse,
  endAgentUse,
  awaitManualRelease,
  resetBrowserView
} from '@/services/browser/browser-session'

const mockHostAction = vi.fn()

beforeEach(() => {
  // 复位单例状态，避免用例间相互影响
  browserView.url = ''
  browserView.title = ''
  browserView.active = false
  browserView.viewport = { width: 1280, height: 720 }
  browserView.agentBusy = false
  browserView.agentLabel = ''
  browserView.manualHold = false
  browserView.lastError = ''
  mockHostAction.mockReset()
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { browserHostAction: mockHostAction }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
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
    applyPageInfo({ success: true, url: 'https://a.com' })
    applyPageInfo({ success: false, error: 'DOMAIN_BLOCKED: evil.com' })
    expect(browserView.lastError).toContain('DOMAIN_BLOCKED')
    expect(browserView.url).toBe('https://a.com')
  })

  it('回到空白页时 active 置否', () => {
    applyPageInfo({ success: true, url: 'https://a.com' })
    applyPageInfo({ success: true, active: false, url: 'about:blank' })
    expect(browserView.active).toBe(false)
  })

  it('接管锁跟着主进程的返回值走', () => {
    applyPageInfo({ success: true, manualHold: true })
    expect(browserView.manualHold).toBe(true)
    // 缺字段时不能把已有值抹掉：back 这类动作只回 url/title
    applyPageInfo({ success: true, url: 'https://a.com' })
    expect(browserView.manualHold).toBe(true)
  })
})

describe('runBrowserAction', () => {
  it('透传动作并把结果同步到共享状态', async () => {
    mockHostAction.mockResolvedValue({ success: true, url: 'https://a.com', title: 'A' })
    const res = await runBrowserAction('navigate', { url: 'https://a.com' })
    expect(res.success).toBe(true)
    expect(mockHostAction).toHaveBeenCalledWith({
      action: 'navigate',
      params: { url: 'https://a.com' },
      actor: 'user'
    })
    expect(browserView.title).toBe('A')
  })

  it('Agent 侧的身份原样送到主进程', async () => {
    mockHostAction.mockResolvedValue({ success: true })
    await runBrowserAction('click', { selector: '#btn' }, { actor: 'agent' })
    expect(mockHostAction).toHaveBeenCalledWith({
      action: 'click',
      params: { selector: '#btn' },
      actor: 'agent'
    })
  })

  it('失败时把错误写进 lastError 并原样返回', async () => {
    mockHostAction.mockResolvedValue({ success: false, error: 'MANUAL_HOLD: 用户正在接管页面' })
    const res = await runBrowserAction('click', { selector: '#btn' }, { actor: 'agent' })
    expect(res.success).toBe(false)
    expect(browserView.lastError).toContain('MANUAL_HOLD')
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
  it('清空页面表象与接管标记', () => {
    applyPageInfo({ success: true, url: 'https://a.com', title: 'A', manualHold: true })
    browserView.lastError = 'DOMAIN_BLOCKED'

    resetBrowserView()

    expect(browserView.url).toBe('')
    expect(browserView.title).toBe('')
    expect(browserView.active).toBe(false)
    expect(browserView.lastError).toBe('')
    expect(browserView.manualHold).toBe(false)
  })
})
