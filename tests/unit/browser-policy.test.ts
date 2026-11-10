/**
 * 浏览器安全策略测试
 *
 * 覆盖：
 * - 域名归一化与子域匹配
 * - 白名单开关语义（关闭=全放行，开启但空表=全拦截）
 * - 策略保存后的清洗与主进程下发调用
 * - 导航前确认的放行/拒绝路径
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  browserPolicy,
  DEFAULT_BROWSER_POLICY,
  normalizeHost,
  hostOf,
  isUrlAllowed,
  cleanAllowlist,
  saveBrowserPolicy,
  setBrowserConfirmHandler,
  confirmNavigation,
  type BrowserPolicy
} from '@/services/browser/browser-policy'

function policy(overrides: Partial<BrowserPolicy> = {}): BrowserPolicy {
  return { ...DEFAULT_BROWSER_POLICY, allowlist: [], ...overrides }
}

describe('normalizeHost', () => {
  it('去掉协议、路径、端口并转小写', () => {
    expect(normalizeHost('HTTPS://WWW.Example.COM/docs/a')).toBe('www.example.com')
    expect(normalizeHost('localhost:3000')).toBe('localhost')
    expect(normalizeHost('  github.com  ')).toBe('github.com')
  })

  it('空值归一化为空串', () => {
    expect(normalizeHost('')).toBe('')
    expect(normalizeHost('   ')).toBe('')
    expect(normalizeHost(undefined as any)).toBe('')
  })
})

describe('hostOf', () => {
  it('解析主机名', () => {
    expect(hostOf('https://a.example.com/x?y=1')).toBe('a.example.com')
    expect(hostOf('http://localhost:5173')).toBe('localhost')
  })

  it('非法 URL 返回空串', () => {
    expect(hostOf('不是地址')).toBe('')
  })
})

describe('isUrlAllowed', () => {
  it('未开启白名单时一律放行', () => {
    const p = policy({ allowlistEnabled: false, allowlist: [] })
    expect(isUrlAllowed(p, 'https://anything.com')).toBe(true)
  })

  it('开启白名单但列表为空时一律拦截', () => {
    const p = policy({ allowlistEnabled: true, allowlist: [] })
    expect(isUrlAllowed(p, 'https://example.com')).toBe(false)
  })

  it('精确匹配与子域匹配', () => {
    const p = policy({ allowlistEnabled: true, allowlist: ['example.com'] })
    expect(isUrlAllowed(p, 'https://example.com/')).toBe(true)
    expect(isUrlAllowed(p, 'https://www.example.com')).toBe(true)
    expect(isUrlAllowed(p, 'https://a.b.example.com')).toBe(true)
    expect(isUrlAllowed(p, 'https://notexample.com')).toBe(false)
    expect(isUrlAllowed(p, 'https://example.com.evil.net')).toBe(false)
  })

  it('白名单条目自带协议与路径也能匹配', () => {
    const p = policy({ allowlistEnabled: true, allowlist: ['https://GitHub.com/tree'] })
    expect(isUrlAllowed(p, 'https://github.com/x')).toBe(true)
  })

  it('无法解析的地址视为拦截', () => {
    const p = policy({ allowlistEnabled: true, allowlist: ['example.com'] })
    expect(isUrlAllowed(p, 'file:///C:/secret.txt')).toBe(false)
    expect(isUrlAllowed(p, '乱码')).toBe(false)
  })
})

describe('cleanAllowlist', () => {
  it('归一化、去重并剔除端口与路径', () => {
    const p = policy({ allowlist: ['https://A.com/x', 'a.com', ' B.com ', 'localhost:3000', ''] })
    expect(cleanAllowlist(p)).toEqual(['a.com', 'b.com', 'localhost'])
  })
})

describe('saveBrowserPolicy', () => {
  const original = { ...browserPolicy, allowlist: [...browserPolicy.allowlist] }

  afterEach(() => {
    Object.assign(browserPolicy, original, { allowlist: [...original.allowlist] })
    vi.restoreAllMocks()
  })

  it('保存时清洗白名单并下发主进程', async () => {
    const spy = vi.fn()
    ;(globalThis as any).window = window
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { browserAction: spy }
    })

    browserPolicy.allowlistEnabled = true
    browserPolicy.allowlist = ['https://A.com/docs', 'a.com', 'localhost:3000']
    saveBrowserPolicy()

    expect(browserPolicy.allowlist).toEqual(['a.com', 'localhost'])
    // set-policy 是异步下发（saveBrowserPolicy 内部不等待），等一个微任务队列
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(spy).toHaveBeenCalledWith({
      action: 'set-policy',
      params: { allowlistEnabled: true, allowlist: ['a.com', 'localhost'] }
    })
  })
})

describe('confirmNavigation', () => {
  const original = { ...browserPolicy, allowlist: [...browserPolicy.allowlist] }

  afterEach(() => {
    Object.assign(browserPolicy, original, { allowlist: [...original.allowlist] })
    setBrowserConfirmHandler(null)
  })

  it('策略关闭时不打扰用户', async () => {
    const handler = vi.fn(async () => false)
    setBrowserConfirmHandler(handler)
    browserPolicy.confirmNavigation = false
    expect(await confirmNavigation('https://example.com', 'manual')).toBe(true)
    expect(handler).not.toHaveBeenCalled()
  })

  it('未注册回调时默认放行（Web 模式等非 UI 场景）', async () => {
    setBrowserConfirmHandler(null)
    browserPolicy.confirmNavigation = true
    expect(await confirmNavigation('https://example.com', 'agent')).toBe(true)
  })

  it('开启后按回调结果决定，并提示白名单外风险', async () => {
    const messages: Array<{ title: string; detail: string }> = []
    setBrowserConfirmHandler(async (title, detail) => {
      messages.push({ title, detail })
      return false
    })
    browserPolicy.confirmNavigation = true
    browserPolicy.allowlistEnabled = true
    browserPolicy.allowlist = ['example.com']

    expect(await confirmNavigation('https://evil.com', 'agent')).toBe(false)
    expect(messages[0].title).toContain('白名单外')
    expect(messages[0].detail).toContain('Agent 即将访问')

    expect(await confirmNavigation('https://example.com', 'manual')).toBe(false)
    expect(messages[1].title).toBe('🌐 浏览器导航确认')
    expect(messages[1].detail).not.toContain('不在白名单')
  })
})
