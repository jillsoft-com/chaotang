/**
 * 浏览器引擎开关 — Playwright 与内嵌宿主并存期间决定走哪条 IPC
 *
 * 为什么要开关而不是直接替换：内嵌宿主要把真实页面画到面板上，前提是渲染进程
 * 已经把面板区域报给主进程（M3）。M2 只交付了主进程侧能力，此时切过去会导致
 * 面板拿不到画面。所以两条通道并存，默认仍走 Playwright，M3 完成后改默认值，
 * M7 删掉 Playwright 后本模块只剩 embedded 一条路。
 *
 * 注意：appStorage 在 initializeAppStorage() 之前读取会抛错，这里必须容错，
 * 否则启动早期的调用方（例如面板挂载时）会整块崩掉。
 */

import { appStorage } from '@/services/storage'

export type BrowserEngine = 'playwright' | 'embedded'

/** 持久化键名（设置页与测试都用它，不要各处硬写字符串） */
export const BROWSER_ENGINE_KEY = 'browser_engine'

const ENGINE_KEY = BROWSER_ENGINE_KEY

/** M3 之前的默认值：内嵌面板尚未接管区域，先用老通道 */
const DEFAULT_ENGINE: BrowserEngine = 'playwright'

/** 内嵌宿主确实支持的动作集合，与 electron/browser-host.cjs 的 actions 表一致 */
export const EMBEDDED_ACTIONS: ReadonlySet<string> = new Set([
  'tab-list', 'tab-open', 'tab-select', 'tab-close',
  'navigate', 'back', 'forward', 'reload', 'stop', 'state',
  'set-policy', 'set-bounds', 'detach', 'attach', 'set-auto-raise',
  'viewport', 'screenshot', 'snapshot', 'query', 'evaluate',
  'click', 'mouse-click', 'hover', 'type', 'keyboard',
  'scroll', 'mouse-wheel', 'frame-evaluate', 'close'
])

let cached: BrowserEngine | null = null

function readStoredEngine(): BrowserEngine | null {
  try {
    const raw = appStorage.getItem(ENGINE_KEY)
    return raw === 'playwright' || raw === 'embedded' ? raw : null
  } catch {
    // 存储尚未初始化：按默认值处理，不做缓存，等初始化后自然纠正
    return null
  }
}

/** 当前生效的引擎 */
export function getBrowserEngine(): BrowserEngine {
  if (cached) return cached
  const stored = readStoredEngine()
  cached = stored ?? DEFAULT_ENGINE
  return cached
}

/**
 * 切换引擎。
 * @returns 实际生效的引擎；存储不可用时只影响本次会话。
 */
export function setBrowserEngine(next: BrowserEngine): BrowserEngine {
  cached = next
  try {
    appStorage.setItem(ENGINE_KEY, next)
  } catch {
    console.warn('[Browser] 引擎偏好未能持久化，仅本次运行生效')
  }
  return next
}

/** 忘记缓存，重新读存储（设置页改完偏好后调用） */
export function resetBrowserEngineCache(): void {
  cached = null
}

export function isEmbeddedBrowser(): boolean {
  return getBrowserEngine() === 'embedded'
}

/**
 * 该动作能否路由到内嵌宿主。
 * 老通道独有的动作（目前没有）会退回 Playwright，避免切引擎后静默失效。
 */
export function canRouteEmbedded(action: string): boolean {
  return EMBEDDED_ACTIONS.has(action)
}

/** 供设置页展示：内嵌通道是否可用（需要 preload 暴露 browserHostAction） */
export function isEmbeddedAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.browserHostAction
}
