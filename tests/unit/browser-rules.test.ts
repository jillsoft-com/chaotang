/**
 * 浏览器宿主纯规则层测试（内嵌浏览器 M1）
 *
 * 覆盖 electron/browser-rules.cjs：白名单匹配、点击坐标换算、
 * AX 树扁平化、可见性分级。这些判定是内嵌浏览器最容易出错的部分，
 * 拆成纯函数后可以直接在 Node 里断言，不需要 Electron。
 */

import { describe, it, expect } from 'vitest'
// @ts-ignore - 主进程 CommonJS 模块
import rules from '../../electron/browser-rules.cjs'

describe('normalizeHost / hostOf', () => {
  it('剥掉协议、路径与端口并转小写', () => {
    expect(rules.normalizeHost('HTTPS://Example.COM:8443/a/b')).toBe('example.com')
    expect(rules.normalizeHost('  example.com  ')).toBe('example.com')
    expect(rules.normalizeHost('')).toBe('')
    expect(rules.normalizeHost(null)).toBe('')
  })

  it('非法 URL 返回空串', () => {
    expect(rules.hostOf('not a url')).toBe('')
    expect(rules.hostOf('https://example.com/x')).toBe('example.com')
  })
})

describe('hostMatchesPolicy', () => {
  const allow = { allowlistEnabled: true, allowlist: ['Example.com'] }

  it('未开启白名单时一律放行', () => {
    expect(rules.hostMatchesPolicy('https://anything.io', null)).toBe(true)
    expect(rules.hostMatchesPolicy('https://anything.io', { allowlistEnabled: false, allowlist: [] })).toBe(true)
  })

  it('精确匹配与子域匹配', () => {
    expect(rules.hostMatchesPolicy('https://example.com/x', allow)).toBe(true)
    expect(rules.hostMatchesPolicy('https://a.example.com/', allow)).toBe(true)
  })

  it('不放行形似后缀的域', () => {
    expect(rules.hostMatchesPolicy('https://notexample.com', allow)).toBe(false)
    expect(rules.hostMatchesPolicy('https://example.com.evil.io', allow)).toBe(false)
  })

  it('非法地址视为拒绝', () => {
    expect(rules.hostMatchesPolicy('javascript:alert(1)', allow)).toBe(false)
  })

  it('忽略空白名单条目', () => {
    expect(rules.hostMatchesPolicy('https://example.com', { allowlistEnabled: true, allowlist: ['', '  '] })).toBe(false)
  })
})

describe('isHttpUrl 与 evaluate 禁止项', () => {
  it('只放行 http/https', () => {
    expect(rules.isHttpUrl('http://a.com')).toBe(true)
    expect(rules.isHttpUrl('https://a.com')).toBe(true)
    expect(rules.isHttpUrl('file:///C:/x')).toBe(false)
    expect(rules.isHttpUrl('javascript:alert(1)')).toBe(false)
  })

  it('拒绝触碰 Node 与模块系统', () => {
    expect(rules.containsForbiddenApi('require("fs")')).toBe(true)
    expect(rules.containsForbiddenApi('import("x")')).toBe(true)
    expect(rules.containsForbiddenApi('process.exit()')).toBe(true)
    expect(rules.containsForbiddenApi('globalThis.foo')).toBe(false)
    expect(rules.containsForbiddenApi('document.title')).toBe(false)
  })
})

describe('clampViewportSize', () => {
  it('区间内取整返回', () => {
    expect(rules.clampViewportSize(1280.4, 720.6)).toEqual({ ok: true, width: 1280, height: 721 })
  })

  it('越界拒绝', () => {
    expect(rules.clampViewportSize(100, 400).ok).toBe(false)
    expect(rules.clampViewportSize(1280, 100).ok).toBe(false)
    expect(rules.clampViewportSize(0, 0).ok).toBe(false)
  })
})

describe('clickPointFromRect', () => {
  it('取元素中心且不做 DPR 换算', () => {
    expect(rules.clickPointFromRect({ x: 10, y: 20, width: 100, height: 40 }))
      .toEqual({ ok: true, x: 60, y: 40 })
  })

  it('尺寸为 0 视为不可点', () => {
    const r = rules.clickPointFromRect({ x: 1, y: 1, width: 0, height: 0 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('ELEMENT_NOT_VISIBLE')
  })

  it('几何信息缺失时报错', () => {
    expect(rules.clickPointFromRect(null).ok).toBe(false)
    expect(rules.clickPointFromRect({ x: NaN, y: 0, width: 10, height: 10 }).ok).toBe(false)
  })
})

describe('isPointInViewport', () => {
  it('视口内为真', () => {
    expect(rules.isPointInViewport({ x: 100, y: 100 }, { width: 800, height: 600 })).toBe(true)
  })

  it('越界为假（元素滚出可视区时不能盲发事件）', () => {
    expect(rules.isPointInViewport({ x: 900, y: 10 }, { width: 800, height: 600 })).toBe(false)
    expect(rules.isPointInViewport({ x: -1, y: 10 }, { width: 800, height: 600 })).toBe(false)
    expect(rules.isPointInViewport({ x: 10, y: 10 }, null)).toBe(false)
  })
})

describe('flattenAxTree', () => {
  it('按 childIds 还原缩进层级', () => {
    const nodes = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: '标题' }, childIds: ['2', '3'] },
      { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: 'idle' } },
      { nodeId: '3', parentId: '1', role: { value: 'button' }, name: { value: 'press me' } }
    ]
    expect(rules.flattenAxTree(nodes)).toBe('[RootWebArea] 标题\n  [heading] idle\n  [button] press me')
  })

  it('ignored 节点不输出但子节点保留层级', () => {
    const nodes = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 't' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', ignored: true, role: { value: 'generic' }, childIds: ['3'] },
      { nodeId: '3', parentId: '2', role: { value: 'button' }, name: { value: 'ok' } }
    ]
    expect(rules.flattenAxTree(nodes)).toBe('[RootWebArea] t\n  [button] ok')
  })

  it('缺 name 或 role 的节点跳过', () => {
    expect(rules.flattenAxTree([{ nodeId: '1', role: { value: 'generic' }, childIds: [] }])).toBe('')
    expect(rules.flattenAxTree(null)).toBe('')
    expect(rules.flattenAxTree([])).toBe('')
  })

  it('环形引用不会死循环', () => {
    const nodes = [
      { nodeId: '1', role: { value: 'a' }, name: { value: 'A' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { value: 'b' }, name: { value: 'B' }, childIds: ['1'] }
    ]
    expect(rules.flattenAxTree(nodes)).toBe('[a] A\n  [b] B')
  })
})

describe('limitText', () => {
  it('超长截断并标记', () => {
    const r = rules.limitText('x'.repeat(30), 20)
    expect(r.text).toHaveLength(20)
    expect(r.truncated).toBe(true)
  })

  it('未超长不标记', () => {
    expect(rules.limitText('abc', 20)).toEqual({ text: 'abc', truncated: false })
  })
})

describe('resolveCapability', () => {
  // 以下判定逐格对应真事件矩阵探针的实测结论：只信「页面里收到的事件」，
  // 不信 CDP 命令的返回值。四位能力的失效边界各不相同，不能打包成一个关卡。

  it('未挂载：键盘仍可送达，滚轮/点击/截图都不行', () => {
    const v = rules.resolveCapability({ mounted: false, windowVisible: true, minimized: false, width: 900, height: 600 })
    expect(v.level).toBe('detached')
    expect(v).toMatchObject({ canKey: true, canWheel: false, canClick: false, canCapture: false, canDom: true })
  })

  it('已挂载且窗口可见：四位能力全通', () => {
    const v = rules.resolveCapability({ mounted: true, windowVisible: true, minimized: false, width: 900, height: 600 })
    expect(v).toMatchObject({ level: 'visible', canKey: true, canWheel: true, canClick: true, canCapture: true })
    expect(v.clickHint).toBe('')
    expect(v.captureHint).toBe('')
  })

  it('最小化：键盘滚动照旧，点击与截图失效', () => {
    const v = rules.resolveCapability({ mounted: true, minimized: true, windowVisible: true, width: 900, height: 600 })
    expect(v.level).toBe('minimized')
    expect(v).toMatchObject({ canKey: true, canWheel: true, canClick: false, canCapture: false })
    expect(v.clickHint).toContain('最小化')
  })

  it('显示过又被藏起来：抑制点击与截图', () => {
    const v = rules.resolveCapability({ mounted: true, windowVisible: false, width: 900, height: 600 })
    expect(v.level).toBe('hidden')
    expect(v).toMatchObject({ canWheel: true, canClick: false, canCapture: false })
  })

  it('从未显示的 ghost 宿主不算被藏起来：鼠标事件不该被误抑制', () => {
    const v = rules.resolveCapability({ mounted: true, windowVisible: false, everShown: false, width: 900, height: 600 })
    expect(v).toMatchObject({ level: 'visible', canClick: true, canCapture: true, canWheel: true })
  })

  it('零尺寸：有表面但没有命中目标，只有键盘例外', () => {
    const v = rules.resolveCapability({ mounted: true, windowVisible: true, width: 1, height: 600 })
    expect(v.level).toBe('zero-size')
    expect(v).toMatchObject({ canKey: true, canWheel: false, canClick: false, canCapture: false })
  })

  it('离屏挂载：出帧不依赖可见性，但鼠标点击到不了页面', () => {
    const v = rules.resolveCapability({ mounted: true, offscreen: true, windowVisible: false, width: 900, height: 600 })
    expect(v).toMatchObject({ canCapture: true, canClick: false, canWheel: true, canKey: true })
    expect(v.captureHint).toBe('')
  })

  it('离屏 + 最小化：画面仍出帧，点击仍失效', () => {
    const v = rules.resolveCapability({ mounted: true, offscreen: true, minimized: true, width: 900, height: 600 })
    expect(v.level).toBe('minimized')
    expect(v).toMatchObject({ canCapture: true, canClick: false, canWheel: true })
  })

  it('reason 与 hint 分开给：退化路径要对各自的位说各自的话', () => {
    const v = rules.resolveCapability({ mounted: true, windowVisible: true, width: 900, height: 600 })
    expect(v.reason).toBe('')
    expect(v.wheelHint).toBe('')
  })

  it('旧名字 resolveVisibility 是同一个函数', () => {
    expect(rules.resolveVisibility).toBe(rules.resolveCapability)
  })
})

describe('pickIframeTarget', () => {
  it('只挑 iframe 类型且 URL 命中', () => {
    const infos = [
      { type: 'page', url: 'https://example.com/' },
      { type: 'iframe', url: 'https://other.io/' },
      { type: 'iframe', url: 'https://EXAMPLE.com/embed' }
    ]
    expect(rules.pickIframeTarget(infos, 'example.com').url).toBe('https://EXAMPLE.com/embed')
    expect(rules.pickIframeTarget(infos, 'nope')).toBeNull()
    expect(rules.pickIframeTarget(null, 'x')).toBeNull()
  })
})

describe('常量表', () => {
  it('按键白名单与键码表一致', () => {
    for (const key of rules.ALLOWED_KEYS) {
      expect(rules.KEY_CODE_TABLE[key]).toBeDefined()
      expect(rules.KEY_CODE_TABLE[key].windowsVirtualKeyCode).toBeGreaterThan(0)
    }
    expect(rules.KEY_CODE_TABLE['KeyA']).toBeUndefined()
  })
})

// ============ 安全（M6） ============

describe('normalizeVersion / buildUserAgent', () => {
  it('版本串整成四段，拿不准时退回真实 Chrome 120', () => {
    expect(rules.normalizeVersion('120')).toBe('120.0.0.0')
    expect(rules.normalizeVersion('118.0.5993.88')).toBe('118.0.5993.88')
    expect(rules.normalizeVersion('1.2.3.4.5')).toBe('1.2.3.4')
    expect(rules.normalizeVersion('abc')).toBe('120.0.6099.109')
    expect(rules.normalizeVersion('')).toBe('120.0.6099.109')
  })

  it('拼出的 UA 不含 Electron 痕迹', () => {
    const ua = rules.buildUserAgent('120.0.6099.109', 'win32')
    expect(ua).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.109 Safari/537.36')
    for (const s of [ua, rules.buildUserAgent('120', 'darwin'), rules.buildUserAgent('120', 'linux')]) {
      expect(s).not.toMatch(/Electron|chaotang/i)
    }
    // 平台认不出来时退回 linux，不能留下 undefined
    expect(rules.buildUserAgent('120', 'freebsd')).toContain('X11; Linux x86_64')
  })
})

describe('buildClientHints', () => {
  const hints = rules.buildClientHints({ chromeVersion: '120.0.6099.109', platform: 'win32', arch: 'x64' })

  it('品牌列表没有 Electron，major 与 fullVersion 对齐', () => {
    expect(JSON.stringify(hints.metadata)).not.toMatch(/Electron/i)
    expect(hints.metadata.brands.map(b => b.brand)).toEqual([rules.NOT_BRAND, 'Chromium', 'Google Chrome'])
    expect(hints.metadata.brands.every(b => /^[0-9]+$/.test(b.version))).toBe(true)
    expect(hints.metadata.brands[1].version).toBe('120')
    expect(hints.metadata.fullVersion).toBe('120.0.6099.109')
    expect(hints.metadata.mobile).toBe(false)
    expect(hints.metadata.platform).toBe('Windows')
    expect(hints.metadata.architecture).toBe('x86')
    expect(hints.metadata.model).toBe('')
  })

  it('arm64 只影响 architecture 字段', () => {
    expect(rules.buildClientHints({ chromeVersion: '120', platform: 'darwin', arch: 'arm64' }).metadata.architecture).toBe('arm')
  })

  it('请求头形式与 Chrome 一致（ua-platform 带引号、mobile 为 ?0）', () => {
    expect(hints.headers['sec-ch-ua']).toContain(`"${rules.NOT_BRAND}";v="8"`)
    expect(hints.headers['sec-ch-ua-mobile']).toBe('?0')
    expect(hints.headers['sec-ch-ua-platform']).toBe('"Windows"')
    expect(hints.headers['user-agent']).toBe(hints.userAgent)
  })
})

describe('applyClientHintHeaders', () => {
  const hints = rules.buildClientHints({ chromeVersion: '120.0.6099.109', platform: 'win32' })

  it('只改写已有的头，键名大小写不同也能命中', () => {
    const r = rules.applyClientHintHeaders({
      'Sec-CH-UA': '"Electron";v="33", "Chromium";v="120"',
      'sec-ch-ua-platform': '"macOS"',
      accept: '*/*'
    }, hints)
    expect(r.changed).toBe(true)
    expect(r.headers['Sec-CH-UA']).toBe(hints.headers['sec-ch-ua'])
    expect(r.headers['sec-ch-ua-platform']).toBe('"Windows"')
    expect(r.headers.accept).toBe('*/*')
    expect(JSON.stringify(r.headers)).not.toMatch(/Electron/i)
  })

  it('原本没带的 Client Hints 不无中生有', () => {
    const r = rules.applyClientHintHeaders({ accept: '*/*' }, hints)
    expect(r.changed).toBe(false)
    expect(Object.keys(r.headers)).toEqual(['accept'])
  })

  it('空输入不抛异常', () => {
    expect(rules.applyClientHintHeaders(null, hints)).toEqual({ headers: {}, changed: false })
    expect(rules.applyClientHintHeaders({ a: 'b' }, null)).toEqual({ headers: { a: 'b' }, changed: false })
  })
})

describe('navigationAllowed', () => {
  it('非 http(s) 无条件拒绝，与白名单开关无关', () => {
    for (const bad of ['mailto:a@b.com', 'file:///C:/x', 'javascript:alert(1)']) {
      const r = rules.navigationAllowed(bad, { allowlistEnabled: false, allowlist: [] })
      expect(r.ok).toBe(false)
      expect(r.kind).toBe('protocol')
    }
  })

  it('白名单关闭时 http(s) 放行', () => {
    expect(rules.navigationAllowed('https://example.com', { allowlistEnabled: false, allowlist: [] }))
      .toEqual({ ok: true, reason: '', kind: '' })
  })

  it('白名单开启时越界域名给出可展示的原因', () => {
    const r = rules.navigationAllowed('https://evil.io/x', { allowlistEnabled: true, allowlist: ['example.com'] })
    expect(r.ok).toBe(false)
    expect(r.kind).toBe('allowlist')
    expect(r.reason).toContain('evil.io')
  })
})

describe('blockedRequestTypes / requestBlocked', () => {
  const base = { allowlistEnabled: true, allowlist: ['example.com'] }
  const strict = { ...base, strictAllowlist: true }

  it('分级：关闭不拦、开启拦子框架、严格再拦长期通道', () => {
    expect(rules.blockedRequestTypes({ allowlistEnabled: false })).toEqual([])
    expect(rules.blockedRequestTypes(base)).toEqual(['subFrame'])
    // 用的是 Electron 的类型名（实测 xhr / webSocket），不是 webRequest 规范里那套小写下划线名
    expect(rules.blockedRequestTypes(strict)).toContain('xhr')
    expect(rules.blockedRequestTypes(strict)).toContain('webSocket')
    // 规范名作为兜底保留：哪天 Electron 改了映射仍然拦得住
    expect(rules.blockedRequestTypes(strict)).toContain('xmlhttprequest')
    expect(rules.blockedRequestTypes(strict)).toContain('websocket')
  })

  it('白名单外的 iframe 被拦，图片脚本不动', () => {
    expect(rules.requestBlocked({ url: 'https://evil.io/embed', resourceType: 'subFrame' }, base, {})).toBe(true)
    expect(rules.requestBlocked({ url: 'https://evil.io/x.png', resourceType: 'image' }, base, {})).toBe(false)
    expect(rules.requestBlocked({ url: 'https://evil.io/a.js', resourceType: 'script' }, base, {})).toBe(false)
  })

  it('同源 XHR 不拦，否则页面瘫掉；严格模式也不破这条', () => {
    const opts = { mainFrameUrl: 'https://example.com/page' }
    expect(rules.requestBlocked({ url: 'https://example.com/api', resourceType: 'xhr' }, strict, opts)).toBe(false)
    expect(rules.requestBlocked({ url: 'https://other.io/api', resourceType: 'xhr' }, strict, opts)).toBe(true)
    expect(rules.requestBlocked({ url: 'https://other.io/api', resourceType: 'xhr' }, base, opts)).toBe(false)
    expect(rules.requestBlocked({ url: 'wss://other.io/live', resourceType: 'webSocket' }, strict, opts)).toBe(true)
    // 同源 WebSocket 也是正经生意：不能当成“跳出白名单”
    expect(rules.requestBlocked({ url: 'wss://example.com/live', resourceType: 'webSocket' }, strict, opts)).toBe(false)
    expect(rules.requestBlocked({ url: 'wss://other.io/live', resourceType: 'webSocket' }, base, opts)).toBe(false)
  })

  it('非 http 地址里只有会离机的才拦：子框架与 WebSocket', () => {
    expect(rules.requestBlocked({ url: 'file:///C:/x', resourceType: 'subFrame' }, base, {})).toBe(true)
    expect(rules.requestBlocked({ url: 'data:text/html,hi', resourceType: 'subFrame' }, base, {})).toBe(true)
    expect(rules.requestBlocked({ url: 'ws://other.io/live', resourceType: 'webSocket' }, strict, { mainFrameUrl: 'https://example.com/' })).toBe(true)
    // 严格模式下把 blob:/data: 一起拦掉，只会让正常页面的本地资源也打不开
    expect(rules.requestBlocked({ url: 'blob:https://example.com/x', resourceType: 'other' }, strict, { mainFrameUrl: 'https://example.com/' })).toBe(false)
  })

  it('白名单关闭时一律放行（兼容旧行为）', () => {
    expect(rules.requestBlocked({ url: 'https://evil.io/e', resourceType: 'subFrame' }, null, {})).toBe(false)
    expect(rules.requestBlocked(null, strict, {})).toBe(false)
  })
})

describe('holdDecision', () => {
  it('接管期只放行取数类动作', () => {
    for (const a of ['state', 'snapshot', 'query', 'evaluate', 'screenshot', 'frame-evaluate', 'tab-list']) {
      expect(rules.holdDecision(a).allowed).toBe(true)
    }
  })

  it('接管期拦住写操作并给出下一步', () => {
    for (const a of ['click', 'type', 'navigate', 'scroll', 'keyboard', 'hover']) {
      const d = rules.holdDecision(a)
      expect(d.allowed).toBe(false)
      expect(d.error).toContain('MANUAL_HOLD')
      expect(d.hint).toContain('接管')
    }
    expect(rules.holdDecision('').allowed).toBe(false)
    expect(rules.holdDecision(undefined).allowed).toBe(false)
  })
})

describe('controlPlaneRefused / isUserDrivingAction', () => {
  it('控制面动作对 Agent 拒接，取数与页面动作不受影响', () => {
    for (const a of ['set-policy', 'set-hold', 'set-auto-raise', 'set-bounds', 'viewport', 'detach', 'attach']) {
      const r = rules.controlPlaneRefused(a)
      expect(r).not.toBeNull()
      expect(r!.error).toContain('SECURITY_CONTROL')
      expect(rules.CONTROL_PLANE_ACTIONS.has(a)).toBe(true)
    }
    for (const a of ['state', 'navigate', 'click', 'tab-open', 'close']) {
      expect(rules.controlPlaneRefused(a)).toBeNull()
    }
    expect(rules.controlPlaneRefused(undefined)).toBeNull()
  })

  it("用户在开车的那几个动作会触发自动上锁", () => {
    for (const a of ['click', 'type', 'keyboard', 'hover', 'scroll', 'navigate', 'reload', 'mouse-wheel']) {
      expect(rules.isUserDrivingAction(a)).toBe(true)
    }
    // 取数与控制面不算“开车”：面板切标签页、报尺寸不应该把 Agent 锁住
    for (const a of ['state', 'snapshot', 'query', 'tab-list', 'set-bounds', 'detach', 'set-hold']) {
      expect(rules.isUserDrivingAction(a)).toBe(false)
    }
    expect(rules.isUserDrivingAction(undefined)).toBe(false)
  })
})

describe('isUserInputEvent', () => {
  it('只认新的按下事件', () => {
    expect(rules.isUserInputEvent({ type: 'keyDown' })).toBe(true)
    expect(rules.isUserInputEvent({ type: 'mouseDown' })).toBe(true)
    expect(rules.isUserInputEvent({ type: 'keyUp' })).toBe(false)
    expect(rules.isUserInputEvent({ type: 'char' })).toBe(false)
    expect(rules.isUserInputEvent(null)).toBe(false)
  })

  it('按住不放与 CDP 输入窗口内都不算接管意图', () => {
    expect(rules.isUserInputEvent({ type: 'keyDown', isAutoRepeat: true })).toBe(false)
    expect(rules.isUserInputEvent({ type: 'keyDown' }, { withinCdpWindow: true })).toBe(false)
  })
})
