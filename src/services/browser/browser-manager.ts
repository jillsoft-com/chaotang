/**
 * BrowserManager — 浏览器通道
 *
 * 通过 Electron IPC 与主进程的内嵌宿主通信：真实页面画在面板上，动作走 CDP。
 * M7 之前这里还按 browser_engine 开关在「Playwright 截图回传」与「内嵌宿主」之间二选一，
 * 老通道已经删除，现在只有一条路，调用方不需要再关心走的是哪个浏览器。
 */

import { isHostAction } from './browser-engine'

/** 浏览器操作名：与 electron/browser-host.cjs 的 actions 表一一对应 */
export type BrowserActionName =
  | 'navigate'
  | 'screenshot'
  | 'snapshot'
  | 'click'
  | 'type'
  | 'evaluate'
  | 'close'
  | 'set-policy'
  | 'back'
  | 'forward'
  | 'reload'
  | 'state'
  | 'viewport'
  | 'mouse-click'
  | 'mouse-wheel'
  | 'keyboard'
  // 以下动作与 electron/browser-host.cjs 的 actions 表对应（M4 工具层开始使用 tab-* / query 等）
  | 'tab-list'
  | 'tab-open'
  | 'tab-select'
  | 'tab-close'
  | 'stop'
  | 'set-bounds'
  | 'detach'
  | 'attach'
  | 'set-auto-raise'
  | 'query'
  | 'hover'
  | 'scroll'
  | 'frame-evaluate'
  | 'set-hold'

/**
 * 调用方身份（M6）。
 * 面板与宿主自己的控制面用 'user'，Agent 工具用 'agent'：
 * 接管锁只拦 Agent 的写操作，用户自己的按钮不能因为“正在接管”反而点不动。
 */
export type BrowserActor = 'agent' | 'user'

/** 浏览器操作结果 */
export interface BrowserActionResult {
  success: boolean
  error?: string
  title?: string
  url?: string
  data?: string
  type?: string
  accessibilityTree?: string
  truncated?: boolean
  result?: any
  message?: string
  /** 页面是否已导航到真实地址（state/screenshot 返回） */
  active?: boolean
  /** 页面视口尺寸（宿主按面板矩形定） */
  viewport?: { width: number; height: number }
  /** 后退/前进是否真的移动了（无可历史记录时为 false） */
  moved?: boolean
  /** 导航响应的 HTTP 状态码 */
  httpStatus?: number
  /** 主进程当前生效的策略（state 返回，用于校验下发是否成功） */
  policy?: { allowlistEnabled?: boolean; allowlist?: string[]; strictAllowlist?: boolean }
  // ============ 宿主返回的诊断字段 ============
  /** 画面可得性分级：拿不到截图与真事件时模型据此判断该不该相信这一步 */
  visibility?: 'visible' | 'detached' | 'minimized' | 'hidden' | 'zero-size'
  /**
   * 承载位置（M8-b）：'bg' 表示面板不可见时该标签页已搬进离屏 ghost 孪生视图，
   * 真点击/截图照旧可用；'fg' 前台正常视图。与 visibility 正交。
   */
  carrier?: 'fg' | 'bg'
  offscreen?: boolean
  canCapture?: boolean
  captureHint?: string
  /**
   * 输入侧的三位能力（真事件矩阵探针实测）：
   * canKey 与前台状态无关，canWheel 只要求挂载且有尺寸，canClick 还要窗口没被藏起来。
   */
  canClick?: boolean
  canWheel?: boolean
  canKey?: boolean
  clickHint?: string
  /** 退化为 JS 合成事件（isTrusted 为 false） */
  fallback?: boolean
  warning?: string
  hint?: string
  /** 暂时拿不到画面（窗口被遮挡、刚重挂载），重试即可，不要当作操作失败 */
  retryable?: boolean
  tabId?: string | null
  /** tab-list / state 返回的活动标签页 id */
  activeTabId?: string | null
  tabs?: Array<{ id: string; url: string; title: string; active: boolean; mounted: boolean }>
  loadError?: string
  blockedUrl?: string
  frameUrl?: string
  /** 历史栈可用性（来自真实页面，只有内嵌宿主能答） */
  canBack?: boolean
  canForward?: boolean
  /** 主进程理解中的面板显隐状态 */
  panelVisible?: boolean | null
  /** Agent 需要画面时是否允许自动唤前 */
  autoRaise?: boolean
  /** 接管锁状态与来路（以主进程为准，面板的本地标记只是镜像） */
  manualHold?: boolean
  holdSource?: string
}

const WEB_MODE_ERROR = '当前为 Web 模式，浏览器自动化仅在 Electron 桌面版可用'

/**
 * 执行浏览器操作
 *
 * 只有一条通道，因此没有「退一步」可说：宿主通道不在（Web 模式、旧安装包）
 * 就是失败，不做静默降级 —— 用户勾了白名单却没人下发，比直接报错难查得多。
 *
 * actor 是调用方身份：'agent' 的写操作会在接管期间被主进程拦住，
 * 面板与控制面发的动作缺省 'user'，否则用户会被自己的接管锁在门外。
 */
export async function browserAction(
  action: BrowserActionName,
  params: Record<string, any> = {},
  opts: { actor?: BrowserActor } = {}
): Promise<BrowserActionResult> {
  const api = window.electronAPI
  if (!api) return { success: false, error: WEB_MODE_ERROR }
  if (!api.browserHostAction) {
    return {
      success: false,
      error: `内嵌宿主通道不可用（${action}），请重启应用；旧版安装包不携带该通道`
    }
  }
  // 动作表与主进程不一致时早报错：否则要等到宿主返回「未知动作」才暴露
  if (!isHostAction(action)) {
    return { success: false, error: `宿主不支持的动作：${action}` }
  }
  return await api.browserHostAction({ action, params, actor: opts.actor || 'user' })
}

/**
 * 检查浏览器自动化是否可用
 */
export function isBrowserAvailable(): boolean {
  return !!window.electronAPI?.browserHostAction
}
