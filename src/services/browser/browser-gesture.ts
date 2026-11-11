/**
 * 浏览器动作可视化数据层（M5）
 *
 * 主进程每次真实输入（或退化合成）都会广播一条 gesture，这里把它变成界面能用的东西：
 * 去噪、按标签页过滤、判断还算不算「刚刚发生」，以及给人看的一行文案。
 *
 * 单独成模块的原因：假鼠标画在独立覆盖窗里（见 electron/browser-overlay.cjs），
 * 面板只负责文字提示，两边都需要同样的判断规则；而这些规则恰恰是最容易因
 * 「主进程哪天多广播了一个字段」悄悄坏掉的，必须能在没有画面的环境下用单测钉住。
 *
 * 注意：这里绝不接受动作的正文内容。browser_type 只带坐标和字数 ——
 * 表单里可能是密码，把正文写进广播就意味着写进渲染进程的每一次状态推送。
 */

export type GestureType = 'click' | 'hover' | 'key' | 'wheel' | 'type'

export const GESTURE_TYPES: GestureType[] = ['click', 'hover', 'key', 'wheel', 'type']

/** 动作日志的条数上限：只留最近的，内存与响应式开销都要有界 */
export const GESTURE_LOG_LIMIT = 12

/**
 * 一次动作还算「刚刚发生」的时长。
 * 面板与覆盖层用它决定是否继续显示：挂着一小时前的「已点击」比什么都不标更误导。
 */
export const GESTURE_FRESH_MS = 2500

/** 主进程广播的原始载荷（字段都可能缺失或类型不对，一律当不可信处理） */
export interface RawGesture {
  tabId?: string | null
  type?: string
  x?: number
  y?: number
  key?: string
  deltaX?: number
  deltaY?: number
  length?: number
  synthetic?: boolean
}

export interface Gesture {
  seq: number
  type: GestureType
  tabId: string
  x: number | null
  y: number | null
  key: string
  deltaX: number
  deltaY: number
  /** 填写动作的字符数（不是内容本身） */
  length: number
  /** true = JS 合成事件（isTrusted=false），界面上要画成示意态 */
  synthetic: boolean
  at: number
}

function finiteRound(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : null
}

function finiteNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : 0
}

/**
 * 把广播载荷规整成内部结构。
 * 未知类型、缺类型、seq 非法时返回 null —— 宁可丢掉一条提示，
 * 也不要在界面上画出一个含义不明的箭头。
 */
export function normalizeGesture(raw: RawGesture | null | undefined, seq: number, now = Date.now()): Gesture | null {
  if (!raw || typeof raw !== 'object') return null
  const type = String(raw.type || '') as GestureType
  if (!GESTURE_TYPES.includes(type)) return null
  if (!Number.isFinite(seq)) return null
  return {
    seq,
    type,
    tabId: raw.tabId == null ? '' : String(raw.tabId),
    x: finiteRound(raw.x),
    y: finiteRound(raw.y),
    key: typeof raw.key === 'string' ? raw.key : '',
    deltaX: finiteNumber(raw.deltaX),
    deltaY: finiteNumber(raw.deltaY),
    length: Math.max(0, finiteNumber(raw.length)),
    synthetic: raw.synthetic === true,
    at: now
  }
}

/**
 * 把页面视口坐标钳进当前可视区。
 * 坐标来自动作那一刻的页面，而画面可能在动作之后就缩了水（拖窄面板、换标签页），
 * 不钳的话假鼠标会飘到覆盖层外面，看起来像「Agent 点了个不存在的地方」。
 *
 * 视口尺寸本身不可信时不钳：硬钳到 (0, 0) 等于编造一个「页面左上角」的位置，
 * 不如按原坐标报出去（覆盖层自己画不下也就少几个像素）。
 */
export function clampToViewport(g: Gesture, viewport: { width: number; height: number } | null | undefined): { x: number; y: number } | null {
  if (g.x === null || g.y === null) return null
  const width = Number(viewport?.width)
  const height = Number(viewport?.height)
  if (!(width >= 1) || !(height >= 1)) return { x: g.x, y: g.y }
  return {
    x: Math.max(0, Math.min(Math.round(width) - 1, g.x)),
    y: Math.max(0, Math.min(Math.round(height) - 1, g.y))
  }
}

/** 是否还该在界面上提示这次动作 */
export function isFresh(g: Gesture | null | undefined, now = Date.now(), ttl = GESTURE_FRESH_MS): boolean {
  if (!g) return false
  return now - g.at <= ttl
}

/**
 * 那块矩形显示的是活动标签页，所以只有活动标签页的动作才算数。
 * 没有 tabId 的载荷按活动页处理（主进程现在一定会带，留这条是给未来的宽容）。
 */
export function belongsToTab(g: Gesture, activeTabId: string): boolean {
  if (!activeTabId) return false
  if (!g.tabId) return true
  return g.tabId === activeTabId
}

/** 追加一条并维持上限（返回新数组，方便 Vue 的响应式察觉变化） */
export function pushGesture(log: Gesture[], g: Gesture, limit = GESTURE_LOG_LIMIT): Gesture[] {
  const next = [...log, g]
  return next.length > limit ? next.slice(next.length - limit) : next
}

/** 取列表中某个 seq 之后的新动作（面板逐条消费，避免同帧内多条动作只画出最后一条） */
export function gesturesSince(log: Gesture[], sinceSeq: number): Gesture[] {
  return log.filter(g => g.seq > sinceSeq)
}

/** 最近一条仍然新鲜、且属于当前活动标签页的动作；没有则 null */
export function latestVisibleGesture(log: Gesture[], activeTabId: string, now = Date.now(), ttl = GESTURE_FRESH_MS): Gesture | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const g = log[i]
    if (!belongsToTab(g, activeTabId)) continue
    if (!isFresh(g, now, ttl)) continue
    return g
  }
  return null
}

function scrollText(g: Gesture): string {
  const horizontal = Math.abs(g.deltaX) > Math.abs(g.deltaY)
  const amount = Math.abs(horizontal ? g.deltaX : g.deltaY)
  const dir = horizontal ? (g.deltaX > 0 ? '向右' : '向左') : (g.deltaY > 0 ? '向下' : '向上')
  return amount ? `${dir}滚动 ${amount}px` : `${dir}滚动`
}

/**
 * 一行人类可读的动作描述（面板状态条与无障碍提示共用）。
 * 覆盖层的文案由它自己维护（那是 OS 级窗口，读不到这里的 i18n），
 * 但两边的语义必须一致：合成事件一律标成「示意」，不让人误以为页面收到了真事件。
 */
export function gestureLabel(g: Gesture): string {
  const point = g.x !== null && g.y !== null ? ` (${g.x}, ${g.y})` : ''
  let text: string
  switch (g.type) {
    case 'click':
      text = `点击${point}`
      break
    case 'hover':
      text = `悬停${point}`
      break
    case 'type':
      // 只有字数：正文可能就在密码框里
      text = g.length ? `已填写 ${g.length} 字${point}` : `已填写${point}`
      break
    case 'key':
      text = `按下 ${g.key || '键'}`
      break
    case 'wheel':
      text = scrollText(g)
      break
    default:
      text = String(g.type)
  }
  return g.synthetic ? `${text}（示意·合成事件）` : text
}
