/**
 * 浏览器共享状态 — 人机共用同一个页面
 *
 * 为什么放在渲染进程：
 * Agent 工具处理器与浏览器面板运行在同一个渲染进程里，共享一份模块级状态即可协调，
 * 不需要跨进程锁。页面本体归主进程的内嵌宿主。
 *
 * 与 browser-host-session.ts 的分工：
 * 那份是宿主推送来的真相镜像（标签页、可见性、接管锁），本模块只留两份代码都需要看的
 * 协调量：当前页面表象 + Agent 占用标记。历史栈不再自己记（真实页面会回答 canBack/canForward）。
 *
 * 协调规则（用户选定的「可点击 + Agent 占用时自动暂停」）：
 * - Agent 每次调用浏览器工具前置 agentBusy，面板据此禁用人工操作并提示；
 * - 用户显式开启「接管」后 manualHold 为真，Agent 的浏览器工具会等待其释放（最长 60 秒），
 *   从而实现「自动暂停 Agent」而不是彼此打断。
 */

import { reactive } from 'vue'
import { browserAction, type BrowserActionResult, type BrowserActor } from './browser-manager'

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
  /** 页面视口尺寸（宿主按面板矩形定，面板只需要知道当前尺寸，不拿它换算点击坐标） */
  viewport: { width: 1280, height: 720 } as ViewportSize,
  /** Agent 正在使用浏览器 */
  agentBusy: false,
  /** Agent 占用浏览器的工具名 */
  agentLabel: '',
  /** 用户已接管，Agent 需等待。
   * 这份状态以主进程为准（面板按钮与“用户真的碰了页面”都汇到那里），
   * 本字段只是它的镜像，供 Agent 侧的 awaitManualRelease 同步读取。 */
  manualHold: false,
  /** 最近一次失败原因 */
  lastError: ''
})

/** 用 IPC 返回的页面信息刷新共享状态 */
export function applyPageInfo(res: BrowserActionResult): void {
  if (!res.success) {
    if (res.error) browserView.lastError = res.error
    return
  }
  if (typeof res.active === 'boolean') browserView.active = res.active
  if (typeof res.url === 'string' && res.url) {
    browserView.url = res.url
    browserView.active = res.url !== BLANK
  }
  if (typeof res.title === 'string') browserView.title = res.title
  const vp = res.viewport
  if (vp && typeof vp.width === 'number' && typeof vp.height === 'number') {
    browserView.viewport = { width: vp.width, height: vp.height }
  }
  // 接管锁以主进程为准：面板按钮、用户实际操作页面、退出接管，最后都落到主进程那份状态上
  if (typeof res.manualHold === 'boolean') browserView.manualHold = res.manualHold
  browserView.lastError = ''
}

/**
 * 统一执行浏览器操作，并把结果同步进共享状态。
 * 面板按钮与 Agent 工具都走这里，保证人机看到的是同一份 URL/标题。
 *
 * opts.actor：'agent' 的写操作会在接管期间被主进程拦住，
 * 面板自己发的动作缺省 'user'，否则用户会被自己的接管锁在门外。
 */
export async function runBrowserAction(
  action: Parameters<typeof browserAction>[0],
  params: Record<string, any> = {},
  opts: { actor?: BrowserActor } = {}
): Promise<BrowserActionResult> {
  const res = await browserAction(action, params, opts)
  if (res.success) {
    applyPageInfo(res)
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

/** 关掉整个浏览器时复位共享状态（标签页本身由 browser-host-session 的 closeAllTabs 负责） */
export function resetBrowserView(): void {
  browserView.url = ''
  browserView.title = ''
  browserView.active = false
  browserView.lastError = ''
  browserView.manualHold = false
}
