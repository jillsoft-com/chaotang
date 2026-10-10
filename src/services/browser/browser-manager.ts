/**
 * BrowserManager — 浏览器实例管理
 *
 * 通过 Electron IPC 与主进程的 Playwright 实例通信。
 * 提供统一的浏览器操作接口。
 */

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
}

/**
 * 执行浏览器操作
 * 通过 Electron IPC 调用主进程的 Playwright
 */
export async function browserAction(
  action: 'navigate' | 'screenshot' | 'snapshot' | 'click' | 'type' | 'evaluate' | 'close',
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
