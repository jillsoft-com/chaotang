/**
 * BrowserManager — 浏览器实例管理
 *
 * 通过 Electron IPC 与主进程的 Playwright 实例通信。
 * 提供统一的浏览器操作接口。
 */

/** 浏览器操作名：与主进程 browser-action IPC 的 switch 分支一一对应 */
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
  /** headless 视口尺寸（面板换算点击坐标用） */
  viewport?: { width: number; height: number }
  /** 后退/前进是否真的移动了（无可历史记录时为 false） */
  moved?: boolean
  /** 导航响应的 HTTP 状态码 */
  httpStatus?: number
  /** 主进程当前生效的策略（state 返回，用于校验下发是否成功） */
  policy?: { allowlistEnabled?: boolean; allowlist?: string[] }
}

/**
 * 执行浏览器操作
 * 通过 Electron IPC 调用主进程的 Playwright
 */
export async function browserAction(
  action: BrowserActionName,
  params: Record<string, any> = {}
): Promise<BrowserActionResult> {
  if (!window.electronAPI?.browserAction) {
    return {
      success: false,
      error: '当前为 Web 模式，浏览器自动化仅在 Electron 桌面版可用'
    }
  }

  return await window.electronAPI.browserAction({ action, params })
}

/**
 * 检查浏览器自动化是否可用
 */
export function isBrowserAvailable(): boolean {
  return !!window.electronAPI?.browserAction
}
