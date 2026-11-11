'use strict'
/**
 * 动作可视化覆盖窗（M5，主进程）
 *
 * 为什么单独开一个窗口，而不是在面板 DOM 里叠一层覆盖层：
 * 内嵌模式下真实页面是 BrowserView —— 原生子视图，合成层级永远在窗口 DOM 之上。
 * 面板里再高的 z-index 也压在页面底下，恰好在「页面画上来了」这个最需要看见动作的场合看不见。
 * owned 的透明子窗口是这里唯一稳妥的载体：浮在 BrowserView 之上，
 * 而且完全不进 Page.captureScreenshot —— Agent 自己看的画面里不会多出一个假鼠标。
 *
 * 三条纪律：
 * 1. focusable:false + setIgnoreMouseEvents(true)：覆盖窗既不抢焦点也不吞点击，
 *    用户在这个区域的鼠标操作必须原样落到页面上；
 * 2. 页面内容用内联 data URL：electron-builder 的 files 只收 electron 目录下的 .cjs，
 *    单独放一个 .html 不会被打进安装包（开发时正常、装完就白屏），所以样式与脚本都写在这里；
 * 3. 覆盖窗只负责「怎么画」，不判断「该不该画」：动作属于哪个标签页、是不是合成事件，
 *    全部由 browser-host 算好后传进来（见 emitGesture）。
 */

/** 覆盖层内部文档：只画东西，不接收任何输入 */
const OVERLAY_HTML = [
  '<!doctype html><html><head><meta charset="utf-8"><style>',
  'html,body{margin:0;padding:0;height:100%;background:transparent;overflow:hidden}',
  '*{pointer-events:none}',
  '#cursor{position:fixed;left:0;top:0;width:20px;height:26px;opacity:0;',
  'transition:transform 150ms cubic-bezier(.22,.61,.36,1),opacity 160ms linear;will-change:transform;z-index:3}',
  '#cursor.on{opacity:1}',
  '#cursor.syn path{fill:#f5a623;stroke:#5c3b00}',
  '.fx{position:fixed;left:0;top:0;z-index:2}',
  '.ripple{width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid #2f6fed;',
  'box-shadow:0 0 0 1px rgba(255,255,255,.7) inset;animation:ct-ripple 520ms cubic-bezier(.2,.7,.3,1) forwards}',
  '.ripple.syn{border-color:#f5a623}',
  '.box{width:70px;height:70px;margin:-35px 0 0 -35px;border:2px dashed rgba(47,111,237,.85);border-radius:10px;',
  'background:rgba(47,111,237,.10);animation:ct-box 1300ms ease forwards}',
  '.box.syn{border-color:rgba(245,166,35,.9);background:rgba(245,166,35,.12)}',
  '.tag{margin:6px 0 0 10px;padding:2px 7px;border-radius:10px;font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;',
  'color:#fff;background:rgba(47,111,237,.92);box-shadow:0 1px 5px rgba(0,0,0,.28);white-space:nowrap;',
  'animation:ct-tag 1300ms ease forwards}',
  '.tag.syn{background:rgba(217,130,10,.95)}',
  '.arrow{margin:-14px 0 0 -9px;width:18px;height:28px;color:#2f6fed;font:700 18px/28px system-ui,sans-serif;',
  'text-align:center;text-shadow:0 1px 2px rgba(255,255,255,.85);animation:ct-arrow 720ms ease forwards}',
  '.arrow.syn{color:#d9820a}',
  '@keyframes ct-ripple{0%{transform:scale(.35);opacity:.95}100%{transform:scale(1.9);opacity:0}}',
  '@keyframes ct-box{0%{opacity:0;transform:scale(.82)}18%{opacity:1;transform:scale(1)}72%{opacity:1}100%{opacity:0}}',
  '@keyframes ct-tag{0%{opacity:0;transform:translateY(6px)}14%{opacity:1;transform:none}74%{opacity:1}100%{opacity:0;transform:translateY(-4px)}}',
  '@keyframes ct-arrow{0%{opacity:0}22%{opacity:1}100%{opacity:0;transform:translateY(10px)}}',
  '</style></head><body>',
  '<div id="cursor"><svg width="20" height="26" viewBox="0 0 20 26" xmlns="http://www.w3.org/2000/svg">',
  '<path d="M2 1 L2 20 L7.2 15.6 L10.6 23.4 L14 21.9 L10.6 14.4 L17 13.4 Z" fill="#ffffff" stroke="#101010" stroke-width="1.3" stroke-linejoin="round"/>',
  '</svg></div><div id="live"></div>',
  '<script>',
  'var CURSOR = document.getElementById("cursor");',
  'var LIVE = document.getElementById("live");',
  'var IDLE_MS = 2600;',
  'var idle = 0;',
  'var at = { x: 0, y: 0, has: false };',
  'function wake() { CURSOR.classList.add("on"); if (idle) clearTimeout(idle); idle = setTimeout(function () { CURSOR.classList.remove("on"); }, IDLE_MS); }',
  'function move(x, y) { at.x = x; at.y = y; at.has = true; CURSOR.style.transform = "translate(" + x + "px," + y + "px)"; }',
  'function fx(cls, x, y) { var el = document.createElement("div"); el.className = "fx " + cls;',
  'el.style.left = x + "px"; el.style.top = y + "px"; LIVE.appendChild(el);',
  'el.addEventListener("animationend", function () { if (el.parentNode) el.parentNode.removeChild(el); });',
  'setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2200); return el; }',
  'function point(g) { var x = Number(g.x), y = Number(g.y); return isFinite(x) && isFinite(y) ? { x: x, y: y } : (at.has ? at : { x: 0, y: 0 }); }',
  'window.__ctGesture = function (g) {',
  '  if (!g || !g.type) return;',
  '  CURSOR.classList.toggle("syn", g.synthetic === true);',
  '  var suffix = g.synthetic === true ? " syn" : "";',
  '  if (g.type === "click") { var c = point(g); move(c.x, c.y); wake(); fx("ripple" + suffix, c.x, c.y); return; }',
  '  if (g.type === "hover") { var h = point(g); move(h.x, h.y); wake(); fx("box" + suffix, h.x, h.y); return; }',
  '  if (g.type === "type") { var t = point(g); move(t.x, t.y); wake(); var te = fx("tag" + suffix, t.x, t.y);',
  '    te.textContent = g.synthetic === true ? "输入（示意）" : "输入内容"; return; }',
  '  if (g.type === "wheel") { var w = point(g); move(w.x, w.y); wake(); var we = fx("arrow" + suffix, w.x, w.y);',
  '    we.textContent = (Number(g.deltaX) > Math.abs(Number(g.deltaY))) ? "→" : ((Number(g.deltaY) < 0 ? "↑" : "↓")); return; }',
  '  if (g.type === "key") { var k = point(g); if (at.has) move(k.x, k.y); wake();',
  '    var ke = fx("tag" + suffix, at.has ? at.x : k.x, at.has ? at.y : k.y);',
  '    ke.textContent = "键 " + String(g.key || ""); }',
  '};',
  'window.__ctReset = function () { LIVE.textContent = ""; CURSOR.classList.remove("on", "syn"); };',
  '</script></body></html>'
].join('')

const OVERLAY_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(OVERLAY_HTML)

/**
 * @param deps.BrowserWindow Electron BrowserWindow 构造器（测试里可以换成假的）
 * @param deps.getWindow () => BrowserWindow | null  主窗口
 */
function createBrowserOverlay(deps) {
  const BrowserWindow = deps.BrowserWindow
  const getWindow = deps.getWindow || (() => null)

  let win = null
  /** 面板区域（主窗口内容区 DIP 坐标）；null 表示此刻没有该画的东西 */
  let box = null
  /** 建窗失败（平台不支持透明窗口等）后彻底闭嘴，不要每个动作都去试一次 */
  let enabled = true
  /** 覆盖层文档还没加载完时暂存的动作，页面就绪后一次性补画 */
  let pending = []
  let parentWired = null

  function originOf(parent) {
    try {
      const cb = parent.getContentBounds()
      return { x: cb.x, y: cb.y }
    } catch {
      return null
    }
  }

  function place() {
    if (!win || win.isDestroyed() || !box) return
    const parent = getWindow()
    if (!parent || parent.isDestroyed()) return
    const origin = originOf(parent)
    if (!origin) return
    try {
      win.setBounds({
        x: origin.x + Math.round(box.x),
        y: origin.y + Math.round(box.y),
        width: Math.max(2, Math.round(box.width)),
        height: Math.max(2, Math.round(box.height))
      }, false)
    } catch { /* 父窗口正在销毁 */ }
  }

  /**
   * 跟随主窗口的生命周期。
   * owned 窗口本来就会跟着父窗口移动，但最小化/隐藏时系统未必会藏它 ——
   * 一个飘在桌面上的透明空窗口比看不见更难解释，所以这里显式管住。
   */
  function wireParent(parent) {
    if (!parent || parent.isDestroyed() || parentWired === parent) return
    parentWired = parent
    const follow = () => place()
    const onHide = () => { if (win && !win.isDestroyed()) win.hide() }
    const onShow = () => { if (box) showQuietly() }
    parent.on('resize', follow)
    parent.on('move', follow)
    parent.on('minimize', onHide)
    parent.on('hide', onHide)
    parent.on('restore', onShow)
    parent.on('show', onShow)
    parent.once('closed', () => { if (win && !win.isDestroyed()) win.close() })
  }

  function showQuietly() {
    if (!win || win.isDestroyed() || !box) return
    try {
      place()
      if (!win.isVisible()) win.showInactive()
      // setIgnoreMouseEvents 在部分平台上会被 show 重置，每次显示后重新确认一次
      win.setIgnoreMouseEvents(true)
    } catch { /* 平台不支持透明覆盖窗：退化为只有面板文字提示 */ }
  }

  function create() {
    const parent = getWindow()
    if (!parent || parent.isDestroyed() || !BrowserWindow) return null
    try {
      win = new BrowserWindow({
        parent,
        width: Math.max(2, Math.round(box.width)),
        height: Math.max(2, Math.round(box.height)),
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        focusable: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          devTools: false,
          spellcheck: false
        }
      })
    } catch {
      enabled = false
      win = null
      return null
    }
    try { win.setIgnoreMouseEvents(true) } catch { /* 不支持则该窗口不收鼠标事件，本就不该收 */ }
    win.webContents.loadURL(OVERLAY_URL)
    win.once('did-finish-load', () => {
      const queued = pending
      pending = []
      for (const g of queued) send(g)
    })
    // 覆盖层自己出问题时（渲染进程崩了）宁可整个关掉，也不要留个残影骗人
    win.webContents.once('render-process-gone', () => { enabled = false; destroy() })
    wireParent(parent)
    return win
  }

  function send(gesture) {
    if (!win || win.isDestroyed()) return
    if (win.webContents.isLoading()) {
      // 只留最近几个：过期的动作补画出来反而会误导「Agent 正在点这里」
      if (pending.length >= 6) pending.shift()
      pending.push(gesture)
      return
    }
    try {
      const p = win.webContents.executeJavaScript(
        'window.__ctGesture && window.__ctGesture(' + JSON.stringify(gesture) + ')', true)
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch { /* 文档没准备好：下一个动作会再来 */ }
  }

  function destroy() {
    pending = []
    if (win && !win.isDestroyed()) {
      try { win.destroy() } catch { /* 已经没了 */ }
    }
    win = null
  }

  return {
    /**
     * 面板区域变了。
     * @param next 新的矩形；传 null 表示面板收起 / 页面已从界面卸下，覆盖层一起藏起来
     */
    setBounds(next) {
      if (!next || !Number.isFinite(Number(next.width)) || !Number.isFinite(Number(next.height))) {
        box = null
        pending = []
        if (win && !win.isDestroyed() && win.isVisible()) win.hide()
        return false
      }
      if (!enabled) return false
      box = {
        x: Math.round(Number(next.x) || 0),
        y: Math.round(Number(next.y) || 0),
        width: Math.round(Number(next.width)),
        height: Math.round(Number(next.height))
      }
      if (!win || win.isDestroyed()) {
        if (!create()) return false
      }
      showQuietly()
      return true
    },

    /** 画一个动作。调用方必须已经把「该不该画」判断清楚（活动标签页、是否越界） */
    gesture(gesture) {
      if (!enabled || !box || !gesture || !gesture.type) return false
      if (!win || win.isDestroyed()) return false
      if (!win.isVisible()) return false
      send(gesture)
      return true
    },

    /** 只藏不清区域：主窗口最小化时用，恢复后还能接着画 */
    hide() {
      pending = []
      if (win && !win.isDestroyed() && win.isVisible()) win.hide()
    },

    dispose() {
      destroy()
      box = null
    },

    /** 给回归测试与排查用：不暴露窗口对象本身 */
    info() {
      return {
        enabled,
        visible: !!(win && !win.isDestroyed() && win.isVisible()),
        box: box ? { ...box } : null,
        queued: pending.length
      }
    }
  }
}

module.exports = { createBrowserOverlay, OVERLAY_URL }
