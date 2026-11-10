/**
 * BrowserManager — 浏览器通道选择
 *
 * 通过 Electron IPC 与主进程通信。并存两条通道：
 * - playwright：老通道，headless 实例 + 截图回传面板
 * - embedded：内嵌宿主，真实页面画在面板上 + CDP 驱动
 * 走哪一条由 browser-engine 的开关决定，调用方无感。
 */

import { canRouteEmbedded, isEmbeddedBrowser } from './browser-engine'

/** 浏览器操作名：与主进程两条 IPC 的分支对应 */
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
  // 以下仅内嵌宿主支持（M4 工具层开始使用）
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
  // ============ 以下字段只有内嵌宿主会返 ============
  /** 画面可得性分级：拿不到截图与真事件时模型据此判断该不该相信这一步 */
  visibility?: 'visible' | 'detached' | 'minimized' | 'hidden' | 'zero-size'
  canCapture?: boolean
  captureHint?: string
  /** 退化为 JS 合成事件（isTrusted 为 false） */
  fallback?: boolean
  warning?: string
  hint?: string
  /** 暂时拿不到画面（窗口被遮挡、刚重挂载），重试即可，不要当作操作失败 */
  retryable?: boolean
  tabId?: string | null
  tabs?: Array<{ id: string; url: string; title: string; active: boolean; mounted: boolean }>
  loadError?: string
  blockedUrl?: string
  frameUrl?: string
}

/**
 * 老通道（Playwright）认识的动作。
 * 宿主专属动作（tab-* / query / hover / scroll / frame-evaluate / set-bounds 等）不在这里，
 * Playwright 根本做不了，不能假装能退回老通道。
 */
const LEGACY_ACTIONS: ReadonlySet<string> = new Set([
  'navigate', 'screenshot', 'snapshot', 'click', 'type', 'evaluate', 'close',
  'set-policy', 'back', 'forward', 'reload', 'state', 'viewport',
  'mouse-click', 'mouse-wheel', 'keyboard'
])

const WEB_MODE_ERROR = '当前为 Web 模式，浏览器自动化仅在 Electron 桌面版可用'

/**
 * 执行浏览器操作
 *
 * 路由规则：
 * 1. 只有宿主能做的动作 → 走宿主，不可用时报错（不假装能退回）；
 * 2. 两边都能做的动作 → 由 browser_engine 开关选一条；
 * 3. 开关说走宿主但 preload 未暴露宿主通道 → 明确报错而不是静默降级。
 */
export async function browserAction(
  action: BrowserActionName,
  params: Record<string, any> = {}
): Promise<BrowserActionResult> {
  const api = window.electronAPI
  if (!api) return { success: false, error: WEB_MODE_ERROR }

  const legacyCanDo = LEGACY_ACTIONS.has(action)
  const hostCanDo = canRouteEmbedded(action)
  const wantHost = hostCanDo && (isEmbeddedBrowser() || !legacyCanDo)

  if (wantHost) {
    if (!api.browserHostAction) {
      return {
        success: false,
        error: `内嵌宿主通道不可用（${action}），请重启应用；旧版安装包不携带该通道`
      }
    }
    return await api.browserHostAction({ action, params })
  }

  if (!api.browserAction) return { success: false, error: WEB_MODE_ERROR }
  return await api.browserAction({ action: action as Parameters<typeof api.browserAction>[0]['action'], params })
}

/**
 * 检查浏览器自动化是否可用（两条通道任一存在即可）
 */
export function isBrowserAvailable(): boolean {
  return !!(window.electronAPI?.browserAction || window.electronAPI?.browserHostAction)
}
