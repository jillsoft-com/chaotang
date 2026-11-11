/**
 * 内嵌浏览器能力表
 *
 * M7 之前这里住着一个「引擎开关」（playwright / embedded），用来决定一次调用走哪条 IPC。
 * Playwright 通道连同那个开关都已经删掉了，现在浏览器自动化只有内嵌宿主一条路，
 * 所以本模块只剩两件仍然需要集中维护的事：
 * 1. 动作集合：必须与 electron/browser-host.cjs 的 actions 表一致，漏一个就会让
 *    面板/工具层的调用在运行期撞到「未知动作」，写在这里比散落到各调用点更容易对齐；
 * 2. 通道可用性：Web 模式和旧安装包不带 browserHostAction，得有人如实回答，
 *    而不是让调用方以为操作成功了。
 */

/** 内嵌宿主支持的动作集合，与 electron/browser-host.cjs 的 actions 表一致 */
export const HOST_ACTIONS: ReadonlySet<string> = new Set([
  'tab-list', 'tab-open', 'tab-select', 'tab-close',
  'navigate', 'back', 'forward', 'reload', 'stop', 'state',
  'set-policy', 'set-bounds', 'detach', 'attach', 'set-auto-raise', 'set-hold',
  'viewport', 'screenshot', 'snapshot', 'query', 'evaluate',
  'click', 'mouse-click', 'hover', 'type', 'keyboard',
  'scroll', 'mouse-wheel', 'frame-evaluate', 'close'
])

/** 该动作是否由内嵌宿主提供 */
export function isHostAction(action: string): boolean {
  return HOST_ACTIONS.has(action)
}

/** 宿主 IPC 通道是否就位（设置页展示用；面板挂载时的判定走 browser-host-session 的 isHostAvailable） */
export function isHostChannelAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.browserHostAction
}
