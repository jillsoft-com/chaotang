'use strict'
/**
 * 内嵌浏览器宿主（主进程）
 *
 * 用 Electron 的 BrowserView 承载真实页面，用 webContents.debugger 走 CDP 驱动，
 * 不启 --remote-debugging-port，也不再依赖 Playwright。
 *
 * 三条从探针里换来的铁律，改动前请先读完：
 * 1. debugger.attach 之后要等导航落地再发 Page.enable / Runtime.enable；
 * 2. 绝不能调用 Emulation.setDeviceMetricsOverride —— 一旦调用，
 *    Page.captureScreenshot 会永久静默挂死，clearDeviceMetricsOverride 也救不回来。
 *    改视口只用 BrowserView.setBounds()。
 * 3. 截图只在「已挂载 + 窗口可见 + 有尺寸」时可用，其余情形不报错而是不返回，
 *    所以必须先做可见性判定，再发命令；所有 CDP 调用一律带超时兜底。
 */

const rules = require('./browser-rules.cjs')

/** 各类调用的超时（毫秒）。CDP 命令没有内建超时，必须自己加。 */
const CDP_TIMEOUT_MS = 5000
const EVAL_TIMEOUT_MS = 10000
const CAPTURE_TIMEOUT_MS = 8000
const NAV_TIMEOUT_MS = 30000
/** 需要画面/命中测试时，等渲染进程把面板切回来的最长时间 */
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

const PARTITION_PREFIX = 'persist:ct-browser-'
const BLANK = 'about:blank'

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
 *
 * 注意：这只覆盖 UA 字符串。Chromium 的 Client Hints（navigator.userAgentData 与
 * Sec-CH-UA 请求头）里仍然带着 Electron 品牌，严格的风控站点会两头对照。
 * 处理放在 M6（需要 webRequest 改写 Sec-CH-UA），这里先不拦。
 */
function buildCleanUserAgent() {
  const chrome = process.versions.chrome || '120.0.0.0'
  const platformTokens = {
    win32: 'Windows NT 10.0; Win64; x64',
    darwin: 'Macintosh; Intel Mac OS X 10_15_7',
    linux: 'X11; Linux x86_64'
  }
  const os = platformTokens[process.platform] || platformTokens.linux
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`
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

/** 元素不可信点击：先滚进视口再 el.click()，只供后台退化时使用 */
function jsSyntheticClick(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(String(selector))});
    if (!el) return 'NOT_FOUND';
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
    el.click();
    return 'CLICKED';
  })()`
}

/** 直接写入值（非可信输入），走原生 setter 以兼容受控组件 */
function jsSyntheticType(selector, text) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(String(selector))});
    if (!el) return 'NOT_FOUND';
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, ${JSON.stringify(String(text))});
    else el.value = ${JSON.stringify(String(text))};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'TYPED';
  })()`
}

/** 在当前焦点上合成键盘事件 */
function jsSyntheticKey(spec) {
  return `(() => {
    const target = document.activeElement || document.body;
    const init = { key: ${JSON.stringify(spec.key)}, code: ${JSON.stringify(spec.code)}, keyCode: ${spec.windowsVirtualKeyCode}, which: ${spec.windowsVirtualKeyCode}, bubbles: true, cancelable: true${spec.text ? `, text: ${JSON.stringify(spec.text)}` : ''} };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    return 'KEYED';
  })()`
}

/** 在元素上合成悬停事件 */
function jsSyntheticHover(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(String(selector))});
    if (!el) return 'NOT_FOUND';
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    const init = { bubbles: true, clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2) };
    el.dispatchEvent(new MouseEvent('mouseover', init));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mousemove', init));
    return 'HOVERED';
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
 * @param deps.session Electron session 模块
 * @param deps.getWindow () => BrowserWindow | null
 * @param deps.broadcast (channel, payload) => void  向渲染进程推送事件
 */
function createBrowserHost(deps) {
  const BrowserView = deps.BrowserView
  const sessionModule = deps.session
  const getWindow = deps.getWindow || (() => null)

  const broadcast = deps.broadcast || (() => {})

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
   * 面板当前是否显示在界面上：null=渲染进程还没告诉我们，false=用户明确收起了。
   * 为 false 时不擅自把页面画到别人面板上，只等渲染进程自己切回来。
   */
  let panelVisible = null
  const userAgent = buildCleanUserAgent()

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
      view,
      wc: view.webContents,
      partition,
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
    wireTabEvents(tab)
    if (url && url !== BLANK) loadUrl(tab, url).catch(() => {})
    return tab
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
    // 白名单在主进程兜底拦截 JS 触发的跳转
    wc.on('will-navigate', (event, targetUrl) => {
      if (rules.hostMatchesPolicy(targetUrl, policy)) return
      event.preventDefault()
      tab.blockedUrl = targetUrl
      broadcast('browser-blocked', { tabId: tab.id, url: targetUrl, host: rules.hostOf(targetUrl) })
      pushState()
    })
    // 新窗口请求一律转成内嵌标签页，绝不开独立窗口
    wc.setWindowOpenHandler(({ url: targetUrl }) => {
      if (rules.isHttpUrl(targetUrl) && rules.hostMatchesPolicy(targetUrl, policy)) {
        const child = newTab()
        void loadUrl(child, targetUrl).catch(() => {})
        setActive(child.id, { mount: false })
        broadcast('browser-tab-opened', { tabId: child.id, url: targetUrl, fromTabId: tab.id })
      } else {
        broadcast('browser-blocked', { tabId: tab.id, url: targetUrl, host: rules.hostOf(targetUrl) })
      }
      return { action: 'deny' }
    })
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
    if (opts.mount !== false && (mountedTabId || opts.mount === true)) mount(tab)
    pushState()
    return true
  }

  // ============ 挂载（面板区域由渲染进程决定） ============

  function mount(tab) {
    const win = getWindow()
    if (!win) return false
    if (mountedTabId && mountedTabId !== tab.id) {
      const prev = tabs.get(mountedTabId)
      if (prev) {
        try { win.removeBrowserView(prev.view) } catch { /* 已销毁 */ }
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
    const box = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(2, Math.round(bounds.width)),
      height: Math.max(2, Math.round(bounds.height))
    }
    try { tab.view.setBounds(box) } catch { /* view 已销毁 */ }
    tab.viewport = { width: box.width, height: box.height }
  }

  function currentVisibility(tab) {
    const win = getWindow()
    return rules.resolveVisibility({
      mounted: !!(tab && tab.mounted),
      windowVisible: win ? win.isVisible() : false,
      minimized: win ? win.isMinimized() : true,
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
   * 需要画面或命中测试时确保页面在合成层里。
   * 未挂载时不自己画（会盖住用户正在看的其它面板），而是请渲染进程切回来。
   */
  async function ensureSurface(tab, reason) {
    const vis = currentVisibility(tab)
    if (vis.canCapture) {
      const paint = await ensurePainted(tab)
      return { ok: true, vis, painted: paint.painted }
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
      const recheck = currentVisibility(tab)
      if (recheck.canCapture) {
        const paint = await ensurePainted(tab)
        return { ok: true, vis: recheck, raised: true, painted: paint.painted }
      }
      return { ok: false, vis: recheck }
    }
    return { ok: false, vis }
  }

  /**
   * 输入类动作的统一门槛。
   *
   * 探针实测：未挂载（后台）时 Input.dispatch* 会随机静默失效，严重时命令一去不回直接超时，
   * 而 Runtime.evaluate 始终可靠。所以真事件必须有合成层，拿不到画面就退化为 JS 合成事件，
   * 并在返回里如实标注 isTrusted 为 false，让模型自己判断要不要相信这一步生效了。
   */
  async function inputGate(tab, reason) {
    const surface = await ensureSurface(tab, reason)
    return surface.ok ? { real: true } : { real: false, vis: surface.vis }
  }

  function fallbackWarning(vis) {
    return `${vis.reason}，已退化为 JS 合成事件：isTrusted 为 false，风控严格的站点可能识别为非人工操作`
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
    tab.armed = true
  }

  function armQuietly(tab) {
    ensureArmed(tab).catch(() => { /* 由下一次调用重试 */ })
  }

  function sendCdp(tab, method, params, sessionId, ms) {
    ensureDebugger(tab)
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

  // ============ 输入原语（真事件，isTrusted = true） ============

  async function dispatchClick(tab, x, y) {
    await sendCdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await sendCdp(tab, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1
    })
    await sendCdp(tab, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1
    })
    broadcast('browser-gesture', { tabId: tab.id, type: 'click', x, y })
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

  function publicState(tab) {
    const vis = currentVisibility(tab)
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
      canCapture: vis.canCapture,
      captureHint: vis.canCapture ? '' : `${vis.reason}。${vis.hint}`,
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
        if (!rules.isHttpUrl(params.url)) return { success: false, error: '仅支持 http/https 协议' }
        if (!rules.hostMatchesPolicy(params.url, policy)) return { success: false, error: domainBlockedMessage(params.url) }
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
      tabs.delete(tab.id)
      if (activeTabId === tab.id) activeTabId = lastTabId()
      if (activeTabId) { const next = getTab(); if (next) mount(next) }
      try { tab.wc.close() } catch { /* 已关闭 */ }
      pushState()
      return { success: true, message: '标签页已关闭', ...publicState(getTab()) }
    },

    // ---- 导航 ----
    'navigate': async (params) => {
      const url = params.url
      if (!url || !rules.isHttpUrl(url)) return { success: false, error: '仅支持 http/https 协议' }
      if (!rules.hostMatchesPolicy(url, policy)) return { success: false, error: domainBlockedMessage(url) }
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
        allowlist: Array.isArray(params.allowlist) ? params.allowlist : []
      }
      return { success: true, policy }
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
      pushState()
      return { success: true, ...publicState(tab) }
    },

    'detach': async (params) => {
      const tab = getTab(params.tabId)
      if (tab) unmount(tab)
      panelVisible = false
      pushState()
      return { success: true, message: '已从界面卸下（页面仍在内存里）' }
    },

    'attach': async (params) => {
      const tab = needTab(params)
      if (!tab) return { success: false, error: '浏览器还没有打开页面' }
      if (!mount(tab)) return { success: false, error: '主窗口不可用，无法显示页面' }
      panelVisible = true
      pushState()
      return { success: true, ...publicState(tab) }
    },

    'set-auto-raise': async (params) => {
      autoRaise = !!params.enabled
      return { success: true, autoRaise }
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
        return { success: false, error: `NEED_SURFACE: ${gate.vis.reason}`, hint: gate.vis.hint }
      }
      const clicked = await evaluateJs(tab, jsSyntheticClick(params.selector))
      if (clicked === 'NOT_FOUND') {
        return { success: false, error: `NOT_FOUND: 页面上找不到选择器 ${params.selector}` }
      }
      return {
        success: true, fallback: true, message: `已点击（JS 合成）: ${params.selector}`,
        warning: fallbackWarning(gate.vis), url: tab.url, title: tab.title
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
        return { success: false, error: `NEED_SURFACE: ${gate.vis.reason}`, hint: gate.vis.hint }
      }
      const hit = await evaluateJs(tab, `(() => { const el = document.elementFromPoint(${x}, ${y}); if (!el) return 'NOT_FOUND'; el.click(); return 'CLICKED'; })()`)
      if (hit === 'NOT_FOUND') return { success: false, error: `NOT_FOUND: (${x}, ${y}) 处没有元素` }
      return {
        success: true, fallback: true, message: `已点击（JS 合成）(${x}, ${y})`,
        warning: fallbackWarning(gate.vis), url: tab.url, x, y
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
        broadcast('browser-gesture', { tabId: tab.id, type: 'hover', x: point.x, y: point.y })
        return { success: true, message: `已悬停: ${params.selector}`, x: point.x, y: point.y }
      }
      if (params.jsFallback === false) {
        return { success: false, error: `NEED_SURFACE: ${gate.vis.reason}`, hint: gate.vis.hint }
      }
      const hovered = await evaluateJs(tab, jsSyntheticHover(params.selector))
      if (hovered === 'NOT_FOUND') return { success: false, error: `NOT_FOUND: 找不到 ${params.selector}` }
      return {
        success: true, fallback: true, message: `已悬停（JS 合成）: ${params.selector}`,
        warning: fallbackWarning(gate.vis)
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
        return { success: true, message: `已填写: ${params.selector}`, url: tab.url }
      }
      if (params.jsFallback === false) {
        return { success: false, error: `NEED_SURFACE: ${gate.vis.reason}`, hint: gate.vis.hint }
      }
      const typed = await evaluateJs(tab, jsSyntheticType(params.selector, params.text))
      if (typed === 'NOT_FOUND') {
        return { success: false, error: `NOT_FOUND: 页面上找不到选择器 ${params.selector}` }
      }
      return {
        success: true, fallback: true, message: `已填写（JS 合成）: ${params.selector}`,
        warning: fallbackWarning(gate.vis), url: tab.url
      }
    },

    'keyboard': async (params) => {
      const tab = needTab(params)
      if (!tab) return { success: false, error: '浏览器还没有打开页面' }
      const key = String(params.key || '')
      if (!key) return { success: false, error: '缺少按键名' }
      if (!rules.ALLOWED_KEYS.has(key)) return { success: false, error: `不支持的按键: ${key}` }
      const spec = rules.KEY_CODE_TABLE[key]
      const gate = await inputGate(tab, 'keyboard')
      if (gate.real) {
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
        broadcast('browser-gesture', { tabId: tab.id, type: 'key', key })
        return { success: true, message: `已按下 ${key}` }
      }
      if (params.jsFallback === false) {
        return { success: false, error: `NEED_SURFACE: ${gate.vis.reason}`, hint: gate.vis.hint }
      }
      await evaluateJs(tab, jsSyntheticKey(spec))
      return { success: true, fallback: true, message: `已按下 ${key}（JS 合成）`, warning: fallbackWarning(gate.vis) }
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
      const surface = await ensureSurface(tab, 'scroll')
      if (!surface.ok) {
        // 滚轮事件依赖合成层，后台发会直接挂死；退化成 JS 滚动（不产生真实滚轮事件）
        await evaluateJs(tab, `(window.scrollBy(${deltaX}, ${deltaY}), true)`)
        return { success: true, message: '已滚动（JS 兜底：窗口不可见时不产生真实滚轮事件）', fallback: true }
      }
      await sendCdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY })
      broadcast('browser-gesture', { tabId: tab.id, type: 'wheel', x, y, deltaX, deltaY })
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
        try { tab.wc.close() } catch { /* 已关闭 */ }
      }
      tabs.clear()
      activeTabId = null
      mountedTabId = null
      panelVisible = null
      pushState()
      return { success: true, message: '浏览器已关闭' }
    }
  }

  /** 统一入口：渲染进程工具与面板都走这里 */
  async function handle(action, params = {}) {
    const fn = actions[action]
    if (!fn) return { success: false, error: `未知的浏览器操作: ${action}` }
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
      try { if (tab.wc.debugger.isAttached()) tab.wc.debugger.detach() } catch { /* 忽略 */ }
      try { tab.wc.close() } catch { /* 忽略 */ }
    }
    tabs.clear()
    activeTabId = null
    mountedTabId = null
    if (stateTimer) clearTimeout(stateTimer)
  }

  return {
    handle,
    dispose,
    listTabs,
    publicState: () => publicState(getTab()),
    getPolicy: () => policy,
    hasTabs: () => tabs.size > 0,
    getBounds: () => ({ ...bounds }),
    currentVisibility: () => currentVisibility(getTab())
  }
}

module.exports = { createBrowserHost, buildCleanUserAgent, isEmbeddedTab, PARTITION_PREFIX }
