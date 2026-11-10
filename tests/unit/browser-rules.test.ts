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

describe('resolveVisibility', () => {
  it('未挂载时仍可读写 DOM 但不能截图', () => {
    const v = rules.resolveVisibility({ mounted: false, windowVisible: true, minimized: false, width: 900, height: 600 })
    expect(v.level).toBe('detached')
    expect(v.canCapture).toBe(false)
    expect(v.canDom).toBe(true)
  })

  it('最小化优先于尺寸判定', () => {
    expect(rules.resolveVisibility({ mounted: true, minimized: true, width: 900, height: 600 }).level).toBe('minimized')
  })

  it('窗口隐藏与零尺寸分别给出提示', () => {
    expect(rules.resolveVisibility({ mounted: true, windowVisible: false }).level).toBe('hidden')
    expect(rules.resolveVisibility({ mounted: true, windowVisible: true, width: 1, height: 600 }).level).toBe('zero-size')
  })

  it('已挂载且窗口可见才算可截图', () => {
    const v = rules.resolveVisibility({ mounted: true, windowVisible: true, minimized: false, width: 900, height: 600 })
    expect(v).toMatchObject({ level: 'visible', canCapture: true, canDom: true })
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
