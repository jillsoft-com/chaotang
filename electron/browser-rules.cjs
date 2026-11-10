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
 * 截图可行性分级（探针实测结论的工程化）
 *
 * BrowserView 只有在「已挂载 + 窗口可见未最小化 + 有实际尺寸」时才会进入合成层，
 * 这时 Page.captureScreenshot 才返回数据；其余情形不会报错，而是一去不回地挂死。
 * 所以截图前必须先判定，而不是靠超时兜底。
 */
function resolveVisibility(state) {
  const mounted = !!state.mounted
  const windowVisible = state.windowVisible !== false
  const minimized = !!state.minimized
  const width = Number(state.width) || 0
  const height = Number(state.height) || 0
  const sized = width >= 2 && height >= 2

  if (!mounted) {
    return {
      level: 'detached',
      canCapture: false,
      canDom: true,
      reason: '浏览器面板当前没有显示在界面上',
      hint: '文字类操作可继续；需要画面时面板会自动唤起，或请用户切到浏览器标签页'
    }
  }
  if (minimized) {
    return {
      level: 'minimized',
      canCapture: false,
      canDom: true,
      reason: '应用窗口已最小化',
      hint: '最小化状态下无法取得画面，请恢复窗口后再要求截图'
    }
  }
  if (!windowVisible) {
    return {
      level: 'hidden',
      canCapture: false,
      canDom: true,
      reason: '应用窗口当前不可见',
      hint: '文字类操作可继续，需要画面时请恢复窗口'
    }
  }
  if (!sized) {
    return {
      level: 'zero-size',
      canCapture: false,
      canDom: true,
      reason: '浏览器区域尺寸为 0',
      hint: '面板被折叠了，请展开浏览器区域'
    }
  }
  return { level: 'visible', canCapture: true, canDom: true, reason: '', hint: '' }
}

/** 从 CDP target 列表里挑出跨域 iframe（用于 OOPIF 取数） */
function pickIframeTarget(targetInfos, urlPart) {
  const infos = Array.isArray(targetInfos) ? targetInfos : []
  const needle = String(urlPart || '').toLowerCase()
  return infos.find((info) =>
    info && info.type === 'iframe' &&
    String(info.url || '').toLowerCase().includes(needle)
  ) || null
}

module.exports = {
  ALLOWED_KEYS,
  KEY_CODE_TABLE,
  VIEWPORT_MIN,
  VIEWPORT_MAX,
  MAX_EVAL_TEXT,
  MAX_TREE_TEXT,
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
  resolveVisibility,
  pickIframeTarget
}
