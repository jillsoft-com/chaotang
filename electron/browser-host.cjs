'use strict'
/**
 * 内嵌浏览器宿主（主进程）
 *
 * 用 Electron 的 BrowserView 承载真实页面，用 webContents.debugger 走 CDP 驱动，
 * 不启 --remote-debugging-port，也不再依赖 Playwright。
 *
 * 四条从探针里换来的铁律，改动前请先读完：
 * 1. debugger.attach 之后要等导航落地再发 Page.enable / Runtime.enable；
 * 2. 绝不能调用 Emulation.setDeviceMetricsOverride —— 一旦调用，
 *    Page.captureScreenshot 会永久静默挂死，clearDeviceMetricsOverride 也救不回来。
 *    改视口只用 BrowserView.setBounds()。
 * 3. 截图只在「已挂载 + 窗口可见 + 有尺寸」时可用，其余情形不报错而是不返回，
 *    所以必须先做可见性判定，再发命令；所有 CDP 调用一律带超时兜底。
 * 4. 四位能力不能合成一个关卡判（矩阵探针实测，边界写在 rules.resolveCapability 里）：
 *    键盘在任何前台状态下都能送达，滚轮只要求挂载且有尺寸，鼠标按下/抬起还要求窗口没被藏起来，
 *    只有截图真正吃合成层。把它们打包成一个 canCapture，会一边误杀能做的动作、
 *    一边把已经生效的动作谎报成不可信事件。
 */

const rules = require('./browser-rules.cjs')

/** 各类调用的超时（毫秒）。CDP 命令没有内建超时，必须自己加。 */
const CDP_TIMEOUT_MS = 5000
const EVAL_TIMEOUT_MS = 10000
const CAPTURE_TIMEOUT_MS = 8000
const NAV_TIMEOUT_MS = 30000
/** 需要画面时，等渲染进程把面板切回来的最长时间 */
const RAISE_WAIT_MS = 1500
/** 刚挂到界面上之后，合成层至少要给这么久才可能产出第一帧 */
const SURFACE_SETTLE_MS = 350
/**
 * 重挂载后等真的过两帧的上限。
 *
 * 只能用 rAF，不能用 document.visibilityState：实测 BrowserView 不管挂在不在前台，
 * visibilityState 都是 hidden，拿它当关卡会把本来能成功的截图全部标成不可用。
 * rAF 那么是真的反映合成层在不在推进：窗口被其它程序完全挡住时它也会停下来，
 * 而那恰好就是 Page.captureScreenshot 一去不回的时刻，所以 painted=false 直接给
 * 可重试的 CAPTURE_UNAVAILABLE 是正确的判定，不是误杀。
 */
const PAINT_FRAME_WAIT_MS = 1500
/** 状态广播节流，避免导航抖动刷屏 */
const STATE_PUSH_MS = 120
/**
 * 用户真实输入检测的守卫窗口。
 *
 * before-input-event 只该看到操作系统派发的输入，Agent 灌的 CDP Input.* 不走这条路。
 * 但万一哪个 Electron 版本改了派发链路，Agent 会把自己锁死：所以只要刚发过 Input.*，
 * 这一小段时间里的输入一律不当接管意图。
 */
const CDP_INPUT_GUARD_MS = 400
/**
 * 用户“动了一下手”之后锁自动放开的时间。
 * 面板上按下的显式接管不受这个限制（要用户自己点回去），因为那是明确意图；
 * 一次误触键盘不能把 Agent 永久钉住。
 */
const HOLD_IDLE_RELEASE_MS = 20000

const PARTITION_PREFIX = 'persist:ct-browser-'
const BLANK = 'about:blank'

/**
 * 离屏后台孪生通道（M8-b）的 ghost 宿主参数。
 *
 * 探针实测（ghost 离屏承载）：一个从未 show 的 BrowserWindow 里挂 offscreen:true 的 BrowserView，
 * 真鼠标点击、键盘、滚轮、Page.captureScreenshot 全部可用，且不受任何窗口最小化/隐藏连累。
 * 普通视图（非 offscreen）搬到从未显示的 ghost 上则点不动也截不到（合成层不在那个窗口上）。
 * 所以后台承载必须是 offscreen 视图 + 隐藏 ghost 窗口，两者缺一不可。
 */
const GHOST_OFFSCREEN_X = -32000
const GHOST_OFFSCREEN_Y = -32000
/** ghost 窗口默认尺寸；真正视口由孪生视图 setBounds 决定，这里只是窗口外框 */
const GHOST_MIN_WIDTH = 1280
const GHOST_MIN_HEIGHT = 800

/**
 * 标记内嵌页面用的小旗。
 *
 * main.cjs 里有一个全局 will-navigate 守卫（只允许界面自身的地址），
 * BrowserView 的 webContents 也会被它扫到——不区分的话页面里的链接点击会被吞掉，
 * 还会顺手用系统浏览器打开。主进程遇到带旗的 contents 必须直接返回。
 */
const EMBEDDED_TAB_FLAG = Symbol.for('chaotang.embeddedBrowserTab')

function isEmbeddedTab(contents) {
  return !!(contents && contents[EMBEDDED_TAB_FLAG])
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 把 Electron 自带的 UA 里的 Electron/xx 去掉，版本对齐真实的 Chromium。
 * 模板拼装放在 rules.buildUserAgent（纯函数，不需要 Electron 就能单测），这里只喂进程信息。
 */
function buildCleanUserAgent() {
  return rules.buildUserAgent(process.versions.chrome, process.platform)
}

/**
 * Client Hints 那一整套覆盖值（M6）。
 *
 * 只改 UA 字符串不够：Chromium 会另外发 sec-ch-ua 系列请求头，并把品牌列表暴露给
 * navigator.userAgentData，严格的风控站点两头一对照就看见 Electron。所以三处一起改：
 * userAgentData 靠 CDP 的 userAgentMetadata，请求头靠 webRequest.onBeforeSendHeaders。
 */
function buildHintSet(userAgent) {
  return rules.buildClientHints({
    chromeVersion: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    userAgent
  })
}

// ============ 注入页面的取值脚本（只做读取与聚焦，不改渲染） ============

/** 取元素矩形：先滚动到视口中部，再读几何信息 */
function jsRectProbe(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(String(selector))});
    if (!el) return { error: 'NOT_FOUND' };
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, tag: el.tagName || '' };
  })()`
}

/** 清空输入框：走原生 setter，否则 React/Vue 的受控值不会更新 */
function jsClearField(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(String(selector))});
    if (!el) return 'NOT_FOUND';
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (el.value && setter && setter.set) setter.set.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'CLEARED';
  })()`
}

/** 读取元素文本或属性；all 为真时返回列表 */
function jsExtract(selector, attribute, all) {
  return `(() => {
    const attr = ${JSON.stringify(String(attribute || ''))};
    const pick = (el) => {
      if (attr === 'text' || attr === '') return (el.innerText || el.value || el.textContent || '').trim().slice(0, 800);
      if (attr === 'html') return el.innerHTML.trim().slice(0, 800);
      return el.getAttribute(attr);
    };
    if (${all ? 'true' : 'false'}) {
      return Array.from(document.querySelectorAll(${JSON.stringify(String(selector))}))
        .slice(0, 50)
        .map((el, i) => ({ index: i, tag: el.tagName, text: pick(el), href: el.href || null }));
    }
    const el = document.querySelector(${JSON.stringify(String(selector))});
    if (!el) return { error: 'NOT_FOUND' };
    return { tag: el.tagName, text: pick(el), href: el.href || null };
  })()`
}

/** AX 树为空时的兜底：列出可交互元素，让模型至少有东西可点 */
function jsInteractiveList() {
  return `(() => {
    const sel = 'a[href],button,input,select,textarea,[role=button],[role=link],[onclick],[tabindex]';
    return Array.from(document.querySelectorAll(sel)).slice(0, 120).map((el, i) => {
      const r = el.getBoundingClientRect();
      const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || el.href || '').trim().slice(0, 80);
      return i + ' <' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
        (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : '') +
        '> ' + label + ' @' + Math.round(r.x) + ',' + Math.round(r.y) +
        ' ' + Math.round(r.width) + 'x' + Math.round(r.height);
    }).join('\\n');
  })()`
}

/** 补发 change：insertText 不一定会让框架收到 change */
function jsDispatchChange(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(String(selector))});
    if (!el) return 'NOT_FOUND';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'CHANGED';
  })()`
}

/**
 * 元素不可信点击：先滚进视口再 el.click()，只供后台退化时使用。
 * 连同坐标一起返回：退化路径也要把动作画出来（M5），而合成事件本身不产生几何信息。
 */
function jsSyntheticClick(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(String(selector))});
    if (!el) return { status: 'NOT_FOUND' };
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
    el.click();
    const r = el.getBoundingClientRect();
    return { status: 'CLICKED', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`
}

/** 直接写入值（非可信输入），走原生 setter 以兼容受控组件 */
function jsSyntheticType(selector, text) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(String(selector))});
    if (!el) return { status: 'NOT_FOUND' };
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, ${JSON.stringify(String(text))});
    else el.value = ${JSON.stringify(String(text))};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const r = el.getBoundingClientRect();
    return { status: 'TYPED', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), length: String(el.value).length };
  })()`
}

/** 在元素上合成悬停事件 */
function jsSyntheticHover(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(String(selector))});
    if (!el) return { status: 'NOT_FOUND' };
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    const init = { bubbles: true, clientX: x, clientY: y };
    el.dispatchEvent(new MouseEvent('mouseover', init));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mousemove', init));
    return { status: 'HOVERED', x, y };
  })()`
}

/** 等合成层真的画出至少一帧：rAF 不跑就说明画不出，靠超时兜底 */
function jsWaitFrames() {
  return `new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve('PAINTED'))); })`
}

/**
 * 宿主创建入口
 *
 * @param deps.BrowserView Electron BrowserView 构造器
 * @param deps.BrowserWindow Electron BrowserWindow 构造器（M8-b 离屏后台孪生通道的 ghost 宿主需要；不传则后台通道自动关闭）
 * @param deps.session Electron session 模块
 * @param deps.getWindow () => BrowserWindow | null
 * @param deps.broadcast (channel, payload) => void  向渲染进程推送事件
 * @param deps.overlay 动作可视化覆盖窗（见 browser-overlay.cjs），可省略
 */
function createBrowserHost(deps) {
  const BrowserView = deps.BrowserView
  // ghost 宿主窗口要靠 BrowserWindow 造，没给就拿不到后台通道（前台路径完全不受影响）
  const BrowserWindowCtor = deps.BrowserWindow || null
  const sessionModule = deps.session
  const getWindow = deps.getWindow || (() => null)

  const broadcast = deps.broadcast || (() => {})
  /** 覆盖层是增强项：没有它动作照常执行，只是界面上看不见假鼠标 */
  const overlay = deps.overlay || null

  const tabs = new Map()
  let seq = 0
  let activeTabId = null
  let mountedTabId = null
  let policy = { allowlistEnabled: false, allowlist: [] }
  /** 渲染进程报回来的面板区域（窗口内容区 DIP 坐标） */
  let bounds = { x: 0, y: 0, width: 1280, height: 720 }
  let boundsKnown = false
  /** 需要画面时是否允许自动把浏览器唤到前台（产品决策：默认允许） */
  let autoRaise = true
  /**
   * 离屏后台孪生通道（M8-b）是否启用：默认开，但要 BrowserWindow 构造器在手才真跑得起来。
   *
   * 启用不等于每次都走后台：只有当前台（正常 view + 自动唤前台）确实满不了某个能力位时，
   * 才退一步把该标签页搬进一个从未显示的 ghost 窗口里的 offscreen 孪生视图（见 ensureGhostChannel）。
   */
  let backgroundEnabled = true
  /**
   * 面板当前是否显示在界面上：null=渲染进程还没告诉我们，false=用户明确收起了。
   * 为 false 时不擅自把页面画到别人面板上，只等渲染进程自己切回来。
   */
  let panelVisible = null
  /**
   * 接管锁（M6）：由主进程持有，渲染进程只是镜像。
   *
   * 为什么不放在渲染层：锁要能由“用户真的碰了页面”这种只有主进程知道的事实触发，
   * 而且要在渲染层忘记等一次的时候仍然把写操作拦住。
   */
  let manualHold = false
  /** 'panel'=用户按下接管按钮；'user-action'/'input'=用户实际操作了页面，会超时自动放开 */
  let holdSource = ''
  let holdTimer = null
  const userAgent = buildCleanUserAgent()
  const hints = buildHintSet(userAgent)
  /** 已经挂过安全闸的 partition：webRequest 同一类型只能有一个监听器，重复注册会把前面的顶掉 */
  const hardened = new Set()

  let stateTimer = null

  // ============ tab 生命周期 ============

  function newTab(url = BLANK, opts = {}) {
    const id = opts.id || `b${++seq}`
    const partition = opts.partition || `${PARTITION_PREFIX}${id}`
    const view = new BrowserView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    })
    const tab = {
      id,
      // view/wc 是“当前干活的那个”：前台指向 fgView，后台搬进孪生时指向 bgView（见 useCarrier）
      view,
      wc: view.webContents,
      partition,
      // M8-b：前台正常视图永远留在 fgView/fgWc，后台另开一个同 partition 的 offscreen 孪生
      fgView: view,
      fgWc: view.webContents,
      carrier: 'fg',
      offscreen: false,
      everShown: true,
      ghostWin: null,
      bgView: null,
      bgWc: null,
      attached: false,
      armed: false,
      mounted: false,
      mountedAt: 0,
      url: BLANK,
      title: '',
      httpStatus: 0,
      loadError: '',
      blockedUrl: ''
    }
    tabs.set(id, tab)
    // 没有活动标签页时，新建的就是活动标签页。
    // 之前只有 tab-open 显式调 setActive，于是「一个页面都没有时 Agent 直接 navigate」
    // 建出来的标签页没人指认，后续所有动作都报「浏览器还没有打开页面」（M3 回归扫出来的）。
    if (!activeTabId || !tabs.has(activeTabId)) setActive(id, { mount: false })
    view.webContents[EMBEDDED_TAB_FLAG] = true
    // UA 伪装要两层都做：session 层管子资源与 HTTP 头，webContents 层才真正改 navigator.userAgent。
    // 实测只调 session.setUserAgent 时页面读回来仍是默认的 Electron UA（带 Electron/28.0.0）。
    try {
      sessionModule.fromPartition(partition).setUserAgent(userAgent)
    } catch (e) {
      tab.uaError = e.message
    }
    try {
      view.webContents.setUserAgent(userAgent)
    } catch (e) {
      tab.uaError = tab.uaError || e.message
    }
    hardenPartition(tab)
    wireTabEvents(tab)
    if (url && url !== BLANK) loadUrl(tab, url).catch(() => {})
    return tab
  }

  /**
   * 给这个标签页所在的 partition 挂安全闸（M6）。
   *
   * 为什么挂在 session 而不是 webContents：权限申请、下载、请求拦截与请求头改写都归
   * session 管，BrowserView 只拿得到 webContents。partition 与标签页一一对应，所以
   * 「per-tab 加固」和「per-session 加固」在这里是同一件事。
   *
   * 整段容错：加固失败宁可让页面照旧跑，也不能把「开标签页」这条路堵死——
   * 回归脚手架里的 session 可能是精简的，缺哪个 API 都不该让 newTab 抛异常。
   */
  function hardenPartition(tab) {
    if (hardened.has(tab.partition)) return
    let ses = null
    try {
      ses = sessionModule.fromPartition(tab.partition)
    } catch (e) {
      tab.hardenError = e.message
      return
    }
    if (!ses) return
    hardened.add(tab.partition)
    tab.ses = ses
    const id = tab.id
    try {
      // 权限一律拒绝：内嵌浏览器只是取数和操作页面，摄像头/麦克风/地理位置/通知
      // 被页面要走就是实打实的越权，而且授权弹窗会抢走用户对界面的控制权
      if (typeof ses.setPermissionRequestHandler === 'function') {
        ses.setPermissionRequestHandler((_wc, permission, callback) => {
          broadcast('browser-blocked', { kind: 'permission', tabId: id, permission })
          callback(false)
        })
      }
      if (typeof ses.setPermissionCheckHandler === 'function') {
        ses.setPermissionCheckHandler(() => false)
      }
      // 下载会直接往用户磁盘写文件，模型一次 click 就可能触发：一律取消并告诉渲染进程
      if (typeof ses.on === 'function') {
        ses.on('will-download', (event, item) => {
          const target = item && typeof item.getURL === 'function' ? item.getURL() : ''
          const filename = item && typeof item.getFilename === 'function' ? item.getFilename() : ''
          try { event.preventDefault() } catch { /* 已经开始的下载取消不了 */ }
          broadcast('browser-blocked', { kind: 'download', tabId: id, url: target, filename })
        })
      }
      armWebRequest(ses, id)
    } catch (e) {
      tab.hardenError = e.message
    }
  }

  /**
   * 请求层的两道闸。
   *
   * onBeforeRequest 管「这次请求能不能发出去」：子框架跳转会绕开顶层导航的白名单，
   * 严格模式还要管 XHR/WebSocket 这些能长期往外送数据的通道，判定全在 rules 里。
   * onBeforeSendHeaders 管「头里露了什么」：setUserAgent 改不到 sec-ch-ua 系列头，
   * 只能在这里替换，而且只替换已有的，不无中生有。
   */
  function armWebRequest(ses, tabId) {
    if (!ses.webRequest) return
    if (typeof ses.webRequest.onBeforeRequest === 'function') {
      ses.webRequest.onBeforeRequest((details, callback) => {
        let block = false
        try {
          const owner = tabs.get(tabId)
          block = rules.requestBlocked(details, policy, { mainFrameUrl: owner ? owner.url : '' })
        } catch { /* 判定出错时放行，不能因为加固把正常站点弄瘫 */ }
        if (block) {
          broadcast('browser-blocked', {
            kind: 'request', tabId, url: details.url,
            resourceType: details.resourceType, host: rules.hostOf(details.url)
          })
        }
        callback({ cancel: block })
      })
    }
    if (typeof ses.webRequest.onBeforeSendHeaders === 'function') {
      ses.webRequest.onBeforeSendHeaders((details, callback) => {
        let changed = null
        try {
          const next = rules.applyClientHintHeaders(details.requestHeaders, hints)
          if (next.changed) changed = next.headers
          noteHintProbe(tabId, details, next.headers)
        } catch { /* 保持原样 */ }
        callback(changed ? { requestHeaders: changed } : {})
      })
    }
  }

  /**
   * 请求头改写留痕（只给回归脚手架看，不进给渲染进程的状态）。
   *
   * 为什么需要：sec-ch-ua 系列头只在加密传输上才发，本地 http 服务根本看不到它，
   * 于是「头改写那一层到底生效没有」在测试里只能靠口头承诺。记上改写前后的值，
   * 现场与回归都能拿真请求查，而且只记 UA 与三个 hint，不碰 cookie 与正文。
   */
  const hintProbe = []
  const HINT_HEADER_NAMES = ['user-agent', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']
  function pickHintHeaders(map) {
    const out = {}
    for (const [name, value] of Object.entries(map || {})) {
      const key = String(name).toLowerCase()
      if (HINT_HEADER_NAMES.includes(key)) out[key] = String(value).slice(0, 160)
    }
    return out
  }

  function noteHintProbe(tabId, details, afterHeaders) {
    hintProbe.push({
      tabId,
      url: String(details && details.url || '').slice(0, 120),
      resourceType: details && details.resourceType,
      before: pickHintHeaders(details && details.requestHeaders),
      after: pickHintHeaders(afterHeaders)
    })
    if (hintProbe.length > 24) hintProbe.shift()
  }

  function wireTabEvents(tab) {
    const wc = tab.wc
    wc.on('page-title-updated', (_event, title) => { tab.title = title; pushState() })
    wc.on('did-navigate', (_event, url, httpResponseCode) => {
      tab.url = url
      tab.httpStatus = httpResponseCode
      tab.loadError = ''
      tab.blockedUrl = ''
      armQuietly(tab)
      pushState()
    })
    wc.on('did-navigate-in-page', (_event, url) => { tab.url = url; pushState() })
    wc.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      if (!isMainFrame) return
      // -3 是 ERR_ABORTED：重定向、连点、重复 loadURL 都会触发，不是真失败
      if (errorCode === -3) return
      tab.loadError = `NAV_FAILED: ${errorDescription || '页面加载失败'} (code ${errorCode})`
      pushState()
    })
    wc.on('destroyed', () => {
      tabs.delete(tab.id)
      if (activeTabId === tab.id) activeTabId = lastTabId()
      if (mountedTabId === tab.id) mountedTabId = null
      pushState()
    })
    // 顶层导航兜底：页面里 location 赋值、表单提交、target=_blank 全走这条。
    // 协议拦截和白名单拦截是两件独立的事，rules.navigationAllowed 一次判完并给出能展示的原因。
    wc.on('will-navigate', (event, targetUrl) => {
      const decision = rules.navigationAllowed(targetUrl, policy)
      if (decision.ok) return
      event.preventDefault()
      tab.blockedUrl = targetUrl
      broadcast('browser-blocked', {
        kind: 'navigation', tabId: tab.id, url: targetUrl,
        host: rules.hostOf(targetUrl), reason: decision.reason, blockKind: decision.kind
      })
      pushState()
    })
    // 新窗口请求一律转成内嵌标签页，绝不开独立窗口
    wc.setWindowOpenHandler(({ url: targetUrl }) => {
      const decision = rules.navigationAllowed(targetUrl, policy)
      if (decision.ok) {
        const child = newTab()
        void loadUrl(child, targetUrl).catch(() => {})
        setActive(child.id, { mount: false })
        broadcast('browser-tab-opened', { tabId: child.id, url: targetUrl, fromTabId: tab.id })
      } else {
        broadcast('browser-blocked', {
          kind: 'navigation', tabId: tab.id, url: targetUrl,
          host: rules.hostOf(targetUrl), reason: decision.reason, blockKind: decision.kind
        })
      }
      return { action: 'deny' }
    })
    // 用户亲自动手就把锁上上：这是只有主进程知道的事实，渲染层靠广播拿
    wc.on('before-input-event', (_event, input) => {
      const withinCdpWindow = Date.now() < (tab.cdpInputUntil || 0)
      if (!rules.isUserInputEvent(input, { withinCdpWindow })) return
      noteUserDriving('input')
    })
  }

  // ============ 接管锁 ============

  /**
   * 上锁 / 解锁。
   *
   * 非显式接管（用户只是动了一下手）带超时自动放开，而且每次动作都刷新计时；
   * 面板上按下的「接管」按钮只能由用户自己点回去。
   * 变化一律广播 browser-hold，让渲染层把它镜像进 browserView.manualHold，
   * Agent 侧已有的 awaitManualRelease 就能看见主进程上的锁。
   */
  function setHold(on, source = 'panel') {
    manualHold = !!on
    holdSource = manualHold ? source : ''
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null }
    if (manualHold && source !== 'panel') {
      holdTimer = setTimeout(() => setHold(false, ''), HOLD_IDLE_RELEASE_MS)
    }
    broadcast('browser-hold', { on: manualHold, source: holdSource })
    pushState()
  }

  /** 用户在开车：已经是显式接管时不降级成自动释放 */
  function noteUserDriving(source) {
    if (manualHold && holdSource === 'panel') return
    setHold(true, source || 'user-action')
  }

  function lastTabId() {
    const ids = [...tabs.keys()]
    return ids.length ? ids[ids.length - 1] : null
  }

  function getTab(id) {
    return id ? tabs.get(String(id)) : tabs.get(activeTabId)
  }

  function setActive(id, opts = {}) {
    const tab = tabs.get(String(id))
    if (!tab) return false
    activeTabId = tab.id
    // 只有面板确实在界面上（渲染进程报过区域并且没收起）才顺手把页面画上去。
    // 用户正在看文件树时 Agent 切标签页，抢先把 BrowserView 画到那块矩形上就是事故；
    // 面板在界面上时渲染进程的 set-bounds(force) 会自己把画面挂上来（见 BrowserPanel 的 activeTabId 监听）。
    if (opts.mount !== false && panelVisible === true && (mountedTabId || opts.mount === true)) mount(tab)
    pushState()
    return true
  }

  // ============ 挂载（面板区域由渲染进程决定） ============

  function mount(tab) {
    const win = getWindow()
    if (!win) return false
    // 该标签页之前在后台孪生上：先搬回前台（释放 ghost + 按 URL 重加载正常视图）再挂。
    // 否则下面会把一个 offscreen 孪生视图 addBrowserView 到主窗口上，那不是给用户画东西的。
    if (tab && tab.carrier === 'bg') releaseGhost(tab)
    if (mountedTabId && mountedTabId !== tab.id) {
      const prev = tabs.get(mountedTabId)
      if (prev) {
        try { win.removeBrowserView(prev.fgView || prev.view) } catch { /* 已销毁 */ }
        prev.mounted = false
        prev.armed = false
      }
    }
    if (!tab.mounted) {
      try { win.addBrowserView(tab.view) } catch { return false }
      tab.mounted = true
    }
    mountedTabId = tab.id
    tab.mountedAt = Date.now()
    applyBounds(tab)
    armQuietly(tab)
    return true
  }

  function unmount(tab) {
    const win = getWindow()
    if (win && tab && tab.mounted) {
      try { win.removeBrowserView(tab.view) } catch { /* 已销毁 */ }
    }
    if (tab) { tab.mounted = false; tab.armed = false }
    if (mountedTabId === (tab && tab.id)) mountedTabId = null
  }

  function applyBounds(tab) {
    const win = getWindow()
    if (!win || !tab) return
    // 后台孪生住在 ghost 窗口里，视口从 (0,0) 算起，不能拿面板的窗口坐标去套
    if (tab.carrier === 'bg') { applyGhostBounds(tab); return }
    const box = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(2, Math.round(bounds.width)),
      height: Math.max(2, Math.round(bounds.height))
    }
    try { tab.view.setBounds(box) } catch { /* view 已销毁 */ }
    tab.viewport = { width: box.width, height: box.height }
  }

  // ============ 离屏后台孪生通道（M8-b）============

  /**
   * 把当前干活的视图切到前台正常视图或后台 offscreen 孪生视图。
   *
   * 之所以只需换 tab.view/tab.wc 两个指针：所有 CDP/DOM 调用都从 tab.wc 出发（sendCdp /
   * evaluateJs / settle / loadUrl / historyFlags），而 debugger 是按 webContents 附着的，
   * ensureDebugger 会自己发现“这位还没 attach”并重新附着；所以换 wc 时把 armed/attached 打回
   * false，下一句命令就会在新 webContents 上重新 Page.enable/Runtime.enable。
   */
  function useCarrier(tab, which) {
    if (!tab) return
    const next = which === 'bg' ? 'bg' : 'fg'
    if (tab.carrier === next && (next === 'bg' ? tab.bgWc : true)) {
      // 已在目标承载：只同步一下几何
      if (next === 'bg') applyGhostBounds(tab)
      return
    }
    if (next === 'bg') {
      tab.view = tab.bgView
      tab.wc = tab.bgWc
      tab.offscreen = true
      tab.everShown = false
      tab.mounted = true      // 孪生视图确实挂在 ghost 窗口上
    } else {
      tab.view = tab.fgView
      tab.wc = tab.fgWc
      tab.offscreen = false
      tab.everShown = true
      tab.mounted = mountedTabId === tab.id
    }
    tab.carrier = next
    tab.armed = false
    tab.attached = false
    if (next === 'bg') applyGhostBounds(tab)
  }

  /** 孪生视图的视口用面板尺寸，坐标才能与前台一致（从 ghost 窗口左上角算起） */
  function applyGhostBounds(tab) {
    if (!tab || !tab.bgView) return
    const w = Math.max(2, Math.round(bounds.width))
    const h = Math.max(2, Math.round(bounds.height))
    try { tab.bgView.setBounds({ x: 0, y: 0, width: w, height: h }) } catch { /* 已销毁 */ }
    tab.viewport = { width: w, height: h }
  }

  /**
   * 给后台孪生 webContents 挂上必要的事件。
   *
   * 不能直接复用前台的 wireTabEvents：那个把 destroyed 接到“删标签页”上，而孪生视图只是
   * 一个可丢弃的后台载体，销毁它不能把标签页删掉。安全层（白名单/下载/权限/请求头）全部
   * 挂在 session 上、按 partition 共享，前台已经加固过、后台同一 partition 自动继承；这里
   * 只补 webContents 级的导航拦截与地址栏同步，新窗口一律 deny（后台不弹子窗）。
   */
  function wireBackgroundTab(tab) {
    const wc = tab.bgWc
    if (!wc || wc.__bgWired) return
    wc.__bgWired = true
    wc.on('page-title-updated', (_e, title) => { if (tab.carrier === 'bg') { tab.title = title; pushState() } })
    wc.on('did-navigate', (_e, url, code) => {
      if (tab.carrier !== 'bg') return
      tab.url = url; tab.httpStatus = code; tab.loadError = ''
      pushState()
    })
    wc.on('did-navigate-in-page', (_e, url) => { if (tab.carrier === 'bg') { tab.url = url; pushState() } })
    wc.on('will-navigate', (event, targetUrl) => {
      const decision = rules.navigationAllowed(targetUrl, policy)
      if (decision.ok) return
      event.preventDefault()
      tab.blockedUrl = targetUrl
      broadcast('browser-blocked', {
        kind: 'navigation', tabId: tab.id, url: targetUrl,
        host: rules.hostOf(targetUrl), reason: decision.reason, blockKind: decision.kind
      })
      pushState()
    })
    wc.setWindowOpenHandler(({ url: targetUrl }) => {
      broadcast('browser-blocked', {
        kind: 'navigation', tabId: tab.id, url: targetUrl,
        host: rules.hostOf(targetUrl), reason: '后台承载不开新窗口', blockKind: 'popup-denied'
      })
      return { action: 'deny' }
    })
  }

  /**
   * 惰性开一个属于该标签页的 ghost 宿主 + offscreen 孪生视图，并把承载切过去。
   *
   * 探针实测：每个离屏 tab 需要各自独立的 ghost 窗口（setBrowserView 同窗口只留一个视图，
   * 第二个会把第一个压成 0x0），所以 ghostWin 按 tab 一窗口。partition 与前台相同：cookie/登录态
   * 自动共享。创建后把 tab.url 加载进去；若前台已导航到其它地址，孪生从当前 tab.url 起步。
   */
  async function ensureGhostChannel(tab) {
    if (!backgroundEnabled || !BrowserWindowCtor || !BrowserView) return false
    if (tab.bgWc && !tab.bgWc.isDestroyed()) {
      useCarrier(tab, 'bg')
      return true
    }
    const winW = Math.max(GHOST_MIN_WIDTH, Math.round(bounds.width))
    const winH = Math.max(GHOST_MIN_HEIGHT, Math.round(bounds.height))
    let win = null
    let view = null
    try {
      win = new BrowserWindowCtor({
        show: false,
        x: GHOST_OFFSCREEN_X,
        y: GHOST_OFFSCREEN_Y,
        width: winW,
        height: winH,
        webPreferences: { sandbox: true }
      })
      view = new BrowserView({
        webPreferences: {
          partition: tab.partition,
          offscreen: true,
          backgroundThrottling: false,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          spellcheck: false
        }
      })
    } catch (e) {
      tab.bgError = e.message
      if (win && !win.isDestroyed()) { try { win.destroy() } catch { /* 忽略 */ } }
      return false
    }
    win.setBrowserView(view)
    view.webContents[EMBEDDED_TAB_FLAG] = true
    // 与前台一致的 UA（navigator.userAgent 这层靠 webContents；session 层已按 partition 设过）
    try { view.webContents.setUserAgent(userAgent) } catch { /* 忽略 */ }
    tab.ghostWin = win
    tab.bgView = view
    tab.bgWc = view.webContents
    tab.bgError = ''
    wireBackgroundTab(tab)
    useCarrier(tab, 'bg')
    const startUrl = tab.url && tab.url !== BLANK ? tab.url : BLANK
    if (startUrl !== BLANK) {
      try { await loadUrl(tab, startUrl) } catch { /* 导航失败下面也会因 canCapture 报错 */ }
    } else {
      await ensureArmed(tab).catch(() => {})
    }
    return true
  }

  /**
   * 释放后台孪生：关掉 ghost 窗口与离屏视图，把承载切回前台。
   *
   * 回到前台时按当前 tab.url 把正常视图重加载一次（Option 1 的既定取舍：前后台交接以 URL 对齐，
   * 不保证逐帧同一 DOM）。重加载是 best-effort，不能因为前台同步失败而报错。
   */
  function releaseGhost(tab, opts = {}) {
    if (!tab) return
    const hadBg = tab.carrier === 'bg' || !!tab.bgWc
    if (tab.bgWc && !tab.bgWc.isDestroyed()) {
      try { if (tab.bgWc.debugger.isAttached()) tab.bgWc.debugger.detach() } catch { /* 忽略 */ }
      try { tab.bgWc.close() } catch { /* 忽略 */ }
    }
    if (tab.ghostWin && !tab.ghostWin.isDestroyed()) { try { tab.ghostWin.destroy() } catch { /* 忽略 */ } }
    tab.bgView = null
    tab.bgWc = null
    tab.ghostWin = null
    tab.carrier = 'fg'
    tab.offscreen = false
    tab.everShown = true
    tab.view = tab.fgView
    tab.wc = tab.fgWc
    tab.armed = false
    tab.attached = false
    tab.mounted = mountedTabId === tab.id
    // 前台需要看到后台最新的页面：best-effort 重加载到当前 URL
    if (hadBg && opts.sync !== false && tab.fgWc && !tab.fgWc.isDestroyed() && tab.url && tab.url !== BLANK) {
      if (mountedTabId === tab.id) {
        try { tab.fgWc.loadURL(tab.url).catch(() => {}) } catch { /* 忽略 */ }
      }
    }
  }

  function currentVisibility(tab) {
    // 后台承载：孪生视图挂在从未显示的 ghost 上，offscreen 保证出帧，
    // everShown=false 让它不算“被藏起来”→ canClick/canCapture 为真（探针实测已证实）
    if (tab && tab.carrier === 'bg') {
      return rules.resolveCapability({
        mounted: true,
        offscreen: true,
        windowVisible: false,
        minimized: false,
        everShown: false,
        width: tab.viewport ? tab.viewport.width : bounds.width,
        height: tab.viewport ? tab.viewport.height : bounds.height
      })
    }
    const win = getWindow()
    return rules.resolveCapability({
      mounted: !!(tab && tab.mounted),
      offscreen: !!(tab && tab.offscreen),
      windowVisible: win ? win.isVisible() : false,
      minimized: win ? win.isMinimized() : true,
      // 宿主窗口是应用主窗口，一开始就显示；从未显示的 ghost 宿主在上面的 bg 分支里
      everShown: true,
      width: bounds.width,
      height: bounds.height
    })
  }

  /**
   * 确保合成层已经跟上，并把结果当作关卡而不是丢弃。
   *
   * 实测：刚 addBrowserView / 从别的标签页切过来时，可见性判定已经是 canCapture，
   * 但合成层可能还没产出帧，Page.captureScreenshot 会一去不回直到超时。
   * 旧写法等完两帧却不用结果，真卡住时白白拿 3.5s+8s 去碰运气；现在把
   * 「两帧有没有过」返回给调用方，没过时先补救一次，补救不成给可重试的明确原因。
   *
   * @returns {Promise<{painted: boolean}>} painted 为 false 时不要发需要画面的命令
   */
  async function ensurePainted(tab) {
    const since = Date.now() - (tab.mountedAt || 0)
    if (since < SURFACE_SETTLE_MS) await sleep(SURFACE_SETTLE_MS - since)
    try {
      const frames = await evaluateJs(tab, jsWaitFrames(), { ms: PAINT_FRAME_WAIT_MS })
      return { painted: frames === 'PAINTED' }
    } catch {
      return { painted: false }
    }
  }

  /**
   * 需要画面时确保页面在合成层里（现在只有截图走这里）。
   * 输入类动作不再经过它：矩阵探针证明键盘与滚轮对合成层没有要求，
   * 拿它当输入关卡会白白把面板拉到前台，还会让本来能送达的真事件被误标为合成。
   * 未挂载时不自己画（会盖住用户正在看的其它面板），而是请渲染进程切回来。
   */
  async function ensureSurface(tab, reason) {
    let vis = currentVisibility(tab)
    if (vis.canCapture) {
      const paint = await ensurePainted(tab)
      return { ok: true, vis, painted: paint.painted, carrier: tab.carrier }
    }
    if (vis.level === 'detached' && autoRaise && boundsKnown) {
      broadcast('browser-raise', { reason, tabId: tab.id })
      if (panelVisible !== false) {
        // 面板本来就在界面上（只是标签页切走了）：直接挂回来
        mount(tab)
      } else {
        // 用户明确收起了面板：等渲染进程响应 browser-raise，不硬画
        const started = Date.now()
        while (Date.now() - started < RAISE_WAIT_MS && !tab.mounted) await sleep(60)
      }
      // 刚挂上去（尤其是顶掉了另一个 view）要等合成层跟上，否则命令会发出去不回
      vis = currentVisibility(tab)
      if (vis.canCapture) {
        const paint = await ensurePainted(tab)
        return { ok: true, vis, raised: true, painted: paint.painted, carrier: tab.carrier }
      }
    }
    // 前台（含自动唤前台）仍拿不到画面：退一步走离屏后台孪生通道（M8-b）。
    // 探针实测 offscreen 孪生不受最小化/遮挡连累，canCapture 恒真，所以这里直接给 painted。
    if (backgroundEnabled && BrowserWindowCtor) {
      if (await ensureGhostChannel(tab)) {
        const bgVis = currentVisibility(tab)
        if (bgVis.canCapture) return { ok: true, vis: bgVis, carrier: 'bg', painted: true }
      }
    }
    return { ok: false, vis }
  }

  /**
   * 输入类动作的门槛，按能力位分开判。
   *
   * 矩阵探针只信页面里收到的事件，结果推翻了旧写法里的一条假设：
   * 「拿不到画面就等于真事件送不进去」。实际上键盘在未挂载、最小化、隐藏三种状态下
   * 都能送进页面，滚轮只要还挂在窗口上就能生效，只有鼠标按下/抬起真正需要合成层。
   * 所以这里按 kind 取对应的位，不再一律拿 canCapture 当关卡：
   * - key：永远走真事件，也不该把面板拉到前台；
   * - wheel：要求挂载且有尺寸；
   * - click：要求挂载、有尺寸且窗口未被藏起来，未挂载时先唤回来再试一次。
   */
  async function inputGate(tab, kind) {
    const bit = kind === 'key' ? 'canKey' : kind === 'wheel' ? 'canWheel' : 'canClick'
    let vis = currentVisibility(tab)
    if (vis[bit]) return { real: true, vis, carrier: tab.carrier }
    if (kind === 'key') return { real: true, vis, carrier: tab.carrier } // 防未来改动把键盘误挡：键盘不依赖任何前台状态
    if (vis.level === 'detached' && autoRaise && boundsKnown) {
      broadcast('browser-raise', { reason: kind, tabId: tab.id })
      if (panelVisible !== false) {
        mount(tab)
      } else {
        const started = Date.now()
        while (Date.now() - started < RAISE_WAIT_MS && !tab.mounted) await sleep(60)
      }
      vis = currentVisibility(tab)
      if (vis[bit]) {
        // 刚挂上来的瞬间合成层可能还没跟上，这时发 Input.* 会一去不回
        const paint = await ensurePainted(tab)
        if (!paint.painted) return { real: false, vis, unstable: true }
        return { real: true, vis, raised: true, carrier: tab.carrier }
      }
    }
    // 前台（含自动唤前台）仍送不了这位真事件：退一步走离屏后台孪生通道（M8-b）。
    // 孪生在从未显示的 ghost 上：真鼠标/滚轮都送得到页面，canClick/canWheel 为真。
    if (backgroundEnabled && BrowserWindowCtor) {
      if (await ensureGhostChannel(tab)) {
        vis = currentVisibility(tab)
        if (vis[bit]) return { real: true, vis, carrier: 'bg' }
      }
    }
    return { real: false, vis, carrier: tab.carrier }
  }

  /** 退化路径的提醒要说清是哪一种能力不通，不拿「拿不到画面」解释键盘 */
  function fallbackWarning(vis, gate, kind) {
    if (gate && gate.unstable) {
      return '页面刚挂回界面，合成层还没跟上，本步退化为 JS 合成事件（isTrusted 为 false）：这是暂时状态，重试一次通常就能走真事件'
    }
    const what = kind === 'wheel' ? '滚轮事件' : kind === 'hover' ? '悬停' : kind === 'type' ? '输入焦点' : '鼠标点击'
    const why = (kind === 'wheel' ? vis.wheelHint : vis.clickHint) || vis.reason
    return `${why}，${what}已退化为 JS 合成事件：isTrusted 为 false，风控严格的站点可能识别为非人工操作`
  }

  // ============ CDP 原语 ============

  function ensureDebugger(tab) {
    if (tab.destroyed) throw new Error('TAB_CLOSED: 标签页已关闭')
    if (!tab.wc.isDevToolsOpened()) {
      try {
        if (!tab.wc.debugger.isAttached()) tab.wc.debugger.attach('1.3')
      } catch (e) {
        throw new Error(`DEBUGGER_BUSY: 调试通道被占用（${e.message}）`)
      }
      tab.attached = true
      tab.armed = false
      if (!tab.detachWired) {
        tab.detachWired = true
        tab.wc.debugger.on('detach', () => { tab.attached = false; tab.armed = false })
      }
    }
  }

  async function ensureArmed(tab) {
    ensureDebugger(tab)
    if (tab.armed) return
    // 铁律 1：导航途中不开域，先等落地
    await settle(tab, 5000)
    await sendCdp(tab, 'Page.enable')
    await sendCdp(tab, 'Runtime.enable')
    await armUserAgent(tab)
    tab.armed = true
  }

  /**
   * UA 伪装的第三层（M6）：navigator.userAgentData 靠 CDP 的 userAgentMetadata。
   *
   * 与铁律 2 的区分：禁的是 Emulation.*——那个会污染合成层、让截图永久挂死；
   * Network.setUserAgentOverride 只改 UA 相关数据，不碰视口。即便如此整段还是包起来：
   * 这个域在哪个 Electron 版本上不顺手时，退化成「只保留两层伪装」，不能挡住页面武装。
   * armed 会被 unmount/mount 打回 false，所以覆盖值也跟着重发。
   */
  async function armUserAgent(tab) {
    try {
      await sendCdp(tab, 'Network.enable')
      await sendCdp(tab, 'Network.setUserAgentOverride', {
        userAgent: hints.userAgent,
        acceptLanguage: hints.acceptLanguage,
        userAgentMetadata: hints.metadata
      })
      tab.uaOverridden = true
    } catch (e) {
      tab.uaOverridden = false
      tab.uaError = tab.uaError || `CLIENT_HINTS_FAILED: ${e.message}`
    }
  }

  function armQuietly(tab) {
    ensureArmed(tab).catch(() => { /* 由下一次调用重试 */ })
  }

  function sendCdp(tab, method, params, sessionId, ms) {
    ensureDebugger(tab)
    // 记下“这段时间里的输入是 Agent 自己灌的”，接管锁的自动上锁靠它区分人机
    if (String(method).indexOf('Input.') === 0) tab.cdpInputUntil = Date.now() + CDP_INPUT_GUARD_MS
    const timeout = ms || CDP_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`CDP_TIMEOUT: ${method} 超过 ${timeout}ms 未响应`))
      }, timeout)
      const done = (okFlag, payload) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (okFlag) resolve(payload)
        else reject(payload instanceof Error ? payload : new Error(String(payload)))
      }
      try {
        const p = tab.wc.debugger.sendCommand(method, params || {}, sessionId)
        if (!p || typeof p.then !== 'function') return done(true, undefined)
        p.then(v => done(true, v), e => done(false, e))
      } catch (e) {
        done(false, e)
      }
    })
  }

  async function evaluateJs(tab, expression, opts = {}) {
    await ensureArmed(tab)
    const res = await sendCdp(tab, 'Runtime.evaluate', {
      expression: String(expression),
      returnByValue: true,
      awaitPromise: true,
      userGesture: !!opts.userGesture
    }, opts.sessionId, opts.ms || EVAL_TIMEOUT_MS)
    if (res && res.exceptionDetails) {
      const detail = res.exceptionDetails
      throw new Error(`JS_EXCEPTION: ${(detail.exception && detail.exception.description) || detail.text || '执行出错'}`)
    }
    return res && res.result ? res.result.value : undefined
  }

  /** 等导航停下来（loadURL 的 promise 会先于重定向结束，所以要再看一次） */
  async function settle(tab, ms = NAV_TIMEOUT_MS) {
    const started = Date.now()
    while (tab.wc.isLoading() && Date.now() - started < ms) await sleep(50)
    if (tab.wc.isLoading()) throw new Error(`NAV_TIMEOUT: 页面加载超过 ${Math.round(ms / 1000)} 秒`)
    await sleep(30)
  }

  async function loadUrl(tab, url) {
    tab.loadError = ''
    try {
      await tab.wc.loadURL(url)
    } catch (e) {
      const msg = String(e && e.message || e)
      if (!/ERR_ABORTED/i.test(msg)) tab.loadError = tab.loadError || `NAV_FAILED: ${msg}`
    }
    await settle(tab)
    await ensureArmed(tab)
    if (tab.loadError) throw new Error(tab.loadError)
  }

  function domainBlockedMessage(url) {
    const host = rules.hostOf(url) || String(url)
    return `DOMAIN_BLOCKED: ${host} 不在允许的域名白名单内（可在设置 → 浏览器安全 中调整）`
  }

  /** 导航被拒时的措词：协议越界和白名单越界是两个不同的修法，不能混为一谈 */
  function navigationBlockMessage(url, decision) {
    if (decision.kind === 'protocol') return `PROTOCOL_BLOCKED: ${decision.reason}`
    return domainBlockedMessage(url)
  }

  // ============ 输入原语（真事件，isTrusted = true） ============

  async function dispatchClick(tab, x, y) {
    await sendCdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await sendCdp(tab, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1
    })
    await sendCdp(tab, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1
    })
    emitGesture(tab, { type: 'click', x, y })
  }

  /**
   * 动作广播（M5）：一次动作同时告诉渲染进程和覆盖层。
   *
   * 两个去处的前提不一样，不能合并成一次调用：
   * - browser-gesture 无条件发给渲染进程：面板收起时用户仍然要靠状态条文字知道 Agent 在干什么，
   *   回归测试也只在事件这一层断言（覆盖层画了什么不需要画面就能验证）；
   * - 覆盖窗只画活动标签页的动作：那块矩形显示的就是活动页，
   *   把后台标签页的坐标画上去等于指着错误的地方说话，比什么都不画更糟。
   *
   * 坐标一律是页面视口 CSS px（与 Input.dispatch*、BrowserView.setBounds 同一套，不做换算）。
   */
  function emitGesture(tab, gesture) {
    if (!tab || !gesture || !gesture.type) return
    const payload = { tabId: tab.id, ...gesture }
    broadcast('browser-gesture', payload)
    if (!overlay || typeof overlay.gesture !== 'function') return
    if (tab.id !== activeTabId) return
    try { overlay.gesture(payload) } catch { /* 覆盖层出错不能连累动作 */ }
  }

  /** 覆盖窗与 BrowserView 共用同一个矩形，假鼠标才能 1:1 落在页面元素上 */
  function syncOverlayBounds(visible) {
    if (!overlay || typeof overlay.setBounds !== 'function') return
    try { overlay.setBounds(visible ? { ...bounds } : null) } catch { /* 同上 */ }
  }

  async function clickSelector(tab, selector) {
    const rect = await evaluateJs(tab, jsRectProbe(selector))
    if (!rect || rect.error === 'NOT_FOUND') {
      return { ok: false, error: `NOT_FOUND: 页面上找不到选择器 ${selector}` }
    }
    const point = rules.clickPointFromRect(rect)
    if (!point.ok) return { ok: false, error: `${point.error}（选择器 ${selector}）` }
    if (!rules.isPointInViewport(point, tab.viewport || bounds)) {
      return { ok: false, error: `OUT_OF_VIEWPORT: 元素 ${selector} 滚动后仍不在可视区` }
    }
    await dispatchClick(tab, point.x, point.y)
    return { ok: true, x: point.x, y: point.y, tag: rect.tag }
  }

  // ============ 状态广播 ============

  /**
   * webContents 的历史栈可用性。
   * 内嵌模式下页面是真的，历史栈归 Chromium 自己管，面板不必再像 Playwright 时代那样
   * 拿访问记录拼一个假历史（browser-session.navHistory），照实返回即可。
   */
  function historyFlags(tab) {
    if (!tab || tab.destroyed || tab.wc.isDestroyed()) return { canBack: false, canForward: false }
    return { canBack: tab.wc.canGoBack(), canForward: tab.wc.canGoForward() }
  }

  function publicState(tab) {
    const vis = currentVisibility(tab)
    const history = historyFlags(tab)
    return {
      active: !!tab && tab.url !== BLANK,
      tabId: tab ? tab.id : null,
      url: tab ? tab.url : '',
      title: tab ? tab.title : '',
      httpStatus: tab ? tab.httpStatus : 0,
      loadError: tab ? tab.loadError : '',
      blockedUrl: tab ? tab.blockedUrl : '',
      viewport: tab && tab.viewport ? tab.viewport : { width: bounds.width, height: bounds.height },
      visibility: vis.level,
      // 后台承载标识：'fg'=前台正常视图，'bg'=面板不可见时在离屏 ghost 里跑（M8-b）
      carrier: tab ? tab.carrier : 'fg',
      offscreen: !!(tab && tab.carrier === 'bg'),
      canCapture: vis.canCapture,
      captureHint: vis.canCapture ? '' : `${vis.reason}。${vis.hint}`,
      // 四位能力各自开关，模型才能分清「拿不到画面」与「事件送不进去」是两回事
      canClick: vis.canClick,
      canWheel: vis.canWheel,
      canKey: vis.canKey,
      clickHint: vis.canClick ? '' : `${vis.clickHint}。${vis.hint}`,
      canBack: history.canBack,
      canForward: history.canForward,
      panelVisible,
      autoRaise,
      manualHold,
      holdSource,
      policy,
      tabs: listTabs()
    }
  }

  function listTabs() {
    return [...tabs.values()].map(tab => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      partition: tab.partition,
      active: tab.id === activeTabId,
      mounted: tab.mounted
    }))
  }

  function pushState() {
    if (stateTimer) return
    stateTimer = setTimeout(() => {
      stateTimer = null
      try { broadcast('browser-state', publicState(getTab())) } catch { /* 窗口已关闭 */ }
    }, STATE_PUSH_MS)
  }

  // ============ 动作分派 ============

  /** 除 tab-open/navigate 外的动作都需要已有标签页；navigate 无标签时自动开一个 */
  function needTab(params, opts = {}) {
    const id = params && params.tabId
    const tab = getTab(id)
    if (tab) return tab
    if (opts.create) return newTab()
    return null
  }

  const actions = {
    // ---- 标签页管理 ----
    'tab-list': async () => ({ success: true, tabs: listTabs(), activeTabId }),

    'tab-open': async (params) => {
      const tab = newTab()
      if (params.url) {
        const decision = rules.navigationAllowed(params.url, policy)
        if (!decision.ok) return { success: false, error: navigationBlockMessage(params.url, decision) }
        await loadUrl(tab, params.url)
      }
      setActive(tab.id, { mount: params.activate !== false })
      return { success: true, ...publicState(tab) }
    },

    'tab-select': async (params) => {
      if (!params.tabId) return { success: false, error: '缺少 tabId' }
      if (!tabs.has(String(params.tabId))) return { success: false, error: 'TAB_NOT_FOUND: 标签页不存在' }
      setActive(params.tabId, { mount: true })
      return { success: true, ...publicState(getTab(params.tabId)) }
    },

    'tab-close': async (params) => {
      const tab = getTab(params.tabId)
      if (!tab) return { success: false, error: 'TAB_NOT_FOUND: 标签页不存在' }
      unmount(tab)
      releaseGhost(tab, { sync: false })
      tabs.delete(tab.id)
      if (activeTabId === tab.id) activeTabId = lastTabId()
      // 同理：只在面板确实占着界面上那块矩形时，才把顺延的下一个页面接着画上去
      if (activeTabId && panelVisible === true) { const next = getTab(); if (next) mount(next) }
      try { tab.fgWc && tab.fgWc.close() } catch { /* 已关闭 */ }
      pushState()
      return { success: true, message: '标签页已关闭', ...publicState(getTab()) }
    },

    // ---- 导航 ----
    'navigate': async (params) => {
      const url = params.url
      if (!url) return { success: false, error: '缺少 url' }
      const decision = rules.navigationAllowed(url, policy)
      if (!decision.ok) return { success: false, error: navigationBlockMessage(url, decision) }
      const tab = needTab(params, { create: true })
      await loadUrl(tab, url)
      if (!tab.mounted && mountedTabId) mount(tab)
      return { success: true, url: tab.url, title: tab.title, httpStatus: tab.httpStatus }
    },

    'back': async (params) => {
      const tab = needTab(params)
      if (!tab) return { success: false, error: '浏览器还没有打开页面' }
      if (!tab.wc.canGoBack()) {
        return { success: true, moved: false, url: tab.url, title: tab.title, message: '没有可后退的历史记录' }
      }
      tab.wc.goBack()
      await settle(tab)
      return { success: true, moved: true, url: tab.url, title: tab.title, message: '已后退' }
    },

    'forward': async (params) => {
      const tab = needTab(params)
      if (!tab) return { success: false, error: '浏览器还没有打开页面' }
      if (!tab.wc.canGoForward()) {
        return { success: true, moved: false, url: tab.url, title: tab.title, message: '没有可前进的历史记录' }
      }
      tab.wc.goForward()
      await settle(tab)
      return { success: true, moved: true, url: tab.url, title: tab.title, message: '已前进' }
    },

    'reload': async (params) => {
      const tab = needTab(params)
      if (!tab) return { success: false, error: '浏览器还没有打开页面' }
      if (tab.url === BLANK) return { success: false, error: '当前为空白页，请先输入地址' }
      tab.wc.reload()
      await settle(tab)
      return { success: true, url: tab.url, title: tab.title, message: '已刷新' }
    },

    'stop': async (params) => {
      const tab = needTab(params)
      if (!tab) return { success: false, error: '浏览器还没有打开页面' }
      try { tab.wc.stop() } catch { /* 忽略 */ }
      return { success: true, message: '已停止加载' }
    },

    // ---- 状态与策略 ----
    'state': async (params) => ({ success: true, ...publicState(getTab(params.tabId)) }),

    'set-policy': async (params) => {
      policy = {
        allowlistEnabled: !!params.allowlistEnabled,
        allowlist: Array.isArray(params.allowlist) ? params.allowlist : [],
        // 严格模式：把 XHR/WebSocket/SSE 这些「不发导航但能长期外送数据」的通道也管起来。
        // 默认关，只开白名单时仅拦子框架，否则大多数站点页面会直接瘫掉
        strictAllowlist: !!params.strictAllowlist
      }
      return { success: true, policy }
    },

    // 接管锁：面板按钮与回归脚本都走这里；on 缺省时取反当前状态
    'set-hold': async (params) => {
      const on = params.on === undefined ? !manualHold : !!params.on
      setHold(on, params.source || 'panel')
      return { success: true, manualHold, holdSource }
    },

    'set-bounds': async (params) => {
      const width = Number(params.width) || 0
      const height = Number(params.height) || 0
      if (width < 2 || height < 2) return { success: false, error: '面板区域尺寸过小' }
      bounds = {
        x: Math.round(Number(params.x) || 0),
        y: Math.round(Number(params.y) || 0),
        width: Math.round(width),
        height: Math.round(height)
      }
      boundsKnown = true
      panelVisible = params.hidden === true ? false : true
      const tab = getTab(params.tabId)
      if (tab) {
        // hidden=true 是渲染进程收起面板的明确信号，不能继续把页面留在界面上
        if (params.hidden === true) unmount(tab)
        // 面板切走了又切回来时（mountedTabId 为空）要重新挂上；
        // 挂着的是别的标签页时不抢它的位置，只更新尺寸。
        else if (params.force || !mountedTabId || mountedTabId === tab.id) mount(tab)
        else applyBounds(tab)
      }
      // 覆盖窗跟着同一个矩形走；hidden=true 时必须一起藏掉，
      // 否则假鼠标会飘在已经换成文件树的那块界面上
      syncOverlayBounds(params.hidden !== true)
      pushState()
      return { success: true, ...publicState(tab) }
    },

    'detach': async (params) => {
      const tab = getTab(params.tabId)
      if (tab) unmount(tab)
      panelVisible = false
      syncOverlayBounds(false)
      pushState()
      return { success: true, message: '已从界面卸下（页面仍在内存里）' }
    },

    'attach': async (params) => {
      const tab = needTab(params)
      if (!tab) return { success: false, error: '浏览器还没有打开页面' }
      if (!mount(tab)) return { success: false, error: '主窗口不可用，无法显示页面' }
      panelVisible = true
      syncOverlayBounds(true)
      pushState()
      return { success: true, ...publicState(tab) }
    },

    'set-auto-raise': async (params) => {
      autoRaise = !!params.enabled
      return { success: true, autoRaise }
    },

    // 离屏后台孪生通道开关（M8-b）：关掉后面板不可见时回到旧行为（需画面的动作诚实降级）
    'set-background': async (params) => {
      backgroundEnabled = !!params.enabled
      return { success: true, backgroundEnabled, available: !!BrowserWindowCtor }
    },

    // ---- 画面 ----
    'viewport': async (params) => {
      const size = rules.clampViewportSize(params.width, params.height)
      if (!size.ok) return { success: false, error: size.error }
      // 铁律 2：只用 setBounds 改视口，绝不碰 Emulation.setDeviceMetricsOverride
      bounds = { ...bounds, width: size.width, height: size.height }
      const tab = getTab(params.tabId)
      if (tab && tab.mounted) applyBounds(tab)
      if (tab) tab.viewport = { width: size.width, height: size.height }
      // 视口改动只动尺寸：覆盖层尺寸不同步的话，坐标越界会被面板侧钳到边上
      if (tab && tab.mounted) syncOverlayBounds(true)
      return { success: true, viewport: { width: size.width, height: size.height } }
    },

    'screenshot': async (params) => {
      const tab = needTab(params)
      if (!tab) return { success: false, error: '浏览器还没有打开页面' }
      const surface = await ensureSurface(tab, 'screenshot')
      if (!surface.ok) {
        return {
          success: false,
          error: `CAPTURE_UNAVAILABLE: ${surface.vis.reason}`,
          hint: surface.vis.hint,
          visibility: surface.vis.level
        }
      }
      const format = params.type === 'png' ? 'png' : 'jpeg'
      const cdpParams = { format }
      if (format === 'jpeg') cdpParams.quality = Math.max(30, Math.min(90, Number(params.quality) || 70))
      if (params.fullPage) cdpParams.captureBeyondViewport = true
      // 两帧都没过就不要发截图命令：它会占住调试通道直到超时，
      // 而且得到的错误对模型没有价值（重挂载后短暂出不来帧是正常现象）。先补救一次。
      if (surface.painted === false) {
        const repair = await ensurePainted(tab)
        if (repair.painted === false) {
          return {
            success: false,
            error: 'CAPTURE_UNAVAILABLE: 合成层尚未出帧（刚重新挂载）',
            hint: '稍后重试即可；取数、填写等文字操作不受影响',
            visibility: surface.vis.level,
            retryable: true
          }
        }
      }
      // 可见性判定拿不到「已经合成了一帧」这个事实，所以第一次用短超时再重试一次
      let res = null
      let lastError = null
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          res = await sendCdp(tab, 'Page.captureScreenshot', cdpParams, undefined, attempt ? CAPTURE_TIMEOUT_MS : 3500)
          break
        } catch (error) {
          lastError = error
          // 上一帧都没有，等下去也不会突然有：重新过一次出帧关卡再试
          if (attempt === 0) await ensurePainted(tab)
          else await sleep(300)
        }
      }
      if (!res || !res.data) {
        return {
          success: false,
          error: `CAPTURE_TIMEOUT: ${lastError ? lastError.message : '未取得画面'}`,
          visibility: currentVisibility(tab).level
        }
      }
      return {
        success: true,
        data: res.data,
        type: format,
        url: tab.url,
        title: tab.title,
        viewport: tab.viewport || { width: bounds.width, height: bounds.height }
      }
    },

    // ---- 页面结构 ----
    'snapshot': async (params) => {
      const tab = needTab(params)
      if (!tab) return { success: false, error: '浏览器还没有打开页面' }
      await ensureArmed(tab)
      let tree = ''
      try {
        const res = await sendCdp(tab, 'Accessibility.getFullAXTree', {}, undefined, CAPTURE_TIMEOUT_MS)
        tree = rules.flattenAxTree(res && res.nodes)
      } catch { /* 退化到 DOM 列表 */ }
      let truncated = false
      if (!tree) {
        try { tree = String(await evaluateJs(tab, jsInteractiveList()) || '') } catch { tree = '' }
      }
      const limited = rules.limitText(tree, rules.MAX_TREE_TEXT)
      truncated = limited.truncated
      return {
        success: true,
        url: tab.url,
        title: tab.title,
        accessibilityTree: limited.text || '(未能获取页面结构，可改用 browser_query 读取具体选择器)',
        truncated
      }
    },

    'query': async (params) => {
      const tab = needTab(params)
      if (!tab) return { success: false, error: '浏览器还没有打开页面' }
      if (!params.selector) return { success: false, error: '缺少 selector 参数' }
      const value = await evaluateJs(tab, jsExtract(params.selector, params.attribute, params.all))
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      const limited = rules.limitText(text === undefined ? '' : text, rules.MAX_EVAL_TEXT)
      return { success: true, result: limited.text, truncated: limited.truncated, url: tab.url, title: tab.title }
    },

    'evaluate': async (params) => {
      const tab = needTab(params)
      if (!tab) return { success: false, error: '浏览器还没有打开页面' }
      if (!params.expression) return { success: false, error: '缺少 expression 参数' }
      if (rules.containsForbiddenApi(params.expression)) {
        return { success: false, error: '表达式包含禁止的 API' }
      }
      const value = await evaluateJs(tab, params.expression)
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      const limited = rules.limitText(text === undefined ? '' : text, rules.MAX_EVAL_TEXT)
      return { success: true, result: limited.text, url: tab.url, title: tab.title }
    },

    // ---- 输入 ----
    'click': async (params) => {
      const tab = needTab(params)
      if (!tab) return { success: false, error: '浏览器还没有打开页面' }
      if (!params.selector) return { success: false, error: '缺少 selector 参数' }
      const gate = await inputGate(tab, 'click')
      if (gate.real) {
        const result = await clickSelector(tab, params.selector)
        if (!result.ok) return { success: false, error: result.error }
        if (params.settle !== false) await sleep(150)
        return {
          success: true, message: `已点击: ${params.selector}`,
          url: tab.url, title: tab.title, x: result.x, y: result.y
        }
      }
      if (params.jsFallback === false) {
        return { success: false, error: `NEED_TRUSTED_CLICK: ${gate.vis.clickHint}`, hint: gate.vis.hint }
      }
      const clicked = await evaluateJs(tab, jsSyntheticClick(params.selector))
      if (!clicked || clicked.status === 'NOT_FOUND') {
        return { success: false, error: `NOT_FOUND: 页面上找不到选择器 ${params.selector}` }
      }
      // 遮挡时用户更需要看见「Agent 这一步想干什么」，所以退化路径也画；
      // 但必须带 synthetic，覆盖层据此画成虚线琥珀色，不让人误读成页面真收到了事件
      emitGesture(tab, { type: 'click', x: clicked.x, y: clicked.y, synthetic: true })
      return {
        success: true, fallback: true, message: `已点击（JS 合成）: ${params.selector}`,
        warning: fallbackWarning(gate.vis, gate, 'click'), url: tab.url, title: tab.title, x: clicked.x, y: clicked.y
      }
    },

    'mouse-click': async (params) => {
      const tab = needTab(params)
      if (!tab) return { success: false, error: '浏览器还没有打开页面' }
      const x = Math.round(Number(params.x))
      const y = Math.round(Number(params.y))
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
        return { success: false, error: '缺少有效的点击坐标' }
      }
      const gate = await inputGate(tab, 'click')
      // 坐标直接落在视口像素上，不再做任何换算（rect 与 Input 都是 CSS px）
      if (gate.real) {
        await dispatchClick(tab, x, y)
        return { success: true, message: `已点击 (${x}, ${y})`, url: tab.url, x, y }
      }
      if (params.jsFallback === false) {
        return { success: false, error: `NEED_TRUSTED_CLICK: ${gate.vis.clickHint}`, hint: gate.vis.hint }
      }
      const hit = await evaluateJs(tab, `(() => { const el = document.elementFromPoint(${x}, ${y}); if (!el) return 'NOT_FOUND'; el.click(); return 'CLICKED'; })()`)
      if (hit === 'NOT_FOUND') return { success: false, error: `NOT_FOUND: (${x}, ${y}) 处没有元素` }
      emitGesture(tab, { type: 'click', x, y, synthetic: true })
      return {
        success: true, fallback: true, message: `已点击（JS 合成）(${x}, ${y})`,
        warning: fallbackWarning(gate.vis, gate, 'click'), url: tab.url, x, y
      }
    },

    'hover': async (params) => {
      const tab = needTab(params)
      if (!tab) return { success: false, error: '浏览器还没有打开页面' }
      if (!params.selector) return { success: false, error: '缺少 selector 参数' }
      const gate = await inputGate(tab, 'hover')
      if (gate.real) {
        const rect = await evaluateJs(tab, jsRectProbe(params.selector))
        if (!rect || rect.error === 'NOT_FOUND') return { success: false, error: `NOT_FOUND: 找不到 ${params.selector}` }
        const point = rules.clickPointFromRect(rect)
        if (!point.ok) return { success: false, error: point.error }
        await sendCdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
        await sendCdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y + 1 })
        emitGesture(tab, { type: 'hover', x: point.x, y: point.y })
        return { success: true, message: `已悬停: ${params.selector}`, x: point.x, y: point.y }
      }
      if (params.jsFallback === false) {
        return { success: false, error: `NEED_TRUSTED_CLICK: ${gate.vis.clickHint}`, hint: gate.vis.hint }
      }
      const hovered = await evaluateJs(tab, jsSyntheticHover(params.selector))
      if (!hovered || hovered.status === 'NOT_FOUND') return { success: false, error: `NOT_FOUND: 找不到 ${params.selector}` }
      emitGesture(tab, { type: 'hover', x: hovered.x, y: hovered.y, synthetic: true })
      return {
        success: true, fallback: true, message: `已悬停（JS 合成）: ${params.selector}`,
        warning: fallbackWarning(gate.vis, gate, 'hover'), x: hovered.x, y: hovered.y
      }
    },

    'type': async (params) => {
      const tab = needTab(params)
      if (!tab) return { success: false, error: '浏览器还没有打开页面' }
      if (!params.selector || params.text === undefined) return { success: false, error: '缺少 selector 或 text 参数' }
      const gate = await inputGate(tab, 'type')
      if (gate.real) {
        const clicked = await clickSelector(tab, params.selector)
        if (!clicked.ok) return { success: false, error: clicked.error }
        if (params.append !== true) {
          await evaluateJs(tab, jsClearField(params.selector)).catch(() => {})
        }
        await sendCdp(tab, 'Input.insertText', { text: String(params.text) })
        await evaluateJs(tab, jsDispatchChange(params.selector)).catch(() => {})
        // 填字这个动作没有新的鼠标位移，但要让用户看见「刚刚改的是哪个框」；
        // 只报坐标与字数，正文一个字都不进事件（表单里可能是密码）
        emitGesture(tab, { type: 'type', x: clicked.x, y: clicked.y, length: String(params.text).length })
        return { success: true, message: `已填写: ${params.selector}`, url: tab.url }
      }
      if (params.jsFallback === false) {
        return { success: false, error: `NEED_TRUSTED_CLICK: ${gate.vis.clickHint}`, hint: gate.vis.hint }
      }
      // 真点击送不到不等于要放弃真文字：JS 只负责聚焦，字符仍然走 Input.insertText（真实输入事件）。
      // 这一步能不能真生效不靠猜，写完之后从活动元素读回来验证一次
      const focused = await evaluateJs(tab, `(() => {
        const el = document.querySelector(${JSON.stringify(String(params.selector))});
        if (!el) return { status: 'NOT_FOUND' };
        el.scrollIntoView({ block: 'center' });
        if (typeof el.focus === 'function') el.focus();
        const r = el.getBoundingClientRect();
        return { status: 'OK', x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`)
      if (focused && focused.status === 'OK') {
        if (params.append !== true) {
          await evaluateJs(tab, jsClearField(params.selector)).catch(() => {})
        }
        await sendCdp(tab, 'Input.insertText', { text: String(params.text) })
        await evaluateJs(tab, jsDispatchChange(params.selector)).catch(() => {})
        const landed = await evaluateJs(tab, `(() => {
          const el = document.activeElement;
          if (!el) return false;
          const v = typeof el.value === 'string' ? el.value : (el.textContent || '');
          return v.indexOf(${JSON.stringify(String(params.text))}) >= 0;
        })()`)
        if (landed === true) {
          emitGesture(tab, { type: 'type', x: focused.x, y: focused.y, length: String(params.text).length })
          return {
            success: true, message: `已填写: ${params.selector}`, url: tab.url,
            note: '焦点由 JS 设置（真点击当前不可达），但文字是真实输入事件且已读回验证'
          }
        }
      }
      const typed = await evaluateJs(tab, jsSyntheticType(params.selector, params.text))
      if (!typed || typed.status === 'NOT_FOUND') {
        return { success: false, error: `NOT_FOUND: 页面上找不到选择器 ${params.selector}` }
      }
      emitGesture(tab, { type: 'type', x: typed.x, y: typed.y, length: typed.length, synthetic: true })
      return {
        success: true, fallback: true, message: `已填写（JS 合成）: ${params.selector}`,
        warning: fallbackWarning(gate.vis, gate, 'type'), url: tab.url
      }
    },

    'keyboard': async (params) => {
      const tab = needTab(params)
      if (!tab) return { success: false, error: '浏览器还没有打开页面' }
      const key = String(params.key || '')
      if (!key) return { success: false, error: '缺少按键名' }
      if (!rules.ALLOWED_KEYS.has(key)) return { success: false, error: `不支持的按键: ${key}` }
      const spec = rules.KEY_CODE_TABLE[key]
      // 矩阵探针实测：键盘在未挂载、最小化、隐藏三种状态下都能送进页面，
      // 所以这里不再设画面关卡，也不再为了按键把面板拉到前台；过去把它当成
      // 「需要合成层」而降级，是向模型误报：页面收到的是真按键，却被告知 isTrusted 为 false
      await sendCdp(tab, 'Input.dispatchKeyEvent', {
        type: spec.text ? 'keyDown' : 'rawKeyDown',
        windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
        code: spec.code,
        key: spec.key,
        text: spec.text || ''
      })
      await sendCdp(tab, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
        code: spec.code,
        key: spec.key
      })
      // 键盘动作没有坐标：覆盖层把标识画在鼠标上一次停下的地方
      emitGesture(tab, { type: 'key', key })
      return { success: true, message: `已按下 ${key}` }
    },

    'scroll': async (params) => {
      const tab = needTab(params)
      if (!tab) return { success: false, error: '浏览器还没有打开页面' }
      if (params.selector) {
        const moved = await evaluateJs(tab, `(() => { const el = document.querySelector(${JSON.stringify(String(params.selector))}); if (!el) return 'NOT_FOUND'; el.scrollIntoView({ block: ${JSON.stringify(params.block || 'center')}, inline: 'nearest' }); return 'OK'; })()`)
        if (moved === 'NOT_FOUND') return { success: false, error: `NOT_FOUND: 找不到 ${params.selector}` }
        return { success: true, message: `已滚动到 ${params.selector}` }
      }
      const deltaY = Math.max(-3000, Math.min(3000, Math.round(Number(params.deltaY) || 0)))
      const deltaX = Math.max(-3000, Math.min(3000, Math.round(Number(params.deltaX) || 0)))
      if (!deltaX && !deltaY) return { success: false, error: '缺少滚动量' }
      const x = Number.isFinite(Number(params.x)) ? Math.round(Number(params.x)) : Math.round(bounds.width / 2)
      const y = Number.isFinite(Number(params.y)) ? Math.round(Number(params.y)) : Math.round(bounds.height / 2)
      const gate = await inputGate(tab, 'wheel')
      if (!gate.real) {
        // 滚轮只要求「还挂在窗口上且有尺寸」：面板收起（未挂载）时确实不产生事件，
        // 但窗口最小化并不影响它，所以这里不能再说「窗口不可见」
        await evaluateJs(tab, `(window.scrollBy(${deltaX}, ${deltaY}), true)`)
        // 这里的坐标是页面中心，不是鼠标位置（JS 滚动根本不需要指针），
        // 仅用作方向提示的锚点，靠 synthetic 区分于真滚轮
        emitGesture(tab, { type: 'wheel', x, y, deltaX, deltaY, synthetic: true })
        return { success: true, message: '已滚动（JS 兜底：未挂载到界面时不产生真实滚轮事件）', fallback: true, warning: fallbackWarning(gate.vis, gate, 'wheel') }
      }
      await sendCdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY })
      emitGesture(tab, { type: 'wheel', x, y, deltaX, deltaY })
      return { success: true, message: '已滚动' }
    },

    // 兼容旧动作名
    'mouse-wheel': async (params) => actions.scroll({ ...params, deltaY: params.deltaY, deltaX: params.deltaX }),

    // ---- 跨域 iframe ----
    'frame-evaluate': async (params) => {
      const tab = needTab(params)
      if (!tab) return { success: false, error: '浏览器还没有打开页面' }
      if (!params.expression || rules.containsForbiddenApi(params.expression)) {
        return { success: false, error: '缺少 expression 或表达式被禁止' }
      }
      await ensureArmed(tab)
      const targets = await sendCdp(tab, 'Target.getTargets')
      const info = rules.pickIframeTarget(targets && targets.targetInfos, params.urlPart)
      if (!info) return { success: false, error: 'IFRAME_NOT_FOUND: 没有匹配的跨域子框架' }
      const attached = await sendCdp(tab, 'Target.attachToTarget', { targetId: info.targetId, flatten: true })
      const sessionId = attached && attached.sessionId
      if (!sessionId) return { success: false, error: 'IFRAME_ATTACH_FAILED' }
      await sendCdp(tab, 'Runtime.enable', {}, sessionId)
      const value = await evaluateJs(tab, params.expression, { sessionId })
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      const limited = rules.limitText(text === undefined ? '' : text, rules.MAX_EVAL_TEXT)
      return { success: true, result: limited.text, frameUrl: info.url }
    },

    'close': async () => {
      for (const tab of [...tabs.values()]) {
        unmount(tab)
        releaseGhost(tab, { sync: false })
        try { tab.fgWc && tab.fgWc.close() } catch { /* 已关闭 */ }
      }
      tabs.clear()
      activeTabId = null
      mountedTabId = null
      panelVisible = null
      setHold(false, '')
      syncOverlayBounds(false)
      pushState()
      return { success: true, message: '浏览器已关闭' }
    }
  }

  /**
   * 统一入口：渲染进程的工具与面板都走这里。
   *
   * meta.actor 是调用方自报的身份：'agent'（模型）/ 'user'（面板），没报就当 'user'。
   * 面板是可信 UI，把用户自己的按钮一起锁住等于把用户挡在自家门外面。
   * 自报身份不是防越权的（真要想越权当然可以乱报），它要的是另一件事：
   * 锁归主进程持有，用户真实操作能自动上锁，而模型侧不必再依赖渲染层记得先等一次；
   * 真出事的是“渲染层漏了 await”，那一层还有 awaitManualRelease 与面板按钮兼容着。
   */
  async function handle(action, params = {}, meta = {}) {
    const fn = actions[action]
    if (!fn) return { success: false, error: `未知的浏览器操作: ${action}` }
    const actor = meta && meta.actor === 'agent' ? 'agent' : 'user'
    if (actor === 'agent') {
      const refused = rules.controlPlaneRefused(action)
      if (refused) return { success: false, error: refused.error, hint: refused.hint, action }
      if (manualHold) {
        const decision = rules.holdDecision(action)
        if (!decision.allowed) {
          return { success: false, error: decision.error, hint: decision.hint, action, manualHold: true }
        }
      }
    }
    if (actor === 'user' && rules.isUserDrivingAction(action)) noteUserDriving('user-action')
    try {
      return await fn(params || {})
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message, action }
    } finally {
      pushState()
    }
  }

  function dispose() {
    for (const tab of tabs.values()) {
      // 先拆后台孪生（会同时销毁 ghost 窗口），再把 tab.wc 归位到前台正常视图统…处理
      releaseGhost(tab, { sync: false })
      try { if (tab.fgWc && !tab.fgWc.isDestroyed() && tab.fgWc.debugger.isAttached()) tab.fgWc.debugger.detach() } catch { /* 忽略 */ }
      try { tab.fgWc && tab.fgWc.close() } catch { /* 忽略 */ }
    }
    tabs.clear()
    activeTabId = null
    mountedTabId = null
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null }
    manualHold = false
    holdSource = ''
    if (stateTimer) clearTimeout(stateTimer)
  }

  return {
    handle,
    dispose,
    listTabs,
    publicState: () => publicState(getTab()),
    getPolicy: () => policy,
    /**
     * 加固与伪装的实际结果（只给回归脚手架看，不进给渲染进程的状态）。
     * 这两件事失败时页面照常能跑，所以必须有个地方把它们说出来，
     * 否则「白名单/权限/下载/请求头都拦住了」就变成了无法验证的口头承诺。
     */
    securityReport: () => [...tabs.values()].map(tab => ({
      id: tab.id,
      hardened: hardened.has(tab.partition),
      hardenError: tab.hardenError || '',
      uaOverridden: tab.uaOverridden === true,
      uaError: tab.uaError || ''
    })),
    /** 改写前后的 UA / Client Hints 实看（只给回归脚手架） */
    hintProbe: () => hintProbe.slice(-10),
    hasTabs: () => tabs.size > 0,
    getBounds: () => ({ ...bounds }),
    currentVisibility: () => currentVisibility(getTab()),
    /**
     * 后台孪生通道的实况（只给回归脚手架看）：哪些标签页开了 ghost、承载在哪、有没有报错。
     * 静默失效等于用户以为了不存在“不显示也能操作”，所以这一层必须能被看见。
     */
    ghostReport: () => [...tabs.values()].map(tab => ({
      id: tab.id,
      carrier: tab.carrier,
      hasGhost: !!tab.bgWc && !tab.bgWc.isDestroyed(),
      bgError: tab.bgError || '',
      available: !!(backgroundEnabled && BrowserWindowCtor)
    }))
  }
}

module.exports = { createBrowserHost, buildCleanUserAgent, isEmbeddedTab, PARTITION_PREFIX }
