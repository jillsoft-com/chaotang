'use strict'
/**
 * 浏览器宿主的纯规则层
 *
 * 这里只放「不依赖 Electron API 的判定逻辑」：域名放行、点击坐标换算、
 * AX 树扁平化、可见性分级等。拆出来的原因是这些判断是整个内嵌浏览器最容易
 * 出错的部分，而它们完全可以在 Node 里直接单测，不需要起 Electron。
 *
 * 约束：本文件禁止 require('electron')，禁止任何 IO。
 */

const { URL } = require('url')

/** 允许面板透传的按键名（其余一律拒绝，避免把任意键盘事件塞进页面） */
const ALLOWED_KEYS = new Set([
  'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'
])

/** CDP 输入事件需要的键码映射 */
const KEY_CODE_TABLE = {
  Enter: { windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', text: '\r' },
  Escape: { windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' },
  Tab: { windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab', text: '\t' },
  Backspace: { windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' },
  Delete: { windowsVirtualKeyCode: 46, code: 'Delete', key: 'Delete' },
  Space: { windowsVirtualKeyCode: 32, code: 'Space', key: ' ', text: ' ' },
  ArrowUp: { windowsVirtualKeyCode: 38, code: 'ArrowUp', key: 'ArrowUp' },
  ArrowDown: { windowsVirtualKeyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
  ArrowLeft: { windowsVirtualKeyCode: 37, code: 'ArrowLeft', key: 'ArrowLeft' },
  ArrowRight: { windowsVirtualKeyCode: 39, code: 'ArrowRight', key: 'ArrowRight' },
  Home: { windowsVirtualKeyCode: 36, code: 'Home', key: 'Home' },
  End: { windowsVirtualKeyCode: 35, code: 'End', key: 'End' },
  PageUp: { windowsVirtualKeyCode: 33, code: 'PageUp', key: 'PageUp' },
  PageDown: { windowsVirtualKeyCode: 34, code: 'PageDown', key: 'PageDown' }
}

/** 视口允许的尺寸区间（沿用旧 Playwright 契约，避免面板逻辑改动） */
const VIEWPORT_MIN = { width: 320, height: 240 }
const VIEWPORT_MAX = { width: 3840, height: 2160 }

/** 返回给模型的文本次数上限（沿用旧契约里的两个截断长度） */
const MAX_EVAL_TEXT = 10000
const MAX_TREE_TEXT = 20000

/** 把白名单条目、URL、任意字符串统一洗成裸主机名 */
function normalizeHost(raw) {
  return String(raw === undefined || raw === null ? '' : raw)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
}

/** 从 URL 取主机名，非法 URL 返回空串 */
function hostOf(targetUrl) {
  try {
    return new URL(targetUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 域名是否放行：白名单未开启时一律放行；开启后精确匹配或子域匹配
 * （example.com 放行 a.example.com，但不放行 notexample.com）
 */
function hostMatchesPolicy(targetUrl, policy) {
  if (!policy || !policy.allowlistEnabled) return true
  const host = hostOf(targetUrl)
  if (!host) return false
  const patterns = Array.isArray(policy.allowlist) ? policy.allowlist : []
  return patterns.some((raw) => {
    const p = normalizeHost(raw)
    if (!p) return false
    return host === p || host.endsWith('.' + p)
  })
}

/** 只允许 http/https 协议进入内嵌浏览器 */
function isHttpUrl(targetUrl) {
  const s = String(targetUrl || '')
  return s.startsWith('http://') || s.startsWith('https://')
}

/** evaluate 表达式的禁止 API 检查（沿用旧实现的口径） */
function containsForbiddenApi(expression) {
  return /\brequire\b|\bimport\b|\bprocess\b|\bglobal\b/i.test(String(expression || ''))
}

/** 视口尺寸校验；返回归一化后的整数尺寸 */
function clampViewportSize(width, height) {
  const w = Math.round(Number(width) || 0)
  const h = Math.round(Number(height) || 0)
  if (w < VIEWPORT_MIN.width || w > VIEWPORT_MAX.width || h < VIEWPORT_MIN.height || h > VIEWPORT_MAX.height) {
    return { ok: false, error: '视口尺寸超出允许范围', width: w, height: h }
  }
  return { ok: true, width: w, height: h }
}

/**
 * 元素矩形 → 点击坐标
 *
 * 关键事实：getBoundingClientRect() 与 Input.dispatchMouseEvent 用的都是
 * 「视口相对的 CSS 像素」，所以这里不需要做任何 DPR 换算 —— 换算反而会点偏。
 */
function clickPointFromRect(rect) {
  const x = Number(rect && rect.x)
  const y = Number(rect && rect.y)
  const width = Number(rect && rect.width)
  const height = Number(rect && rect.height)
  if (![x, y, width, height].every(Number.isFinite)) {
    return { ok: false, error: 'INVALID_RECT: 无法取得元素几何信息' }
  }
  if (width <= 0 || height <= 0) {
    return { ok: false, error: 'ELEMENT_NOT_VISIBLE: 元素尺寸为 0，可能未显示或被隐藏' }
  }
  return { ok: true, x: Math.round(x + width / 2), y: Math.round(y + height / 2) }
}

/**
 * 点击坐标是否落在视口内
 * 越界说明元素在视口外（scrollIntoView 没生效或被 sticky 遮挡），
 * 直接发事件会打到别处，所以要先拦下来。
 */
function isPointInViewport(point, viewport) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false
  const w = Number(viewport && viewport.width) || 0
  const h = Number(viewport && viewport.height) || 0
  return point.x >= 0 && point.y >= 0 && point.x <= w && point.y <= h
}

/**
 * CDP AX 树 → 缩进文本
 *
 * getFullAXTree 返回的是扁平节点数组：role/name 是 {value} 包装，
 * 父子关系靠 childIds/parentId。ignored 节点不输出，但要把子节点提到同一层，
 * 否则层级会随被忽略的容器漂移。
 */
function flattenAxTree(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return ''
  const byId = new Map()
  for (const node of nodes) {
    if (node && typeof node.nodeId === 'string') byId.set(node.nodeId, node)
  }
  const readValue = (box) => (box && typeof box === 'object' ? String(box.value ?? '') : '')
  const lines = []
  const seen = new Set()

  const walk = (node, depth) => {
    if (!node || seen.has(node.nodeId)) return
    seen.add(node.nodeId)
    const role = readValue(node.role)
    const name = readValue(node.name)
    const visible = !node.ignored && !!role && !!name
    if (visible) lines.push(`${'  '.repeat(depth)}[${role}] ${name}`)
    const nextDepth = visible ? depth + 1 : depth
    for (const childId of Array.isArray(node.childIds) ? node.childIds : []) {
      walk(byId.get(childId), nextDepth)
    }
  }

  for (const node of nodes) if (node && !node.parentId) walk(node, 0)
  return lines.join('\n')
}

/** 截断长文本，并告诉调用方是否被截 */
function limitText(text, max) {
  const s = String(text || '')
  const limit = max || MAX_TREE_TEXT
  return { text: s.slice(0, limit), truncated: s.length > limit }
}

/**
 * 页面能力分级（真事件矩阵探针实测结论的工程化）
 *
 * 以前这里只输出一个 canCapture，输入动作拿它当门槛，于是「拿不到画面」被等同于
 * 「真事件送不进去」。矩阵探针（只信页面里收到的事件，不信 CDP 命令的返回值）测出来
 * 这五件事的失效边界各不相同：
 *
 *   能力        未挂载   挂载但窗口最小化/隐藏   离屏且已挂载   挂载且可见
 *   canKey        ✔             ✔                   ✔            ✔
 *   canWheel      ✘             ✔                   ✔            ✔
 *   canClick      ✘             ✘                   ✘            ✔
 *   canCapture    ✘             仅离屏 ✔            ✔             ✔
 *
 * 逐条说明：
 * - 键盘（Input.dispatchKeyEvent）对合成层没有任何要求，摘掉 view、窗口最小化都照样送进页面。
 *   以前把它跟着画面一起降级成 JS 合成事件，是明确的误报：页面收到的是真按键，模型却被告知不可信。
 * - 滚轮只要 view 还挂在窗口上就生效，与可见性无关（尺寸得是真的，0 面积没有命中目标）。
 * - 鼠标按下/抬起最娇气：未挂载、窗口最小化、窗口被藏起来，三种情况都会让它进到队列但不进页面。
 * - 截图分两层：常规视图必须「挂载 + 窗口可见 + 有尺寸」才进合成层；离屏视图（offscreen）
 *   只要还挂在窗口上就能出帧，哪怕那个窗口从没显示过、哪怕别的应用窗口正被最小化。
 *
 * 一个尚未消化完的线索：进程里任意一个窗口被最小化或隐藏，会连累其它窗口里视图的鼠标按钮事件
 * （ghost 宿主自己从未显示不算，它带着 offscreen 时截图也照常出帧）。本轮只按宿主窗口自身状态判定，
 * 离屏后台通道真正落地时必须把这条全局影响一起纳入。
 *
 * @param state.mounted      view 当前挂在窗口上（面板收起时为 false）
 * @param state.offscreen    view 以离屏方式创建
 * @param state.windowVisible 宿主窗口 isVisible()
 * @param state.minimized     宿主窗口 isMinimized()
 * @param state.everShown     宿主窗口显示过（默认 true；从未显示的 ghost 宿主传 false）
 * @param state.width / state.height  浏览器区域尺寸
 */
function resolveCapability(state) {
  const mounted = !!state.mounted
  const offscreen = !!state.offscreen
  const minimized = !!state.minimized
  const everShown = state.everShown !== false
  const windowVisible = state.windowVisible !== false
  const width = Number(state.width) || 0
  const height = Number(state.height) || 0
  const sized = width >= 2 && height >= 2
  // 「显示过又被藏起来」才抑制鼠标事件；从未显示的窗口不算被藏
  const occluded = minimized || (everShown && !windowVisible)

  const canKey = true
  const canWheel = mounted && sized
  const canClick = mounted && sized && !occluded
  const canCapture = mounted && sized && (offscreen || !occluded)

  let level = 'visible'
  if (!mounted) level = 'detached'
  else if (minimized) level = 'minimized'
  else if (occluded) level = 'hidden'
  else if (!sized) level = 'zero-size'

  const reasons = {
    detached: { reason: '浏览器面板当前没有显示在界面上', hint: '文字类操作可继续；需要画面时面板会自动唤起，或请用户切到浏览器标签页' },
    minimized: { reason: '应用窗口已最小化', hint: '最小化时取不到画面、鼠标点击也不生效；键盘与滚动仍可用' },
    hidden: { reason: '应用窗口当前不可见', hint: '取不到画面、鼠标点击也不生效；键盘与滚动仍可用' },
    'zero-size': { reason: '浏览器区域尺寸为 0', hint: '面板被折叠了，请展开浏览器区域' },
    visible: { reason: '', hint: '' }
  }
  const why = reasons[level]

  return {
    level,
    canCapture,
    canClick,
    canWheel,
    canKey,
    // 取数与执行 JS 只依赖 webContents 存活，摘掉 view、最小化都能用（探针实测 dom 始终可读）
    canDom: true,
    reason: why.reason,
    hint: why.hint,
    /** 各能力各自的不通理由，给退化路径写出准确的话，而不是一律说「拿不到画面」 */
    captureHint: canCapture ? '' : why.reason || '当前取不到画面',
    clickHint: canClick ? '' : (why.reason || '鼠标点击当前不会送达页面'),
    wheelHint: canWheel ? '' : (why.reason || '滚轮事件当前不会送达页面')
  }
}

/** 旧名字保留：调用方只关心「这位到底行不行」，不关心它叫什么 */
const resolveVisibility = resolveCapability

/** 从 CDP target 列表里挑出跨域 iframe（用于 OOPIF 取数） */
function pickIframeTarget(targetInfos, urlPart) {
  const infos = Array.isArray(targetInfos) ? targetInfos : []
  const needle = String(urlPart || '').toLowerCase()
  return infos.find((info) =>
    info && info.type === 'iframe' &&
    String(info.url || '').toLowerCase().includes(needle)
  ) || null
}

// ============ 安全（M6） ============

/**
 * Client Hints 的品牌列表里那个“填充用”假品牌。
 * 真实 Chrome 120 发的是 "Not_A Brand";v="8"，照抄而不是自创 —— 自创一个品牌名本身就是指纹。
 */
const NOT_BRAND = 'Not_A Brand'

/** 各平台的 uaPlatform / 高熵值（同样照抄真实 Chrome 的写法） */
const PLATFORM_HINTS = {
  win32: { uaPlatform: 'Windows', platformVersion: '10.0.0' },
  darwin: { uaPlatform: 'macOS', platformVersion: '14.5.0' },
  linux: { uaPlatform: 'Linux', platformVersion: '' }
}

/** 把任意版本串整成四段点分形式，拿不准时退回一个真实的 Chrome 120 版本号 */
function normalizeVersion(raw) {
  const parts = String(raw || '').split('.').map(p => (/^\d+$/.test(p) ? p : '0'))
  while (parts.length && parts[0] === '0') parts.shift()
  if (!parts.length || !Number.isFinite(Number(parts[0]))) return '120.0.6099.109'
  while (parts.length < 4) parts.push('0')
  return parts.slice(0, 4).join('.')
}

/** 按真实 Chrome 的 UA 模板拼一个干净的 UA（只依赖传进来的版本与平台，不读 process） */
function buildUserAgent(chromeVersion, platform) {
  const full = normalizeVersion(chromeVersion)
  const tokens = {
    win32: 'Windows NT 10.0; Win64; x64',
    darwin: 'Macintosh; Intel Mac OS X 10_15_7',
    linux: 'X11; Linux x86_64'
  }
  const os = tokens[platform] || tokens.linux
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`
}

/**
 * 组装 UA 与 Client Hints 的覆盖值。
 *
 * 为什么不能只改 UA 字符串：Chromium 会另外发 sec-ch-ua / sec-ch-ua-platform 请求头，
 * 并把品牌列表暴露给 navigator.userAgentData。严格的风控站点两头一对照就发现“UA 说是 Chrome，
 * 品牌列表里藏着 Electron”。所以必须 UA 字符串、请求头、userAgentData 三处一起改。
 *
 * @param opts.chromeVersion Electron 自带的 Chromium 版本（process.versions.chrome）
 * @param opts.platform      process.platform 原值（win32/darwin/linux）
 * @param opts.arch          process.arch（x64/arm64…），只用来决定 architecture 字段
 * @param opts.acceptLanguage 语言串，缺省 zh-CN,zh,en-US,en
 * @param opts.userAgent     已经算好的 UA；不传则按版本自己拼
 */
function buildClientHints(opts = {}) {
  const fullVersion = normalizeVersion(opts.chromeVersion)
  const major = fullVersion.split('.')[0]
  const brands = [
    { brand: NOT_BRAND, version: '8' },
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major }
  ]
  const plat = PLATFORM_HINTS[opts.platform] || PLATFORM_HINTS.linux
  const acceptLanguage = String(opts.acceptLanguage || 'zh-CN,zh,en-US,en')
  const userAgent = String(opts.userAgent || buildUserAgent(fullVersion, opts.platform))
  const architecture = String(opts.arch || '').includes('arm') ? 'arm' : 'x86'
  const headerList = brands.map(b => `"${b.brand}";v="${b.version}"`).join(', ')
  return {
    userAgent,
    acceptLanguage,
    /** 给 CDP Network.setUserAgentOverride 的 userAgentMetadata：管 navigator.userAgentData */
    metadata: {
      brands,
      fullVersionList: brands.map(b => ({ brand: b.brand, version: b.brand === NOT_BRAND ? '8.0.0.0' : fullVersion })),
      fullVersion,
      platform: plat.uaPlatform,
      platformVersion: plat.platformVersion,
      architecture,
      bitness: '64',
      model: '',
      platformLanguage: acceptLanguage.split(',')[0].split('-')[0] === 'zh' ? 'zh' : acceptLanguage.split(',')[0],
      mobile: false
    },
    /** 给 webRequest.onBeforeSendHeaders 的写法：只覆盖已经存在的头，不要无中生有 */
    headers: {
      'sec-ch-ua': headerList,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': `"${plat.uaPlatform}"`,
      'user-agent': userAgent
    }
  }
}

/**
 * 改写请求头：只替换已有的 Client Hints，原本没带的不要添上。
 * 无中生有地多一个 sec-ch-ua 头，本身就是自动化痕迹。
 * 遍历时用的是请求头原本的键名，所以大小写不同（Sec-CH-UA）也能命中。
 */
function applyClientHintHeaders(requestHeaders, hints) {
  const out = {}
  let changed = false
  for (const [name, value] of Object.entries(requestHeaders || {})) {
    const lower = String(name).toLowerCase()
    if (hints && hints.headers && lower in hints.headers) {
      out[name] = hints.headers[lower]
      changed = true
    } else {
      out[name] = value
    }
  }
  return { headers: out, changed }
}

/**
 * 顶层导航是否允许。
 * 白名单未开启时也必须挡住非 http(s)：页面里一句 location='mailto:…' 或 file: 就能把内嵌
 * 浏览器变成打开本地文件/外部程序的跳板，这与白名单是两个独立的开关。
 */
function navigationAllowed(targetUrl, policy) {
  if (!isHttpUrl(targetUrl)) {
    return { ok: false, reason: '仅允许 http/https 协议导航', kind: 'protocol' }
  }
  if (!hostMatchesPolicy(targetUrl, policy)) {
    return { ok: false, reason: `${hostOf(targetUrl) || targetUrl} 不在允许的域名白名单内`, kind: 'allowlist' }
  }
  return { ok: true, reason: '', kind: '' }
}

/**
 * 白名单开启后额外需要拦住的请求类型。
 *
 * 分寸把握在这里：子框架（iframe 跳转）会把白名单外的整张页面嵌进来，必须拦；
 * 图片/脚本/样式不动，否则大半个互联网都渲染不出来。
 * 严格模式再把 XHR/WebSocket 这些能长期往外送数据的通道也纳进来（默认关）。
 *
 * 类型名用的是 Electron 的口径（实测：主框架 mainFrame、iframe subFrame、
 * XHR/fetch xhr、WebSocket webSocket、sendBeacon ping），不是 webRequest 规范里
 * 那套小写下划线名。Electron 没有 fetch/eventsource/beacon 这几个枚举值，
 * 它们会被归到 xhr 或 other；多写几个规范名是当各版本 Electron 改了映射时仍然拦得住。
 */
const STRICT_REQUEST_TYPES = [
  'xhr', 'webSocket', 'ping', 'cspReport', 'other',
  'xmlhttprequest', 'websocket', 'eventsource', 'beacon', 'fetch'
]

function blockedRequestTypes(policy) {
  if (!policy || !policy.allowlistEnabled) return []
  return ['subFrame'].concat(policy.strictAllowlist ? STRICT_REQUEST_TYPES : [])
}

/**
 * 这次请求是否应该被取消。
 * @param opts.mainFrameUrl 发起导航的顶层页地址（host 传进来，rules 不读 Electron）
 */
function requestBlocked(details, policy, opts = {}) {
  if (!policy || !policy.allowlistEnabled) return false
  const types = blockedRequestTypes(policy)
  if (!types.length || !details) return false
  if (!types.includes(details.resourceType)) return false
  const target = String(details.url || '')
  const isSocket = details.resourceType === 'webSocket' || details.resourceType === 'websocket'
  // WebSocket 的地址不是 http(s) 开头，不能跟“不会离机的本地资源”一起放过去；
  // 子框架的 data: 能带整张页（表单与脚本），也一样要判；
  // 剩下的 blob:/data: 都是页内资源，拦了只会把正常页面弄瘫
  if (!isHttpUrl(target) && !isSocket) return details.resourceType === 'subFrame'
  // 顶层页自己发起的同源 XHR/fetch/WebSocket 不算“跳出白名单”：拦了页面就瘫了
  const origin = hostOf(opts.mainFrameUrl)
  if (origin && details.resourceType !== 'subFrame' && hostOf(target) === origin) return false
  return !hostMatchesPolicy(target, policy)
}

/**
 * 应用自己的控制面动作：安全策略、接管锁、面板区域、前台/视口。
 * 这些不是“对页面动手”，而是“改工具自身的规则”，只能由用户通过界面改。
 * 模型手里没有这几个工具，拦下它们是防“绕过工具层直接递 IPC”与将来误接：
 * 一个能改 set-policy 的模型等于自己拆了白名单，能改 set-hold 等于自己把用户的接管锁取消。
 */
const CONTROL_PLANE_ACTIONS = new Set([
  'set-policy', 'set-hold', 'set-auto-raise', 'viewport', 'detach', 'attach', 'set-bounds'
])

/** Agent 调用控制面动作时的拒接理由（用户不受限制，面板自己就在用它们） */
function controlPlaneRefused(action) {
  if (!CONTROL_PLANE_ACTIONS.has(String(action || ''))) return null
  return {
    error: 'SECURITY_CONTROL: 白名单与接管锁只能由用户在界面上改动',
    hint: '请用户到「设置 → 浏览器安全」调整白名单，或在浏览器面板按「接管」；不要尝试自己改策略'
  }
}

/**
 * 用户接管期间 Agent 仍然允许的动作：只读页面，不碰页面也不抢用户的视图。
 * （控制面动作不会走到这里，已经在 controlPlaneRefused 那一层按 actor 拦掉了）
 */
const HOLD_ALLOWED_ACTIONS = new Set([
  'state', 'tab-list', 'snapshot', 'query', 'evaluate', 'frame-evaluate', 'screenshot'
])

/** 接管期间某个动作该不该执行 */
function holdDecision(action) {
  if (HOLD_ALLOWED_ACTIONS.has(String(action || ''))) return { allowed: true, error: '', hint: '' }
  return {
    allowed: false,
    error: 'MANUAL_HOLD: 用户已接管页面，Agent 的写操作已暂停',
    hint: '取数类动作（browser_snapshot / browser_query / browser_evaluate）仍可用；'
      + '请等用户在浏览器面板退出「接管」后再继续'
  }
}

/**
 * 哪些动作算“有人在亲自动手开车”。
 * 面板（用户）做出这些动作时主进程顺手上锁，让 Agent 等一下；
 * Agent 自己发同样的动作不会上锁，否则会把自己锁死。
 */
const USER_DRIVING_ACTIONS = new Set([
  'click', 'mouse-click', 'type', 'keyboard', 'hover', 'scroll', 'mouse-wheel',
  'navigate', 'reload', 'back', 'forward', 'stop'
])

function isUserDrivingAction(action) {
  return USER_DRIVING_ACTIONS.has(String(action || ''))
}

/**
 * 这个输入事件算不算“用户亲自动手了”。
 *
 * 只认 keyDown：keyUp/char 会把一次按键数成好几条；isAutoRepeat 是按住不放，
 * 不是新的接管意图。Agent 自己灌的 CDP Input.* 不经过这条路径，
 * 但仍加一层时间窗口守卫（withinCdpWindow）：万一哪天 Electron 改了派发链路，
 * 宁可不上锁，也不能让 Agent 把自己锁死。
 */
function isUserInputEvent(input, opts = {}) {
  if (!input || opts.withinCdpWindow) return false
  if (input.isAutoRepeat) return false
  return input.type === 'keyDown' || input.type === 'mouseDown'
}

module.exports = {
  ALLOWED_KEYS,
  KEY_CODE_TABLE,
  VIEWPORT_MIN,
  VIEWPORT_MAX,
  MAX_EVAL_TEXT,
  MAX_TREE_TEXT,
  NOT_BRAND,
  HOLD_ALLOWED_ACTIONS,
  CONTROL_PLANE_ACTIONS,
  normalizeHost,
  hostOf,
  hostMatchesPolicy,
  isHttpUrl,
  containsForbiddenApi,
  clampViewportSize,
  clickPointFromRect,
  isPointInViewport,
  flattenAxTree,
  limitText,
  resolveCapability,
  resolveVisibility,
  pickIframeTarget,
  normalizeVersion,
  buildUserAgent,
  buildClientHints,
  applyClientHintHeaders,
  navigationAllowed,
  blockedRequestTypes,
  requestBlocked,
  holdDecision,
  controlPlaneRefused,
  isUserDrivingAction,
  isUserInputEvent
}
