/**
 * 内嵌浏览器宿主会话（渲染进程侧）
 *
 * 与 browser-session.ts 的分工：
 * - 本模块是宿主那一侧的真相镜像：真实页面直接画在面板区域上，渲染进程不搬运像素，
 *   职责是两件事 —— 把占位区的矩形报给主进程，以及把主进程推来的状态与事件落成响应式数据；
 * - browser-session 只留人机共用的协调量（当前表象、Agent 占用、接管等待）。
 *
 * 坐标约定：BrowserView.setBounds 用的是「窗口内容区」坐标，而内容区恰好就是渲染进程的视口，
 * getBoundingClientRect() 拿到的已经是同一套 DIP 值（本应用从不改缩放级别），因此原样上报，
 * 不需要加减标题栏或菜单栏的偏移。
 *
 * 事件监听挂在本模块而不是面板组件上，原因见 ensureHostListeners 的注释。
 */

import { reactive } from 'vue'
import { browserView, type ViewportSize } from './browser-session'
import type { BrowserActor } from './browser-manager'
import { normalizeGesture, pushGesture, type Gesture } from './browser-gesture'

/** 区域上报的最小变化量：小于它的抖动不值得一次 IPC */
const BOUNDS_MIN_DELTA = 2
/** 拖拽把手时 ResizeObserver 会连发，去抖到一帧之内只报一次 */
const BOUNDS_DEBOUNCE_MS = 60
/** 主进程要求的页面最小尺寸，比它小就当作不可见 */
const SURFACE_MIN_SIZE = 2

export type HostActionName = Parameters<NonNullable<Window['electronAPI']>['browserHostAction']>[0]['action']

export const hostState = reactive({
  /** 宿主通道是否可用（Web 模式与旧安装包为 false） */
  available: false,
  /** 是否已经成功连上过宿主（首次 state 调用之后） */
  connected: false,
  /** 标签页列表，来自主进程的 state/tab-list */
  tabs: [] as BrowserHostTabInfo[],
  /** 当前活动标签页 id */
  activeTabId: '',
  /** 活动页面的地址与标题 */
  url: '',
  title: '',
  /** 是否已经导航到真实页面 */
  active: false,
  canBack: false,
  canForward: false,
  viewport: { width: 1280, height: 720 } as ViewportSize,
  /** 画面可用性：由主进程按「已挂载 + 窗口可见 + 有尺寸」三态判定 */
  visibility: 'detached' as BrowserHostVisibility,
  /**
   * 承载位置（M8-b）：'fg' 前台正常视图；'bg' 面板不可见时住在离屏 ghost 孪生视图里。
   * bg 时即使 visibility 是遮挡态，真点击与截图仍可用，面板据此显示“后台运行中”徽标。
   */
  carrier: 'fg' as 'fg' | 'bg',
  offscreen: false,
  canCapture: false,
  captureHint: '',
  /** 输入侧的三位能力：拿不到画面不等于键盘与滚动也停了 */
  canClick: false,
  canWheel: false,
  canKey: true,
  clickHint: '',
  /** 主进程理解中的面板显隐状态（null = 还没上报过） */
  panelVisible: null as boolean | null,
  /** Agent 需要画面时是否允许自动把浏览器唤到前台 */
  autoRaise: true,
  /** 接管锁（以主进程为准）：面板按钮只是它的入口之一 */
  manualHold: false,
  /** 'panel' / 'user-action' / 'input'：区分“用户按了接管”与“用户只是动了一下手” */
  holdSource: '',
  /** browser-raise 计数：HomeView 监听它把面板切回浏览器标签 */
  raiseSeq: 0,
  /** raise 附带的原因，便于在界面上解释「为什么面板自己弹开了」 */
  raiseReason: '',
  /** 白名单拦截事件（主进程兜住的 JS 跳转，面板不拦不到） */
  blockedSeq: 0,
  blockedUrl: '',
  blockedHost: '',
  /** 拦下的是哪一类：导航 / 子资源请求 / 下载 / 权限申请，面板据此说不一样的话 */
  blockedKind: '',
  /** 这一类里具体被拦的东西：权限名 / 文件名 / 资源类型，只用于文案 */
  blockedDetail: '',
  /**
   * 最近若干条 Agent 动作（M5）。
   * 存列表而不是存「最后一条」：一个步骤里连着发 click + type 时，
   * 单值会被同一轮渲染合并成一次变化，前面的动作就等于没发生。
   */
  gestures: [] as Gesture[],
  /** 最新一条动作的序号（面板用它判断有没有新东西要消费） */
  gestureSeq: 0,
  /** 最近一次失败原因 */
  lastError: ''
})

function hasHostChannel(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.browserHostAction
}

/** 内嵌宿主是否可用（供组件在 setup 阶段一次性判定，Web 模式下面板会退回提示文案） */
export function isHostAvailable(): boolean {
  hostState.available = hasHostChannel()
  return hostState.available
}

/**
 * 把主进程返回的状态字段并入本地镜像。
 * 只认存在的字段：动作返回值是 state 的子集（比如 back 只回 url/title），
 * 缺字段时不能把已有值抹成 undefined。
 */
function absorb(res: any): void {
  if (!res || typeof res !== 'object') return
  if (typeof res.url === 'string') hostState.url = res.url
  if (typeof res.title === 'string') hostState.title = res.title
  if (typeof res.active === 'boolean') hostState.active = res.active
  if (typeof res.canBack === 'boolean') hostState.canBack = res.canBack
  if (typeof res.canForward === 'boolean') hostState.canForward = res.canForward
  if (typeof res.visibility === 'string') hostState.visibility = res.visibility as BrowserHostVisibility
  if (res.carrier === 'fg' || res.carrier === 'bg') hostState.carrier = res.carrier
  if (typeof res.offscreen === 'boolean') hostState.offscreen = res.offscreen
  if (typeof res.canCapture === 'boolean') hostState.canCapture = res.canCapture
  if (typeof res.captureHint === 'string') hostState.captureHint = res.captureHint
  if (typeof res.canClick === 'boolean') hostState.canClick = res.canClick
  if (typeof res.canWheel === 'boolean') hostState.canWheel = res.canWheel
  if (typeof res.canKey === 'boolean') hostState.canKey = res.canKey
  if (typeof res.clickHint === 'string') hostState.clickHint = res.clickHint
  if (typeof res.panelVisible === 'boolean' || res.panelVisible === null) {
    hostState.panelVisible = res.panelVisible
  }
  if (typeof res.autoRaise === 'boolean') hostState.autoRaise = res.autoRaise
  if (typeof res.manualHold === 'boolean') hostState.manualHold = res.manualHold
  if (typeof res.holdSource === 'string') hostState.holdSource = res.holdSource
  if (res.tabId === null || typeof res.tabId === 'string') hostState.activeTabId = res.tabId || ''
  if (Array.isArray(res.tabs)) hostState.tabs = res.tabs
  const vp = res.viewport
  if (vp && typeof vp.width === 'number' && typeof vp.height === 'number') {
    hostState.viewport = { width: vp.width, height: vp.height }
  }
  hostState.connected = true
  mirrorToSharedView()
}

/**
 * 同步一份到 browser-session 的共享状态里。
 * 为什么要镜像而不是让所有调用方都改读 hostState：
 * HomeView 的标签标题联动、Agent 占用徽标、接管开关都建立在 browserView 之上，
 * 两条代码路径得共用同一份「用户看得见的那个页面」的表象。
 */
function mirrorToSharedView(): void {
  browserView.url = hostState.url
  browserView.title = hostState.title
  browserView.active = hostState.active
  browserView.viewport = { ...hostState.viewport }
  // 接管锁归主进程：用户的真实操作、面板按钮、退出接管都会推到这里，
  // Agent 侧的 awaitManualRelease 读的仍是 browserView.manualHold
  browserView.manualHold = hostState.manualHold
}

/**
 * 执行宿主动作。宿主不可用时明确报错，绝不静默退回别的路径。
 * actor 缺省 'user'：面板、控制面与回归脚本都是“人在操作”，只有 Agent 工具会显式带 'agent'。
 */
export async function hostAction(
  action: HostActionName,
  params: Record<string, any> = {},
  opts: { actor?: BrowserActor } = {}
): Promise<BrowserHostResult> {
  const api = window.electronAPI
  if (!api?.browserHostAction) {
    const error = '内嵌浏览器宿主通道不可用，请重启应用（旧版安装包不携带该通道）'
    hostState.lastError = error
    return { success: false, error }
  }
  try {
    const res = await api.browserHostAction({ action, params, actor: opts.actor || 'user' })
    if (res && typeof res === 'object') {
      absorb(res)
      hostState.lastError = res.success ? '' : (res.error || '浏览器操作失败')
    }
    return res
  } catch (e: any) {
    const error = e?.message || String(e)
    hostState.lastError = error
    return { success: false, error }
  }
}

/** 没有标签页时开一个空白页；返回结果里已带 tabs */
export async function ensureFirstTab(): Promise<BrowserHostResult> {
  if (hostState.tabs.length) return { success: true }
  return await hostAction('tab-open', {})
}

export async function openTab(url?: string): Promise<BrowserHostResult> {
  return await hostAction('tab-open', url ? { url } : {})
}

export async function selectTab(tabId: string): Promise<BrowserHostResult> {
  return await hostAction('tab-select', { tabId })
}

export async function closeTab(tabId: string): Promise<BrowserHostResult> {
  return await hostAction('tab-close', { tabId })
}

/** Agent 需要画面时是否允许自动唤前 */
export async function setAutoRaise(enabled: boolean): Promise<BrowserHostResult> {
  const res = await hostAction('set-auto-raise', { enabled })
  if (res.success) hostState.autoRaise = enabled
  return res
}

/**
 * 开关接管锁（M6）。
 * on 缺省时取反，与主进程 set-hold 的行为一致；返回体里带最新的锁状态，
 * absorb 会把它镜像进 hostState/browserView，面板不需要自己再改一遍。
 */
export async function setHold(on?: boolean): Promise<BrowserHostResult> {
  return await hostAction('set-hold', on === undefined ? {} : { on })
}

// ============ 区域上报 ============

let lastReport: { x: number; y: number; width: number; height: number } | null = null
/** 界面上是不是真的占着一块区域：保证 detach 只在需要时发一次 */
let surfaceMounted = false

function sameReport(a: { x: number; y: number; width: number; height: number }): boolean {
  if (!lastReport) return false
  return Math.abs(a.x - lastReport.x) < BOUNDS_MIN_DELTA
    && Math.abs(a.y - lastReport.y) < BOUNDS_MIN_DELTA
    && Math.abs(a.width - lastReport.width) < BOUNDS_MIN_DELTA
    && Math.abs(a.height - lastReport.height) < BOUNDS_MIN_DELTA
}

/**
 * 把占位区当前矩形报给主进程。
 *
 * force 的用处：新建标签页、切回浏览器标签这类「尺寸没变但页面变了」的场合。
 * 主进程的 set-bounds 只在「没有挂载任何页面」或 force 时挂载，
 * 而 navigate 自动建标签时并不挂载（见 browser-host.cjs 的 navigate），
 * 所以尺寸未变的重新显示必须靠 force 才能把页面画上来了。
 */
export async function syncSurface(
  el: HTMLElement | null,
  opts: { force?: boolean } = {}
): Promise<boolean> {
  if (!el || !hasHostChannel()) return false
  const rect = el.getBoundingClientRect()
  const box = {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  }
  // 占位区被折叠成 0 尺寸时不能报 bounds（主进程会拒收），改按收起处理
  if (box.width < SURFACE_MIN_SIZE || box.height < SURFACE_MIN_SIZE) {
    await releaseSurface()
    return false
  }
  if (!opts.force && sameReport(box)) return true
  const res = await hostAction('set-bounds', { ...box, force: opts.force === true })
  if (res.success) {
    lastReport = box
    surfaceMounted = true
  }
  return res.success === true
}

/**
 * 复位区域上报缓存。
 * 组件全部卸载、回归测试要干净现场时都需要它：
 * lastReport 只反映「上一次成功上报的矩形」，面板真没了它就是错的。
 */
export function resetSurfaceTracking(): void {
  lastReport = null
  surfaceMounted = false
}

/** 面板收起 / 浏览器标签切走：把页面从界面上卸下，但保留内存里的标签页 */
export async function releaseSurface(): Promise<void> {
  if (!hasHostChannel() || !surfaceMounted) return
  lastReport = null
  surfaceMounted = false
  await hostAction('detach', {})
}

/** 关掉整个浏览器实例（所有标签页） */
export async function closeAllTabs(): Promise<BrowserHostResult> {
  lastReport = null
  surfaceMounted = false
  return await hostAction('close', {})
}

/**
 * 跟随占位区尺寸变化。
 * 除了自身尺寸（ResizeObserver 覆盖面板内拖拽），还得覆盖窗口尺寸变化带来的整体位移：
 * 右侧面板贴着窗口右缘，窗口变宽变窄时 x 坐标跟着变，而元素尺寸可能压根没变。
 */
export function observeSurface(el: HTMLElement): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const push = (force = false) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void syncSurface(el, { force })
    }, BOUNDS_DEBOUNCE_MS)
  }
  const onResize = () => push(true)
  let ro: ResizeObserver | null = null
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => push(false))
    ro.observe(el)
  }
  window.addEventListener('resize', onResize)
  return () => {
    if (timer) clearTimeout(timer)
    ro?.disconnect()
    window.removeEventListener('resize', onResize)
  }
}

// ============ 主进程事件 ============

let unsubscribes: Array<() => void> = []
/**
 * 动作序号计数。
 * 放在模块级而不从 hostState.gestureSeq 推：面板重新挂载会清空日志，
 * 但序号必须一路单调递增，否则新动作的 seq 会比面板上记住的 sinceSeq 小，全部被当成旧数据丢掉。
 */
let gestureCounter = 0

/**
 * 订阅宿主推送的事件。
 *
 * 挂在模块级而不是面板组件上，是因为内嵌模式的整个机制就建立在「面板经常不在界面上」：
 * 用户切到文件标签、收起右侧面板时，BrowserPanel 组件会被卸载，但此时 Agent 可能正在
 * 后台操作页面，它发出的 browser-raise 得有人接。所以监听者必须活得比面板久。
 */
export function ensureHostListeners(): void {
  const api = window.electronAPI
  if (!api?.browserHostAction || unsubscribes.length) return

  unsubscribes.push(
    api.onBrowserState((state) => absorb(state)),

    api.onBrowserRaise((data) => {
      hostState.raiseSeq++
      hostState.raiseReason = data?.reason || ''
    }),

    api.onBrowserBlocked((data) => {
      hostState.blockedSeq++
      hostState.blockedUrl = data?.url || ''
      hostState.blockedHost = data?.host || ''
      hostState.blockedKind = data?.kind || 'navigation'
      hostState.blockedDetail = data?.permission || data?.filename || data?.resourceType || ''
    }),

    api.onBrowserTabOpened((data) => {
      // 新标签已由主进程设为活动页，这里只需把界面视角跟上
      if (data?.tabId) hostState.activeTabId = data.tabId
    }),

    // 接管锁变化：用户真的在页面上动手时主进程会自己上锁，面板按钮得跟着变
    api.onBrowserHold((data) => {
      hostState.manualHold = data?.on === true
      hostState.holdSource = data?.source || ''
      mirrorToSharedView()
    }),

    api.onBrowserGesture((data) => {
      // 载荷一律当不可信：字段坏了就丢这一条，不能让一条提示卡住整个面板
      const gesture = normalizeGesture(data, ++gestureCounter)
      if (!gesture) return
      hostState.gestureSeq = gesture.seq
      hostState.gestures = pushGesture(hostState.gestures, gesture)
    })
  )
  hostState.available = true
}

export function disposeHostListeners(): void {
  for (const off of unsubscribes) {
    try { off() } catch { /* 已经断了就不用管 */ }
  }
  unsubscribes = []
}

/** 清空动作日志（回归测试的干净现场）；序号故意不重置，见 gestureCounter 注释 */
export function resetGestureLog(): void {
  hostState.gestures = []
  hostState.gestureSeq = 0
}

/** 面板挂载时恢复现场：只问状态，不拉起页面（state 动作不带 create） */
export async function refreshHostState(): Promise<BrowserHostResult> {
  return await hostAction('state', {})
}
