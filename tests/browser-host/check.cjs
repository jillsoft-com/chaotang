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
 * 这些结论同时是 M3~M6 的设计前提，改宿主前先看这里是否还全绿。
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

  const broadcasts = []
  const host = createBrowserHost({
    BrowserView,
    session,
    getWindow: () => win,
    broadcast: (channel, payload) => broadcasts.push(channel)
  })

  const results = {}
  const call = async (label, action, params) => {
    const res = await host.handle(action, params)
    results[label] = res
    log('>>', label, res.success ? 'OK' : 'ERR', res.error || '', res.visibility || '', res.bytes || '')
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

  // ============ 画面与三态降级 ============
  await call('shot jpeg', 'screenshot', { type: 'jpeg', quality: 60 })
  await call('shot png', 'screenshot', { type: 'png' })
  await call('shot full', 'screenshot', { fullPage: true })
  await call('query all', 'query', { selector: 'a', all: true })
  await call('detach', 'detach', {})
  await call('shot detached', 'screenshot', {})
  await call('click background', 'click', { selector: '#btn' })
  await call('read background click', 'query', { selector: '#target' })
  await call('click background strict', 'click', { selector: '#btn', jsFallback: false })
  await call('eval background', 'evaluate', { expression: 'document.title' })
  await call('wheel background', 'scroll', { deltaY: 200 })
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
  // 未挂载时 Input.dispatch* 实测会随机静默失效甚至超时，宿主必须退化为 JS 合成事件
  expect('收起后点击退化为 JS 合成', results['click background'].fallback === true)
  expect('JS 合成点击确实打到元素', (results['read background click'].result || '').includes('clicked:false'))
  expect('退化时如实标注可信度', (results['click background'].warning || '').includes('isTrusted'))
  expect('拒绝退化时返回 NEED_SURFACE', /NEED_SURFACE/.test(results['click background strict'].error || ''))
  expect('收起后仍可后台取数', results['eval background'].success === true)
  expect('后台滚轮走 JS 兜底', results['wheel background'].fallback === true)
  expectSurface('重新挂载后可截图', (results['shot attached'].data || '').length > 5000)
  expect('面板隐藏不擅自画回界面', /CAPTURE_UNAVAILABLE/.test(results['shot panel hidden'].error || ''))
  expectSurface('面板恢复后自动唤前台', results['auto raise'].success === true)

  // ============ 最小化 ============
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

  // ============ 关闭 ============
  await call('close', 'close', {})
  await call('state closed', 'state', {})
  await call('shot no tab', 'screenshot', {})

  expect('关闭后无标签页', (results['state closed'].tabs || []).length === 0)
  expect('关闭后截图报错而非挂死', results['shot no tab'].success === false)

  // ============ 能力边界探针（宿主之外的独立验证）============
  await probeDetachedCapabilities(base)

  log('BROADCAST COUNT', broadcasts.length, '| browser-gesture:', broadcasts.filter(c => c === 'browser-gesture').length)
  const failed = CHECKS.filter(c => !c.pass)
  log('TOTAL', CHECKS.length, 'FAILED', failed.length, 'SKIPPED', skipped)
  for (const f of failed) log('FAILED ->', f.name, '|', f.actual)
  if (skipped) log('NOTE | 本轮有', skipped, '条需要画面的断言未验证，不要当作通过')

  server.close()
  app.exit(failed.length ? 1 : 0)
}

/**
 * 直接对着 webContents.debugger 验证「未挂载时哪些 CDP 命令还能用」。
 * 结论决定 browser-host 把「输入」和「画面」拆成两套门槛。
 */
async function probeDetachedCapabilities(base) {
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
  expectSurface('挂载中：点击生效（可信事件）', await ev('document.getElementById("target").textContent'), 'clicked:true')

  win2.removeBrowserView(view)
  await new Promise(r => setTimeout(r, 400))

  // 下面四项不做断言：未挂载时 Input.dispatch* 的行为不稳定（时而静默失效、时而一去不回直接超时），
  // 宿主不依赖它，后台一律退化为 JS 合成事件。这里只记录观察值，供排查时参考。
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
  log('OBSERVE | 未挂载按键 |', await guard(async () => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' })
    await new Promise(r => setTimeout(r, 200))
    return await ev('String(window.__lastKey)')
  }))

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
