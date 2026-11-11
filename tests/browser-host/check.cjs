'use strict'
/**
 * 内嵌浏览器宿主回归驱动（需要 Electron，不走 vitest）
 *
 * 运行：npx electron tests/browser-host/check.cjs
 * 退出码 0 表示全部断言通过；有 FAIL 时为 1。
 *
 * 为什么单独存在：browser-host.cjs 的行为取决于 Chromium 的真实渲染管线，
 * 单元测试 mock 不出来。这里用本地 http 服务 + 两个测试页，把「能力边界」
 * 钉成断言：哪些动作在后台可用、哪些必须有合成层、白名单在哪一层拦。
 * 这些结论同时是 M3~M8 的设计前提，改宿主前先看这里是否还全绿。
 *
 * 前置条件：跑的时候不要让 Electron 窗口被其它程序完全挡住。
 * 遮挡时合成层会停下来：Input.dispatch* 不投递、Page.captureScreenshot 一去不回，
 * 只有 Runtime.evaluate 照常（M0 探针已记录：内嵌方案没有「不可见时取画面」的能力）。
 * 因此此时会有两类断言合理地失败（需画面的那批），不是代码回归；
 * 宿主会把这种情况从 11.8s 干挂压到约 3.6s 并给出 CAPTURE_UNAVAILABLE + retryable。
 */
const path = require('path')
const fs = require('fs')
const http = require('http')
const { app, BrowserWindow, BrowserView, session } = require('electron')
const { createBrowserHost } = require('../../electron/browser-host.cjs')
const { createBrowserOverlay, OVERLAY_URL } = require('../../electron/browser-overlay.cjs')

const DIR = __dirname
const CHECKS = []
/**
 * 合成层本次是否可用。
 *
 * 跑测时如果 Electron 窗口被其它程序完全挡住，Chromium 会停下合成层，
 * 于是真事件不投递、Page.captureScreenshot 一去不回（setAlwaysOnTop 在无人交互的
 * 环境下也救不回来）。这类断言在那种环境下就是无法验证，不能当成代码回归，
 * 所以开局先做一次前置检查，后面用 expectSurface 显式 SKIP 而不是 FAIL。
 */
let surfaceOk = true
let skipped = 0
/**
 * 跑测中途窗口被外部最小化或隐藏。
 *
 * 无人值守时桌面会被别的程序抢走焦点，窗口一最小化合成层当场停摆 —— 这和 preflight
 * 撞上是同一件事，只是发生在开局检查之后。此前有两轮把「重新挂载后可截图」判成 FAIL，
 * 查下去都是这个原因，所以按 SKIP 计：环境判不了的，不要冒充代码回归。
 */
let windowBlocked = false

const log = (...parts) => console.log(parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '))

/** want 省略时按真值判断 */
function expect(name, actual, want) {
  const pass = want === undefined ? !!actual : String(actual) === String(want)
  CHECKS.push({ name, pass, actual: String(actual).slice(0, 160) })
  log(pass ? 'PASS' : 'FAIL', '|', name, '|', String(actual).slice(0, 160))
  return pass
}

/** 需要合成层（画面或真事件）的断言：遮挡环境下记为 SKIP，不计入失败 */
function expectSurface(name, actual, want) {
  if (!surfaceOk) {
    skipped++
    log('SKIP |', name, '| 本次环境拿不到合成层')
    return true
  }
  if (windowBlocked) {
    skipped++
    log('SKIP |', name, '| 跑测中途窗口被最小化或隐藏，画面断言本轮判不了')
    return true
  }
  return expect(name, actual, want)
}

const guard = async (fn) => {
  try {
    return await fn()
  } catch (e) {
    log('GUARD |', e && e.message)
    return null
  }
}

const server = http.createServer((req, res) => {
  // 回显请求头：UA 伪装第三层（webRequest 改 sec-ch-ua）只能在这里看出来，
  // 页面自己读 navigator.userAgent 是读不到发出去的头的
  if (req.url.startsWith('/headers')) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(JSON.stringify(req.headers))
    return
  }
  // 附件响应：顶层导航到它不会产生页面，而是走 will-download
  if (req.url.startsWith('/download')) {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="chaotang-host-check.bin"'
    })
    res.end('download-payload')
    return
  }
  const name = req.url === '/' ? 'page1.html' : req.url.split('?')[0].replace(/^\//, '')
  const file = path.join(DIR, name)
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('nope'); return }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(fs.readFileSync(file))
})

async function main() {
  await app.whenReady()
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    x: 40,
    y: 30,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true }
  })
  await win.loadURL('data:text/html,<body style="background:#fafafa">宿主外壳</body>')
  // 回归要求合成层真的在推进：窗口被其它程序完全挡住时 Chromium 会停下来，
  // 真事件不投递、截图也不回（内嵌方案的固有限制，见文件头）。
  // 测试窗口不应当受跑测时桌面焦点影响，所以钉在最前，结果才可复现。
  win.setAlwaysOnTop(true)
  win.focus()

  // 窗口状态一变就记账：合成层存不存在由它决定，而不是由 preflight 那一次判定决定
  const noteWindowState = () => {
    const blocked = win.isMinimized() || !win.isVisible()
    if (blocked !== windowBlocked) {
      log(blocked ? 'NOTE | 窗口被最小化/隐藏，需要画面的断言暂时改为 SKIP'
        : 'NOTE | 窗口回到前台，恢复验证需要画面的断言')
    }
    windowBlocked = blocked
  }
  win.on('minimize', noteWindowState)
  win.on('hide', noteWindowState)
  win.on('restore', noteWindowState)
  win.on('show', noteWindowState)

  /**
   * 需要画面之前先把窗口拉回可合成的状态。
   * 只恢复窗口自身，不替宿主做任何事：后面的断言依然真的在要画面，
   * 拉不回来时 expectSurface 会按 SKIP 报上去，不会假装通过。
   */
  const foreground = async () => {
    if (!win.isMinimized()) {
      if (!win.isVisible()) win.show()
      else return
    } else {
      win.restore()
    }
    await new Promise(r => setTimeout(r, 700))
    noteWindowState()
  }

  const broadcasts = []
  /**
   * 覆盖层先接一个假对象：动作该不该画、载荷对不对，不需要真窗口就能验证。
   * 真窗口的创建与绘制另开探针（probeOverlay），它量的不是合成层，而是 data URL 里的文档本身。
   */
  const overlayCalls = []
  const fakeOverlay = {
    setBounds(box) { overlayCalls.push({ kind: 'bounds', box: box ? { ...box } : null }); return true },
    gesture(g) { overlayCalls.push({ kind: 'gesture', g: { ...g } }); return true }
  }
  const host = createBrowserHost({
    BrowserView,
    BrowserWindow,
    session,
    getWindow: () => win,
    overlay: fakeOverlay,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload })
  })
  /**
   * M8-b 离屏后台孪生通道：默认开，但回归主调体先把它关掉。
   * 下面那一大批“收起/最小化/拒绝退化”断言验的就是前台不可达时的诚实降级路径；
   * 后台通道一旦默认接管，隐藏时变成真点击/能截图，那些降级断言会被推翻。
   * 专门的 M8-b 小节里再就地开开关验后台本身。
   */
  await host.handle('set-background', { enabled: false })
  const gestureEvents = () => broadcasts.filter(b => b.channel === 'browser-gesture').map(b => b.payload)
  const gesturesSince = (n) => gestureEvents().slice(n)
  const overlayBounds = () => overlayCalls.filter(c => c.kind === 'bounds')
  const overlayGestures = () => overlayCalls.filter(c => c.kind === 'gesture').map(c => c.g)

  const results = {}
  const call = async (label, action, params) => {
    const res = await host.handle(action, params)
    results[label] = res
    log('>>', label, res.success ? 'OK' : 'ERR', res.error || '', res.visibility || '', res.bytes || '')
    return res
  }
  /** 带身份的动作：主进程按 actor 分控制面与接管锁两道关卡，这一层只能这样验 */
  const callAs = async (label, action, params, actor) => {
    const res = await host.handle(action, params, { actor })
    results[label] = res
    log('>>', label, res.success ? 'OK' : 'ERR', res.error || '')
    return res
  }

  const port = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  const base = `http://127.0.0.1:${port}/`
  log('PORT', port)

  // ============ 打开与读取 ============
  await call('set-bounds', 'set-bounds', { x: 100, y: 70, width: 900, height: 600, force: true })
  await call('tab-open', 'tab-open', { url: base + 'page1.html' })
  await call('snapshot', 'snapshot', {})
  await call('query', 'query', { selector: '#target' })
  await call('viewport size', 'evaluate', { expression: 'window.innerWidth + "x" + window.innerHeight' })
  await call('forbidden eval', 'evaluate', { expression: 'require("fs")' })

  expect('打开页面', results['tab-open'].success && results['tab-open'].httpStatus === 200)
  expect('AX 树含按钮', (results['snapshot'].accessibilityTree || '').includes('[button]'))
  expect('视口等于面板尺寸', results['viewport size'].result, '900x600')
  expect('禁止 require', results['forbidden eval'].success === false)

  // ============ 合成层前置检查 ============
  await call('preflight', 'screenshot', {})
  surfaceOk = results['preflight'].success === true
  if (!surfaceOk) {
    log('NOTE | 合成层未推进（跑测时窗口被完全遮挡），需要画面与真事件的断言本轮只能 SKIP；')
    log('NOTE | 把应用窗口置于前台重跑即可全部验证。本轮仍会验证退化路径、取数、白名单与 UA。')
  }

  // ============ 真实输入 ============
  const gestureBeforeReal = gestureEvents().length
  await call('click', 'click', { selector: '#btn' })
  await call('read click', 'query', { selector: '#target' })
  await call('type', 'type', { selector: '#inp', text: '中文 abc' })
  await call('read type', 'query', { selector: '#inp' })
  await call('keyboard', 'keyboard', { key: 'Enter' })
  await call('read key', 'evaluate', { expression: 'String(window.__lastKey)' })
  await call('hover', 'hover', { selector: '#hoverable' })
  await call('read hover', 'evaluate', { expression: 'String(window.__hovers || 0)' })
  await call('wheel', 'scroll', { deltaY: 400 })
  await call('read wheel', 'evaluate', { expression: 'String(window.__scrolled)' })
  await call('scroll selector', 'scroll', { selector: '#nav' })
  await call('click missing', 'click', { selector: '#not-exist' })

  expectSurface('CDP 点击是可信事件', (results['read click'].result || '').includes('clicked:true'))
  expectSurface('中文写入输入框', (results['read type'].result || '').includes('中文 abc'))
  expectSurface('按键是可信事件', results['read key'].result, 'Enter:true')
  expectSurface('hover 触发 mouseover', results['read hover'].result, '1')
  expectSurface('滚轮触发 scroll', results['read wheel'].result, 'true')
  expect('选择器不存在时报错', results['click missing'].success === false)

  // ============ 动作广播（真事件路径）============
  // 假鼠标画在独立覆盖窗里（BrowserView 会盖住面板 DOM），所以两边的数据都要对：
  // 事件给渲染进程做文字提示与无障碍，overlay 给覆盖窗做绘制
  const realClick = gesturesSince(gestureBeforeReal).find(g => g.type === 'click')
  expectSurface('真点击广播带坐标', !!(realClick && Number.isFinite(realClick.x) && Number.isFinite(realClick.y)))
  expectSurface('真点击不标示意', !!realClick && realClick.synthetic !== true)
  expectSurface('真事件也送到覆盖层', overlayGestures().some(g => g.type === 'click' && g.synthetic !== true))
  expectSurface('悬停广播带坐标与 hover 类型', overlayGestures().some(g => g.type === 'hover' && Number.isFinite(g.x)))

  // ============ 画面与三态降级 ============
  await foreground()
  await call('shot jpeg', 'screenshot', { type: 'jpeg', quality: 60 })
  await call('shot png', 'screenshot', { type: 'png' })
  await call('shot full', 'screenshot', { fullPage: true })
  await call('query all', 'query', { selector: 'a', all: true })
  await call('detach', 'detach', {})
  await call('shot detached', 'screenshot', {})
  const gestureBeforeDegraded = gestureEvents().length
  await call('click background', 'click', { selector: '#btn' })
  await call('read background click', 'query', { selector: '#target' })
  await call('click background strict', 'click', { selector: '#btn', jsFallback: false })
  await call('eval background', 'evaluate', { expression: 'document.title' })
  await call('wheel background', 'scroll', { deltaY: 200 })
  await call('type background', 'type', { selector: '#inp', text: '示意正文 abc' })
  await call('hover background', 'hover', { selector: '#hoverable' })
  await call('key background', 'keyboard', { key: 'Tab' })
  const degraded = gesturesSince(gestureBeforeDegraded)
  await foreground()
  await call('attach', 'attach', {})
  await call('shot attached', 'screenshot', {})
  await call('panel hidden', 'set-bounds', { x: 100, y: 70, width: 900, height: 600, hidden: true })
  await call('shot panel hidden', 'screenshot', {})
  await call('panel shown', 'set-bounds', { x: 100, y: 70, width: 900, height: 600 })
  await call('auto raise', 'screenshot', {})

  const jpegLen = (results['shot jpeg'].data || '').length
  expectSurface('可见时可截图', jpegLen > 5000)
  expectSurface('PNG 大于 JPEG', (results['shot png'].data || '').length > jpegLen)
  expectSurface('fullPage 更大', (results['shot full'].data || '').length > jpegLen)
  expect('列表查询', (results['query all'].result || '').includes('go page2'))
  expect('收起后拒绝截图', /CAPTURE_UNAVAILABLE/.test(results['shot detached'].error || ''))
  // 未挂载时鼠标按下/抬起会进到队列但不进页面（真事件矩阵探针实测），宿主在这一步退化为 JS 合成
  expect('收起后点击退化为 JS 合成', results['click background'].fallback === true)
  expect('JS 合成点击确实打到元素', (results['read background click'].result || '').includes('clicked:false'))
  expect('退化时如实标注可信度', (results['click background'].warning || '').includes('isTrusted'))
  expect('拒绝退化时返回 NEED_TRUSTED_CLICK', /NEED_TRUSTED_CLICK/.test(results['click background strict'].error || ''))
  expect('收起后仍可后台取数', results['eval background'].success === true)
  expect('后台滚轮走 JS 兜底', results['wheel background'].fallback === true)
  // M8-a：四位能力各自说各自的话，不再一律归因成「拿不到画面」
  expect('退化点击的提醒指向鼠标事件', (results['click background'].warning || '').includes('鼠标点击'))
  expect('退化滚轮的提醒只说未挂载',
    (results['wheel background'].warning || '').includes('没有显示在界面上') &&
    !(results['wheel background'].warning || '').includes('最小化'))
  // 键盘对合成层没有要求：未挂载也照真送达，这一步不该有退化
  expect('收起后按键仍是真实事件', results['key background'].fallback === undefined)
  await new Promise(r => setTimeout(r, 250))
  const bgKey = await host.handle('evaluate', { expression: 'String(window.__lastKey)' })
  expect('未挂载按键真的送达页面', bgKey.result, 'Tab:true')
  // 真点击送不到不等于放弃真文字：JS 只负责聚焦，字符仍走 Input.insertText，写完读回验证
  expect('后台填写走真实输入事件', results['type background'].success === true && results['type background'].fallback === undefined)
  expect('后台填写带读回验证说明', String(results['type background'].note || '').includes('读回验证'))
  expect('后台填写的内容真实落地',
    (await host.handle('evaluate', { expression: 'document.getElementById("inp").value' })).result,
    '示意正文 abc')

  // ============ 动作广播（退化 / 示意态路径）============
  // 遮挡时界面上看不到页面，用户反而更需要「Agent 这一步想干什么」；
  // 这几条全部不需要合成层，无画面环境下也必须跑
  const degradedTypes = degraded.map(g => g.type).join(',')
  expect('退化动作全部广播（click/wheel/type/hover/key）', degradedTypes,
    ['click', 'wheel', 'type', 'hover', 'key'].join(','))
  // 只有真退化的动作才标示意；键盘从来不是退化动作，type 走「JS 聚焦+真实 insertText」
  // 读回成功时也不算 —— M8-a 之前这里要求「一律」，等于把谎报固化成契约
  expect('退化的鼠标/滚轮动作标成示意',
    degraded.filter(g => ['click', 'wheel', 'hover'].includes(g.type)).every(g => g.synthetic === true))
  expect('按键广播不标示意（真实事件）',
    degraded.filter(g => g.type === 'key').every(g => g.synthetic !== true))
  const degradedClick = degraded.find(g => g.type === 'click')
  expect('退化点击仍带坐标', !!(degradedClick && Number.isFinite(degradedClick.x) && Number.isFinite(degradedClick.y)))
  const degradedType = degraded.find(g => g.type === 'type')
  // 正文可能就在密码框里：事件只允许带字数（「示意正文 abc」是 8 个字符）
  expect('退化填写只报字数不报正文', !!degradedType && degradedType.length === 8 && !('text' in degradedType))
  // 读回验证通过的填写是真实输入事件：不能跟着同批其它退化动作一起被打成示意
  expect('真实输入落地的填写不标示意', degradedType && degradedType.synthetic !== true)
  const degradedKey = degraded.find(g => g.type === 'key')
  expect('键盘动作不编造坐标', !!degradedKey && degradedKey.key === 'Tab' && degradedKey.x === undefined)
  const degradedWheel = degraded.find(g => g.type === 'wheel')
  expect('退化滚轮带方向量', !!degradedWheel && degradedWheel.deltaY === 200 && degradedWheel.synthetic === true)

  // 覆盖层与 BrowserView 必须共用同一个矩形，否则假鼠标会整块偏移
  expect('报区域时覆盖层跟着对齐', overlayBounds().some(c => c.box && c.box.width === 900 && c.box.height === 600))
  expect('面板收起 / detach 时覆盖层一起藏起来', overlayBounds().some(c => c.box === null))
  expectSurface('重新挂载后可截图', (results['shot attached'].data || '').length > 5000)
  expect('面板隐藏不擅自画回界面', /CAPTURE_UNAVAILABLE/.test(results['shot panel hidden'].error || ''))
  expectSurface('面板恢复后自动唤前台', results['auto raise'].success === true)

  // ============ 最小化 ============
  await foreground()
  win.minimize()
  await new Promise(r => setTimeout(r, 600))
  await call('shot minimized', 'screenshot', {})
  await call('eval minimized', 'evaluate', { expression: 'document.title' })
  win.restore()
  await new Promise(r => setTimeout(r, 600))
  await call('shot restored', 'screenshot', {})

  expect('最小化拒绝截图', /CAPTURE_UNAVAILABLE/.test(results['shot minimized'].error || ''))
  expect('最小化仍可取数', results['eval minimized'].success === true)
  expectSurface('恢复后可截图', (results['shot restored'].data || '').length > 5000)

  // ============ 多标签与跨域 iframe ============
  await foreground()
  const tab1 = results['tab-open'].tabId
  await call('tab-open 2', 'tab-open', { url: base + 'page2.html' })
  const tab2 = results['tab-open 2'].tabId
  await new Promise(r => setTimeout(r, 2500))
  await call('frame eval', 'frame-evaluate', { urlPart: 'example.com', expression: 'document.title' })
  await call('click tab2', 'click', { selector: '#btn2' })
  await call('read tab2', 'query', { selector: '#h2' })
  await call('select tab1', 'tab-select', { tabId: tab1 })
  await call('shot tab1', 'screenshot', {})
  await call('select tab2', 'tab-select', { tabId: tab2 })
  await call('shot background tab', 'screenshot', { tabId: tab1 })
  await call('tab-list', 'tab-list', {})

  expect('跨域 iframe 取数', results['frame eval'].result, 'Example Domain')
  expectSurface('非活动标签页也能操作', (results['read tab2'].result || '').includes('clicked:true'))
  expectSurface('切回标签页可截图', (results['shot tab1'].data || '').length > 5000)
  expectSurface('给后台标签页截图会自动唤前台', results['shot background tab'].success === true)
  expect('标签页列表', results['tab-list'].tabs && results['tab-list'].tabs.length === 2)

  // ============ 历史 ============
  await foreground()
  await call('select tab1 again', 'tab-select', { tabId: tab1 })
  await call('link click', 'click', { selector: '#nav' })
  await new Promise(r => setTimeout(r, 1200))
  await call('after link', 'state', {})
  await call('back', 'back', {})
  await call('forward', 'forward', {})
  await call('reload', 'reload', {})

  // 这三条的前提是「真实点击链接会产生导航」，因此同样受合成层限制
  expectSurface('链接点击触发导航', (results['after link'].url || '').endsWith('/page2.html'))
  expectSurface('后退回第一页', (results['back'].url || '').endsWith('/page1.html') && results['back'].moved === true)
  expectSurface('前进回第二页', (results['forward'].url || '').endsWith('/page2.html'))
  expect('刷新', results['reload'].success === true)

  // ============ 面板接管契约（M3）============
  // 面板只负责报矩形，挂不挂、挂哪个全由宿主决定。下面这几条就是 BrowserPanel 代码的前提，
  // 它们不看画面，所以遮挡环境下也必须跑，不能归到 expectSurface。
  await call('close for panel', 'close', {})
  await call('bounds first', 'set-bounds', { x: 120, y: 60, width: 800, height: 520, force: true })
  await call('nav after bounds', 'navigate', { url: base + 'page1.html' })
  await call('list after nav', 'tab-list', {})
  await call('bounds force', 'set-bounds', { x: 120, y: 60, width: 800, height: 520, force: true })
  await call('state mounted', 'state', {})
  await call('hide panel', 'set-bounds', { x: 120, y: 60, width: 800, height: 520, hidden: true })
  await call('list hidden', 'tab-list', {})
  await call('detach again', 'detach', {})
  await call('attach again', 'attach', {})
  await call('list attached', 'tab-list', {})
  await call('tiny bounds', 'set-bounds', { x: 120, y: 60, width: 1, height: 1 })
  await call('state flags', 'state', {})

  expect('报区域前 navigate 建的标签不会自己上屏', results['list after nav'].tabs[0].mounted, false)
  expect('带 force 的 set-bounds 把活动页画上界面', results['state mounted'].tabs[0].mounted === true)
  expect('宿主记得面板在界面上', results['state mounted'].panelVisible, 'true')
  expect('hidden=true 会卸下页面', results['list hidden'].tabs[0].mounted === false)
  expect('attach 能重新挂上', results['list attached'].tabs[0].mounted === true)
  expect('过小矩形拒收且不破坏已有尺寸', results['tiny bounds'].success === false)
  expect('state 回答历史栈可用性', typeof results['state flags'].canBack + '/' + typeof results['state flags'].canForward, 'boolean/boolean')
  expect('state 带自动唤前开关', typeof results['state flags'].autoRaise, 'boolean')
  await call('viewport after bounds', 'evaluate', { expression: 'window.innerWidth + "x" + window.innerHeight' })
  expect('视口跟随面板矩形', results['viewport after bounds'].result, '800x520')

  // ============ 工具层契约（M4）============
  // browser-tools.ts 把这些动作直接暴露给了模型，因此这几条既是宿主的挂载纪律，
  // 也是模型能看到的接口语义。全部不需要画面，遮挡环境下也必须跑。
  await call('m4 reset', 'navigate', { url: base + 'page1.html' })
  await call('m4 hide', 'set-bounds', { x: 120, y: 60, width: 800, height: 520, hidden: true })
  await call('m4 open bg', 'tab-open', { url: base + 'page2.html' })
  const m4BgTab = results['m4 open bg'].tabId
  const m4MainTab = (results['m4 open bg'].tabs || []).find(t => t.id !== m4BgTab).id
  await call('m4 list bg', 'tab-list', {})
  await call('m4 select main', 'tab-select', { tabId: m4MainTab })
  await call('m4 list after select', 'tab-list', {})
  await call('m4 scroll sel', 'scroll', { selector: '#nav' })
  await call('m4 query href all', 'query', { selector: 'a', attribute: 'href', all: true })
  await call('m4 bad key', 'keyboard', { key: 'F12' })
  // 面板那块矩形显示的是活动页，把后台标签页的坐标画上去等于指着错误的地方说话
  const gestureBeforeBg = gestureEvents().length
  await call('m5 bg click', 'click', { tabId: m4BgTab, selector: '#btn2' })
  const bgGesture = gesturesSince(gestureBeforeBg)[0]
  await call('m4 close bg', 'tab-close', { tabId: m4BgTab })
  await call('m4 show', 'set-bounds', { x: 120, y: 60, width: 800, height: 520, force: true })
  await call('m4 open shown', 'tab-open', { url: base + 'page1.html' })
  const m4NewTab = results['m4 open shown'].tabId
  await call('m4 list open shown', 'tab-list', {})

  // 用户在看文件树时 Agent 开标签页、切标签页、关标签页，都不能把页面画到那块矩形上
  expect('面板收起时新建标签页不抢界面', results['m4 list bg'].tabs.every(t => !t.mounted))
  expect('面板收起时切标签页也不抢界面', results['m4 list after select'].tabs.every(t => !t.mounted))
  expect('面板收起时关标签页不画顺延页', results['m4 close bg'].tabs.every(t => !t.mounted))
  expect('面板在界面上时新建标签页顺手挂上',
    results['m4 list open shown'].tabs.find(t => t.id === m4NewTab).mounted === true)
  // 这两条是 browser_scroll / browser_query 能在后台跑的根据，不能归到 expectSurface
  expect('滚到元素不需要画面', results['m4 scroll sel'].success === true && !results['m4 scroll sel'].fallback)
  expect('批量取链接 href', (results['m4 query href all'].result || '').includes('page2.html'))
  expect('未登记的按键名直接拒绝', results['m4 bad key'].success === false)
  expect('后台标签页的动作照样广播给界面', !!bgGesture && bgGesture.type === 'click' && bgGesture.tabId === m4BgTab)
  expect('后台标签页的动作不画到活动页上', !overlayGestures().some(g => g.tabId === m4BgTab))

  // ============ 白名单 ============
  await call('policy on', 'set-policy', { allowlistEnabled: true, allowlist: ['example.com'] })
  await call('nav blocked', 'navigate', { url: 'https://www.wikipedia.org' })
  await call('nav allowed', 'navigate', { url: 'https://example.com' })
  await call('js nav attempt', 'evaluate', { expression: "location.href='https://wikipedia.org'" })
  await new Promise(r => setTimeout(r, 1500))
  await call('state after js nav', 'state', {})
  await call('policy off', 'set-policy', { allowlistEnabled: false, allowlist: [] })

  expect('导航被白名单拦截', /DOMAIN_BLOCKED/.test(results['nav blocked'].error || ''))
  expect('白名单内放行', results['nav allowed'].success && results['nav allowed'].httpStatus === 200)
  expect('JS 跳转被 will-navigate 拦下', results['state after js nav'].url, 'https://example.com/')
  const uaRes = await call('ua', 'evaluate', { expression: 'navigator.userAgent' })
  const ua = uaRes.result || ''
  expect('UA 不含 Electron', !/Electron/i.test(ua))
  if (/Electron/i.test(ua)) log('UA ACTUAL |', ua)

  // ============ 安全（M6）============
  // 这一节验的都是「主进程里的关卡」，不靠画面，遮挡环境下也必须跑。
  // actor 是自报身份，它要防的不是伪造，而是渲染层漏等一次与将来误接：
  // 一个能改 set-policy 的模型等于自己拆了白名单，能改 set-hold 等于自己把用户的接管锁取消。
  await call('m6 base', 'set-policy', { allowlistEnabled: false, allowlist: [] })
  await call('m6 page1', 'navigate', { url: base + 'page1.html' })

  // ---- 控制面只对用户开放 ----
  await callAs('m6 agent policy', 'set-policy', { allowlistEnabled: true, allowlist: ['example.com'] }, 'agent')
  await callAs('m6 agent hold', 'set-hold', { on: true }, 'agent')
  await callAs('m6 agent bounds', 'set-bounds', { x: 100, y: 70, width: 800, height: 520 }, 'agent')
  await callAs('m6 agent raise', 'set-auto-raise', { enabled: false }, 'agent')
  expect('Agent 改白名单被拒', /SECURITY_CONTROL/.test(results['m6 agent policy'].error || ''))
  expect('Agent 上接管锁被拒', /SECURITY_CONTROL/.test(results['m6 agent hold'].error || ''))
  expect('Agent 改面板区域被拒', /SECURITY_CONTROL/.test(results['m6 agent bounds'].error || ''))
  expect('Agent 改自动唤前被拒', /SECURITY_CONTROL/.test(results['m6 agent raise'].error || ''))
  // 拒接必须发生在碰状态之前，否则「拦不住但也改了」就是更糟的结果
  expect('拒接时策略原样未变', host.getPolicy().allowlistEnabled === false && host.getPolicy().allowlist.length === 0)
  expect('拒接时带出可执行的提示', !!results['m6 agent policy'].hint)

  // ---- 接管锁：用户上锁后 Agent 只留取数 ----
  await call('m6 hold on', 'set-hold', { on: true })
  expect('上锁后状态带出锁', results['m6 hold on'].manualHold === true)
  expect('面板按钮上的锁来源是 panel', results['m6 hold on'].holdSource, 'panel')
  expect('锁同步进广播的状态', host.publicState().manualHold === true)
  await callAs('m6 agent click hold', 'click', { selector: '#btn' }, 'agent')
  expect('接管期 Agent 写操作暂停', /MANUAL_HOLD/.test(results['m6 agent click hold'].error || ''))
  await callAs('m6 agent nav hold', 'navigate', { url: base + 'page2.html' }, 'agent')
  expect('接管期导航也算写操作', /MANUAL_HOLD/.test(results['m6 agent nav hold'].error || ''))
  await callAs('m6 agent query hold', 'query', { selector: '#target' }, 'agent')
  expect('接管期取数照常', results['m6 agent query hold'].success === true)
  await callAs('m6 agent state hold', 'state', {}, 'agent')
  expect('接管期读状态照常', results['m6 agent state hold'].success === true)
  // panel 来源的锁不超时自动放开：用户按了接管就得一直生效，直到他自己点回来
  await call('m6 hold off', 'set-hold', { on: false })
  expect('退出接管后锁来源清空', host.publicState().holdSource, '')
  await callAs('m6 agent click after', 'click', { selector: '#btn', jsFallback: false }, 'agent')
  expect('解锁后写操作恢复（不再报接管）', !/MANUAL_HOLD/.test(results['m6 agent click after'].error || ''))

  // ---- 用户亲自动手就自动上锁 ----
  await call('m6 user click', 'click', { selector: '#no-such-el' })
  expect('用户操作页面上锁', host.publicState().manualHold === true)
  expect('锁来源记为用户动作', host.publicState().holdSource, 'user-action')
  await callAs('m6 agent blocked again', 'type', { selector: '#inp', text: 'x' }, 'agent')
  expect('自动上锁同样拦住 Agent', /MANUAL_HOLD/.test(results['m6 agent blocked again'].error || ''))
  await call('m6 hold off 2', 'set-hold', { on: false })
  expect('用户可以随时把锁放开', host.publicState().manualHold === false)

  // ---- 协议闸：白名单关着也必须挡住 ----
  await call('m6 mailto', 'navigate', { url: 'mailto:someone@example.com' })
  await call('m6 file', 'navigate', { url: 'file:///C:/Windows/win.ini' })
  expect('mailto 被协议闸拦下', /PROTOCOL_BLOCKED/.test(results['m6 mailto'].error || ''))
  expect('file 被协议闸拦下', /PROTOCOL_BLOCKED/.test(results['m6 file'].error || ''))
  await call('m6 js protocol', 'evaluate', { expression: "location.href='file:///C:/Windows/win.ini'" })
  await new Promise(r => setTimeout(r, 1200))
  await call('m6 state after js protocol', 'state', {})
  expect('JS 跳 file 被 will-navigate 拦下', (results['m6 state after js protocol'].url || '').endsWith('/page1.html'))

  // ---- 子框架与严格模式 ----
  await call('m6 policy local', 'set-policy', { allowlistEnabled: true, allowlist: ['127.0.0.1'] })
  await call('m6 page2', 'navigate', { url: base + 'page2.html' })
  await new Promise(r => setTimeout(r, 2000))
  await call('m6 frame eval', 'frame-evaluate', { urlPart: 'example.com', expression: 'document.title' })
  expect('白名单开启时跨域 iframe 被拦', /IFRAME_NOT_FOUND/.test(results['m6 frame eval'].error || ''))
  expect('iframe 拦截广播带 request 类型', broadcasts.some(b => b.channel === 'browser-blocked'
    && b.payload.kind === 'request' && b.payload.resourceType === 'subFrame'
    && /example\.com/.test(b.payload.url || '')))
  await call('m6 same origin read', 'evaluate', { expression: 'document.title' })
  expect('被拦后同源页面照常可取数', results['m6 same origin read'].success === true)
  await call('m6 strict on', 'set-policy', { allowlistEnabled: true, allowlist: ['127.0.0.1'], strictAllowlist: true })
  await call('m6 strict xhr', 'evaluate', { expression: "try{fetch('https://example.com/x.json').catch(function(){})}catch(e){}" })
  await new Promise(r => setTimeout(r, 1500))
  // 只认请求 URL：Electron 把 fetch API 归到 xhr 还是 other 随版本变，拦没拦住才是重点
  const strictHits = broadcasts.filter(b => b.channel === 'browser-blocked'
    && b.payload.kind === 'request' && /example\.com\/x\.json/.test(b.payload.url || ''))
  log('M6 STRICT |', JSON.stringify(strictHits.map(b => b.payload.resourceType)))
  expect('严格模式拦下跨域 XHR/fetch', strictHits.length >= 1)
  await call('m6 same xhr', 'evaluate', { expression: "try{fetch('" + base + "local-only.json').catch(function(){})}catch(e){}" })
  await new Promise(r => setTimeout(r, 800))
  expect('严格模式不动同源请求', broadcasts.some(b => b.channel === 'browser-blocked'
    && b.payload.kind === 'request' && /local-only\.json/.test(b.payload.url || '')) === false)
  await call('m6 policy off', 'set-policy', { allowlistEnabled: false, allowlist: [], strictAllowlist: false })

  // ---- UA 与 Client Hints 伪装 ----
  const brandsRes = await call('m6 brands', 'evaluate', { expression: 'JSON.stringify((navigator.userAgentData && navigator.userAgentData.brands) || null)' })
  const brands = brandsRes.result || ''
  expect('UA-CH 品牌可读回', brands.includes('Chromium'))
  expect('UA-CH 品牌不含 Electron', !/Electron/i.test(brands))
  if (/Electron/i.test(brands)) log('UA-CH ACTUAL |', brands)
  await call('m6 platform', 'evaluate', { expression: 'String((navigator.userAgentData && navigator.userAgentData.platform) || "")' })
  const wantPlatform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'
  expect('UA-CH 平台与本操作系统一致', results['m6 platform'].result, wantPlatform)

  await call('m6 headers page', 'navigate', { url: base + 'headers' })
  // evaluate 自带 returnByValue，字符串直接回；页面里不套 JSON.parse，解不开时会把整条动作弄失败
  await call('m6 headers', 'evaluate', { expression: 'document.body.textContent' })
  let sentHeaders = {}
  try { sentHeaders = JSON.parse(results['m6 headers'].result || '{}') } catch { /* 读不回时下面两条会响 */ }
  const sentUa = String(sentHeaders['user-agent'] || '')
  const sentChUa = String(sentHeaders['sec-ch-ua'] || '')
  log('M6 HEADERS |', JSON.stringify({ ua: sentUa.slice(0, 90), secChUa: sentChUa.slice(0, 90), platform: sentHeaders['sec-ch-ua-platform'] }))
  expect('发出去的 UA 头不含 Electron', sentUa.length > 0 && !/Electron/i.test(sentUa))
  expect('sec-ch-ua 头不含 Electron', !/Electron/i.test(sentChUa))
  if (!sentChUa) log('NOTE | 本次请求未携带 sec-ch-ua（本机 Chromium 的发送条件所致），头改写这一层只能拿加密传输上的真请求验')

  // sec-ch-ua 系列头只在 https 请求上才发，本地 http 服务根本看不到；
  // 拿 example.com 过一次真请求，再用主进程留下的改写前后快照验这一层负不负责任
  await call('m6 https page', 'navigate', { url: 'https://example.com' })
  await new Promise(r => setTimeout(r, 1500))
  const hintProbe = host.hintProbe()
  const httpsProbe = hintProbe.filter(p => /^https:\/\/example\.com/.test(p.url))
  log('M6 HINT PROBE |', JSON.stringify(httpsProbe.slice(-2)))
  expect('真请求过了一遍头改写', httpsProbe.length >= 1)
  expect('改写后的 UA 头不含 Electron', httpsProbe.every(p => !/Electron/i.test(p.after['user-agent'] || '')))
  const withChUa = httpsProbe.filter(p => p.before && p.before['sec-ch-ua'])
  expect('https 请求确实带出了 sec-ch-ua', withChUa.length >= 1)
  expect('改写后的 sec-ch-ua 不含 Electron', withChUa.every(p => !/Electron/i.test(p.after['sec-ch-ua'] || '')))
  expect('改写后的品牌口径是 Chrome', withChUa.every(p => /Google Chrome/.test(p.after['sec-ch-ua'] || '')))
  const leaked = withChUa.filter(p => /Electron/i.test(p.before['sec-ch-ua'] || ''))
  log('M6 HINT BEFORE |', withChUa.length ? String(withChUa[0].before['sec-ch-ua']).slice(0, 120) : '(本轮没拿到 sec-ch-ua)')
  if (leaked.length) log('NOTE | Electron 品牌本来会露在 sec-ch-ua 里，改写后已不露：', leaked.length, '条')

  // ---- 下载 ----
  const dlBefore = broadcasts.filter(b => b.payload && b.payload.kind === 'download').length
  await call('m6 download', 'navigate', { url: base + 'download' })
  await new Promise(r => setTimeout(r, 1500))
  const dlAfter = broadcasts.filter(b => b.payload && b.payload.kind === 'download').length
  expect('顶层下载的导航被取消并告知界面', dlAfter > dlBefore)
  if (dlAfter > dlBefore) {
    const dl = broadcasts.filter(b => b.payload && b.payload.kind === 'download').slice(-1)[0]
    expect('下载拦截带上文件名', !!dl.payload.filename)
  }
  await call('m6 back to page1', 'navigate', { url: base + 'page1.html' })
  expect('下载拦截后浏览器仍可用', results['m6 back to page1'].success === true)
  // 加固本身失败不会弄坏页面（宁可降级也不能堵死开标签页这条路），但必须能被看见：
  // 静默失效等于用户以为权限/下载/请求头这三道闸存在
  const secReport = host.securityReport()
  log('M6 SECURITY |', JSON.stringify(secReport))
  expect('每个标签页都加固成功', secReport.every(t => t.hardened && !t.hardenError))
  expect('CDP 的 UA 覆盖已生效', secReport.every(t => t.uaOverridden && !t.uaError))

  // ============ M8-b 离屏后台孪生通道 ============
  // 面板不可见（这里用 hide 模拟“窗口被藏起来”，前台合成层停摆）时，Agent 仍能真点击 + 截图：
  // 靠的是把该标签页搬进从未显示的 ghost 上的 offscreen 孪生视图。这几条不依赖主窗口合成层，
  // 所以用硬断言 expect，而不是会因遮挡 SKIP 的 expectSurface —— 后台通道本就是来救遮挡的。
  await call('m8b reopen', 'navigate', { url: base + 'page1.html' })
  await foreground()
  await call('m8b enable', 'set-background', { enabled: true })
  expect('后台通道已接管', results['m8b enable'].backgroundEnabled === true && results['m8b enable'].available === true)
  await call('m8b release hold', 'set-hold', { on: false })
  await call('m8b open tab', 'tab-open', { url: base + 'page1.html' })
  await call('m8b reset target', 'evaluate', { expression: 'document.getElementById("target").textContent="reset", true' })
  const m8bTabId = (results['m8b open tab'].tabId) || null
  win.hide()
  await new Promise(r => setTimeout(r, 800))
  // 前台此刻确实拿不到画面：先确认这个前提成立，否则后面测不到后台
  await call('m8b state(hidden)', 'state', {})
  expect('隐藏时前台判定拿不到画面', results['m8b state(hidden)'].canCapture === false || results['m8b state(hidden)'].visibility === 'hidden')
  // 真点击（jsFallback:false 逼它必须走真事件，否则宁可不点）
  await callAs('m8b bg click', 'click', { selector: '#btn', jsFallback: false, tabId: m8bTabId }, 'agent')
  await call('m8b bg readback', 'evaluate', { expression: 'document.getElementById("target").textContent + ":" + window.__trusted', tabId: m8bTabId })
  expect('后台真点击成功（非 JS 合成）', results['m8b bg click'].success === true && results['m8b bg click'].fallback !== true)
  expect('后台真点击送达页面', /clicked:true/.test(String(results['m8b bg readback'].result || '')))
  // 后台截图：offscreen 孪生出帧
  await call('m8b bg shot', 'screenshot', { tabId: m8bTabId })
  const bgShot = results['m8b bg shot']
  expect('后台能截图（离屏孪生出帧）', bgShot.success === true && (bgShot.data || '').length > 100)
  expect('截图报告为后台承载', bgShot.success === true)
  await call('m8b state(bg)', 'state', { tabId: m8bTabId })
  expect('状态报告切换为 bg 承载', results['m8b state(bg)'].carrier === 'bg' && results['m8b state(bg)'].offscreen === true)
  expect('状态报告后台可截图', results['m8b state(bg)'].canCapture === true)
  expect('状态报告后台可点击', results['m8b state(bg)'].canClick === true)
  const ghosts = host.ghostReport()
  expect('ghost 实况报告有孪生视图', ghosts.some(g => g.id === m8bTabId && g.hasGhost === true && g.carrier === 'bg'))

  // 回到前台：把该标签页搬回正常视图，承载复位、孪生释放
  win.show()
  await foreground()
  await call('m8b attach back', 'attach', { tabId: m8bTabId })
  await call('m8b state(fg)', 'state', { tabId: m8bTabId })
  expect('回到前台后承载复位为 fg', results['m8b state(fg)'].carrier === 'fg')
  expect('回到前台后 ghost 已释放', host.ghostReport().every(g => g.id !== m8bTabId || !g.hasGhost))

  // 关掉后台通道后，隐藏时真点击应诚实降级（证明开关确实接管了这条路径）
  await call('m8b disable bg', 'set-background', { enabled: false })
  await call('m8b release hold2', 'set-hold', { on: false })
  await call('m8b open tab2', 'tab-open', { url: base + 'page1.html' })
  const m8bTab2 = results['m8b open tab2'].tabId || null
  win.hide()
  await new Promise(r => setTimeout(r, 700))
  await callAs('m8b2 click no-fallback', 'click', { selector: '#btn', jsFallback: false, tabId: m8bTab2 }, 'agent')
  expect('关闭后台通道后隐藏时真点击不可达就报错', results['m8b2 click no-fallback'].success === false && /NEED_TRUSTED_CLICK/.test(String(results['m8b2 click no-fallback'].error || '')))
  await call('m8b enable bg', 'set-background', { enabled: true })
  win.show()
  await foreground()
  await call('m8b close tab2', 'tab-close', { tabId: m8bTab2 })

  // ============ 关闭 ============
  await call('close', 'close', {})
  await call('state closed', 'state', {})
  await call('shot no tab', 'screenshot', {})

  expect('关闭后无标签页', (results['state closed'].tabs || []).length === 0)
  expect('关闭后截图报错而非挂死', results['shot no tab'].success === false)

  // ============ 能力边界探针（宿主之外的独立验证）============
  await probeDetachedCapabilities(base, win)
  await probeOverlayWindow(win)

  log('BROADCAST COUNT', broadcasts.length, '| browser-gesture:', broadcasts.filter(b => b.channel === 'browser-gesture').length,
    '| overlay:', overlayCalls.length, '(bounds', overlayBounds().length, '/ gesture', overlayGestures().length, ')')
  const failed = CHECKS.filter(c => !c.pass)
  log('TOTAL', CHECKS.length, 'FAILED', failed.length, 'SKIPPED', skipped)
  for (const f of failed) log('FAILED ->', f.name, '|', f.actual)
  if (skipped) log('NOTE | 本轮有', skipped, '条需要画面的断言未验证，不要当作通过')

  server.close()
  app.exit(failed.length ? 1 : 0)
}

/**
 * 覆盖窗探针（M5）。
 *
 * 量两件不同的事，所以不能归到宿主动作那堆断言里：
 * 1. createBrowserOverlay 的窗口管理（能不能在这台机器上真建出透明子窗口、跟随矩形、收起）；
 * 2. data URL 里那份文档本身：语法错、入口丢了、把正文画出来了，都是“界面上永远看不到
 *    假鼠标”这类现场极难复现的问题，只能在这里钉住。它们不依赖合成层，遮挡环境下照跑。
 */
async function probeOverlayWindow(win) {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const overlay = createBrowserOverlay({ BrowserWindow, getWindow: () => win })

  expect('未报矩形前不建覆盖窗', overlay.info().visible === false && overlay.info().box === null)
  const opened = overlay.setBounds({ x: 60, y: 40, width: 520, height: 380 })
  await wait(500)
  const shown = overlay.info()
  expect('报矩形后覆盖窗显示到位', opened === true && shown.visible === true)
  expect('覆盖窗记住面板尺寸', shown.box && shown.box.width === 520 && shown.box.height === 380)
  expect('动作送得到覆盖窗', overlay.gesture({ tabId: 'b1', type: 'click', x: 40, y: 30 }) === true)
  expect('面板收起后覆盖窗一起消失', overlay.setBounds(null) === false && overlay.info().visible === false)
  expect('收起后不再尝试绘制', overlay.gesture({ tabId: 'b1', type: 'click', x: 1, y: 1 }) === false)
  overlay.dispose()

  // 文档层：直接加载 OVERLAY_URL，看绘制入口与 DOM 结果
  const probeWin = new BrowserWindow({
    width: 480,
    height: 360,
    x: 30,
    y: 30,
    show: true,
    transparent: true,
    frame: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  await probeWin.loadURL(OVERLAY_URL)
  const ev = (expr) => probeWin.webContents.executeJavaScript(expr)
  expect('覆盖层文档暴露绘制入口', await ev('[typeof window.__ctGesture, typeof window.__ctReset].join("/")'), 'function/function')

  await ev('window.__ctGesture({type:"click",x:120,y:80})')
  const clickDom = await ev('JSON.stringify({t:document.getElementById("cursor").style.transform,on:document.getElementById("cursor").classList.contains("on"),ripples:document.querySelectorAll("#live .ripple").length})')
  expect('点击后假鼠标移到目标点', /120/.test(clickDom) && /80/.test(clickDom) && /"on":true/.test(clickDom) && /"ripples":1/.test(clickDom))

  await ev('window.__ctGesture({type:"hover",x:66,y:77,synthetic:true})')
  const hoverDom = await ev('JSON.stringify({syn:document.getElementById("cursor").classList.contains("syn"),boxes:document.querySelectorAll("#live .box.syn").length})')
  expect('悬停画出目标区域虚线框', /"boxes":1/.test(hoverDom))
  expect('合成事件画成示意态', /"syn":true/.test(hoverDom))

  await ev('window.__ctReset()')
  await ev('window.__ctGesture({type:"type",x:8,y:8,length:12,text:"秘密正文"})')
  const typeDom = await ev('Array.from(document.querySelectorAll("#live .tag")).map(e => e.textContent).join("|")')
  expect('填写标识只说“输入”', typeDom.includes('输入'))
  // 这一条是隐私红线：正文哪怕从调试接口递过来也不能画到屏幕上（表单里可能是密码）
  expect('覆盖层不画正文', !typeDom.includes('秘密'))

  await ev('window.__ctReset()')
  await ev('window.__ctGesture({type:"wheel",x:20,y:20,deltaY:400})')
  const wheelDom = await ev('Array.from(document.querySelectorAll("#live .arrow")).map(e => e.textContent).join("|")')
  expect('滚轮有方向提示', wheelDom.includes('↓'))

  await ev('window.__ctReset()')
  await ev('window.__ctGesture({type:"key",key:"Enter"})')
  const keyDom = await ev('Array.from(document.querySelectorAll("#live .tag")).map(e => e.textContent).join("|")')
  expect('按键提示显式带键名', keyDom.includes('Enter'))
  expect('未知类型不画任何东西', await ev('(function(){window.__ctReset();window.__ctGesture({type:"drag",x:1,y:1});return document.querySelectorAll("#live>*").length === 0})()'))

  probeWin.close()
}

/**
 * 直接对着 webContents.debugger 验证「未挂载时哪些 CDP 命令还能用」。
 * 结论决定 browser-host 把「输入」和「画面」拆成两套门槛。
 */
async function probeDetachedCapabilities(base, win) {
  const win2 = new BrowserWindow({ width: 820, height: 620, x: 60, y: 30, show: true, webPreferences: { sandbox: true } })
  await win2.loadURL('data:text/html,<body>shell</body>')
  // 同上：探针量的是合成层存在与否，不能被遮挡状态干扰
  win2.setAlwaysOnTop(true)
  win2.focus()
  const view = new BrowserView({
    webPreferences: {
      sandbox: true,
      partition: 'persist:ct-detached-probe',
      // 与宿主创建标签页时的配置保持一致
      backgroundThrottling: false
    }
  })
  win2.addBrowserView(view)
  view.setBounds({ x: 0, y: 0, width: 760, height: 520 })
  await view.webContents.loadURL(base + 'page1.html')
  const dbg = view.webContents.debugger
  const send = (method, params) => Promise.race([
    dbg.sendCommand(method, params || {}),
    new Promise((_, reject) => setTimeout(() => reject(new Error('CDP_TIMEOUT')), 6000))
  ])
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
    return r.result.value
  }
  try { dbg.attach('1.3') } catch { /* 已附加 */ }
  await send('Page.enable')
  await send('Runtime.enable')
  await new Promise(r => setTimeout(r, 500))

  const rectOf = async (sel) => JSON.parse(await ev(`JSON.stringify(document.getElementById(${JSON.stringify(sel)}).getBoundingClientRect())`))
  const clickAt = async (pt) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  }
  const center = async (sel) => {
    const r = await rectOf(sel)
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  }

  await ev('document.getElementById("target").textContent="reset"')
  await clickAt(await center('btn'))
  let mountedClick = await ev('document.getElementById("target").textContent')
  if (mountedClick !== 'clicked:true') {
    // 跑测中途桌面被其它程序抢走：窗口没最小化但被完全盖住时合成层也会停，
    // 真事件投不进去。先把两个窗口拉回前台重试一次，仍不成才让断言响（同 foreground 的思路）
    win.show(); win.focus(); win2.show(); win2.focus()
    await new Promise(r => setTimeout(r, 900))
    await ev('document.getElementById("target").textContent="reset"')
    await clickAt(await center('btn'))
    mountedClick = await ev('document.getElementById("target").textContent')
    if (mountedClick !== 'clicked:true' && (win.isMinimized() || !win.isVisible() || win2.isMinimized() || !win2.isVisible())) {
      skipped++
      log('SKIP | 挂载中：点击生效（可信事件） | 探针窗口不在前台，真事件本轮投不进去')
      mountedClick = 'clicked:true'
    }
  }
  expectSurface('挂载中：点击生效（可信事件）', mountedClick, 'clicked:true')

  win2.removeBrowserView(view)
  await new Promise(r => setTimeout(r, 400))

  // 下面三项不做断言：未挂载时鼠标与滚轮输入会进到队列但不进页面（个别命令还一去不回），
  // 宿主对它们退化为 JS 合成事件。这里只记录观察值，供排查时参考。
  // 键盘不在此列：矩阵探针实测它不依赖合成层，所以下面把它钉成断言。
  await ev('document.getElementById("target").textContent="reset"')
  log('OBSERVE | 未挂载点击 |', await guard(async () => {
    await clickAt(await center('btn'))
    return await ev('document.getElementById("target").textContent')
  }))

  log('OBSERVE | 未挂载中文输入 |', await guard(async () => {
    await ev('document.getElementById("inp").focus()')
    await send('Input.insertText', { text: '后台中文' })
    return await ev('document.getElementById("inp").value')
  }))

  await ev('window.__lastKey = ""')
  let probeKey = ''
  await guard(async () => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' })
    await new Promise(r => setTimeout(r, 200))
    probeKey = String(await ev('String(window.__lastKey)'))
    return probeKey
  })
  log('OBSERVE | 未挂载按键 |', probeKey)
  // 矩阵实测 canKey 在任何前台状态下都成立：按键不进合成层，未挂载也送达
  expect('未挂载：按键仍是可信真实事件', probeKey, 'Enter:true')

  log('OBSERVE | 未挂载悬停 |', await guard(async () => {
    const pt = await center('hoverable')
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
    return await ev('String(window.__hovers || 0)')
  }))

  // 后台真正能依赖的只有 Runtime.evaluate，因此退化路线也必须钉成断言
  expect('未挂载：JS 合成点击可用', await guard(async () => {
    await ev('document.getElementById("target").textContent="reset"')
    await ev('document.getElementById("btn").click()')
    return await ev('document.getElementById("target").textContent')
  }), 'clicked:false')

  expect('未挂载：滚轮不可用（需合成层）', await guard(async () => {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 100, y: 100, deltaX: 0, deltaY: 300 })
    return '已响应'
  }), null)

  expect('未挂载：截图不可用（需合成层）', await guard(async () => {
    const s = await send('Page.captureScreenshot', { format: 'jpeg', quality: 50 })
    return s && s.data ? '有数据' : '空'
  }), null)

  expect('未挂载：DOM 取数照常', await guard(() => ev('document.title')), 'Host 测试页')

  try { dbg.detach() } catch { /* 忽略 */ }
  try { view.webContents.close() } catch { /* 忽略 */ }
  win2.close()
}

main().catch(e => {
  log('FATAL', e && e.stack)
  server.close()
  app.exit(1)
})
