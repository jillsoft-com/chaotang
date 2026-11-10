/**
 * 浏览器面板共享状态 — 人机共用同一个 headless 页面
 *
 * 为什么放在渲染进程：
 * Agent 工具处理器与浏览器面板运行在同一个渲染进程里，共享一份模块级状态即可协调，
 * 不需要跨进程锁。主进程只负责持有 Playwright 单例 page。
 *
 * 协调规则（用户选定的「可点击 + Agent 占用时自动暂停」）：
 * - Agent 每次调用浏览器工具前置 agentBusy，面板据此禁用人工操作并提示；
 * - 用户显式开启「接管」后 manualHold 为真，Agent 的浏览器工具会等待其释放（最长 60 秒），
 *   从而实现「自动暂停 Agent」而不是彼此打断。
 */

import { reactive } from 'vue'
import { browserAction, type BrowserActionResult } from './browser-manager'

const BLANK = 'about:blank'

/** Agent 等待人工释放接管的最长时间 */
export const MANUAL_HOLD_WAIT_MS = 60_000

export interface ViewportSize {
  width: number
  height: number
}

export const browserView = reactive({
  /** 当前页面地址 */
  url: '',
  /** 当前页面标题 */
  title: '',
  /** 是否已导航到真实页面 */
  active: false,
  /** 最近一帧画面（data URL） */
  image: '',
  /** headless 视口尺寸，用于把面板点击换算为页面坐标 */
  viewport: { width: 1280, height: 720 } as ViewportSize,
  /** Agent 正在使用浏览器 */
  agentBusy: false,
  /** 占用浏览器的 Agent 工具名 */
  agentLabel: '',
  /** 用户已接管，Agent 需等待 */
  manualHold: false,
  /** 最近一次失败原因 */
  lastError: '',
  /** 面板自维护的访问历史（Playwright 不暴露历史栈长度，据此启用前进/后退按钮） */
  navHistory: [] as string[],
  navIndex: -1
})

/** 后退/前进可用性 */
export function canGoBack(): boolean {
  return browserView.navIndex > 0
}

export function canGoForward(): boolean {
  return browserView.navIndex >= 0 && browserView.navIndex < browserView.navHistory.length - 1
}

/** 记录页面地址变化：命中历史则移动指针（后退/前进），否则截断尾部并追加 */
export function recordUrl(url: string, viaHistory = false): void {
  if (!url || url === BLANK) return
  if (viaHistory) {
    const i = browserView.navHistory.lastIndexOf(url)
    if (i >= 0) browserView.navIndex = i
    return
  }
  if (browserView.navHistory[browserView.navIndex] === url) return
  const trimmed = browserView.navHistory.slice(0, browserView.navIndex + 1)
  trimmed.push(url)
  browserView.navHistory = trimmed
  browserView.navIndex = trimmed.length - 1
}

/** 用 IPC 返回的页面信息刷新共享状态 */
export function applyPageInfo(res: BrowserActionResult, viaHistory = false): void {
  if (!res.success) {
    if (res.error) browserView.lastError = res.error
    return
  }
  if (typeof res.active === 'boolean') browserView.active = res.active
  if (typeof res.url === 'string' && res.url) {
    browserView.url = res.url
    browserView.active = res.url !== BLANK
    recordUrl(res.url, viaHistory)
  }
  if (typeof res.title === 'string') browserView.title = res.title
  const vp = res.viewport
  if (vp && typeof vp.width === 'number' && typeof vp.height === 'number') {
    browserView.viewport = { width: vp.width, height: vp.height }
  }
  browserView.lastError = ''
}

/**
 * 统一执行浏览器操作，并把结果同步进共享状态。
 * 面板按钮与 Agent 工具都走这里，保证人机看到的是同一份 URL/标题。
 */
export async function runBrowserAction(
  action: Parameters<typeof browserAction>[0],
  params: Record<string, any> = {},
  viaHistory = false
): Promise<BrowserActionResult> {
  const res = await browserAction(action, params)
  if (res.success) {
    applyPageInfo(res, viaHistory)
  } else if (res.error) {
    browserView.lastError = res.error
  }
  return res
}

// ============ Agent 占用标记 ============

let agentRefCount = 0

/** Agent 开始使用浏览器（并发 worker 用计数，避免先结束的把状态清掉） */
export function beginAgentUse(label: string): void {
  agentRefCount++
  browserView.agentBusy = true
  browserView.agentLabel = label
}

/** Agent 结束使用浏览器 */
export function endAgentUse(): void {
  agentRefCount = Math.max(0, agentRefCount - 1)
  if (agentRefCount === 0) {
    browserView.agentBusy = false
    browserView.agentLabel = ''
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 人工接管期间供 Agent 侧等待；超时仍未释放则报错，让模型知道要等用户松手。
 * @returns 等待耗时（毫秒），未接管时为 0
 */
export async function awaitManualRelease(timeoutMs = MANUAL_HOLD_WAIT_MS): Promise<number> {
  if (!browserView.manualHold) return 0
  const started = Date.now()
  while (browserView.manualHold && Date.now() - started < timeoutMs) {
    await sleep(300)
  }
  if (browserView.manualHold) {
    throw new Error(
      `用户正在接管浏览器操作，已等待 ${Math.round((Date.now() - started) / 1000)} 秒仍未释放。` +
      '请提示用户在浏览器面板退出「接管」后再继续，或改用 browser_snapshot 获取页面结构。'
    )
  }
  return Date.now() - started
}

/** 面板卸载时清理接管标记，避免 Agent 被永久挡住 */
export function releaseManualHold(): void {
  browserView.manualHold = false
}

/** 关闭浏览器实例并复位状态 */
export async function resetBrowserView(): Promise<BrowserActionResult> {
  const res = await browserAction('close', {})
  browserView.url = ''
  browserView.title = ''
  browserView.active = false
  browserView.image = ''
  browserView.lastError = ''
  browserView.navHistory = []
  browserView.navIndex = -1
  browserView.manualHold = false
  return res
}
