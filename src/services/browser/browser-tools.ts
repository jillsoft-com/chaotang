/**
 * 浏览器自动化工具定义与处理器
 *
 * 能力面（M4 起共 16 个）：
 * - 老 6 个：navigate / snapshot / click / type / screenshot / evaluate，参数补上 tabId；
 * - 新增 10 个：state、query、frame_query、scroll、hover、press 与 tab_list / tab_open / tab_select / tab_close。
 *
 * 三条设计约束，改动时请勿绕过：
 * 1. 画面可用性必须如实告诉模型。内嵌宿主在窗口被遮挡时 Input.* 与截图会静默失效
 *    （Chromium 合成层不推进，不是偶发故障），而 Runtime.evaluate 照常可用。
 *    模型只有看到 visibility / fallback，才知道这一步该不该相信、该不该换个做法。
 * 2. 只有一个浏览器。旧截图流时代那些「打到用户看不见的另一个浏览器」的陷阱已经随通道一起删了，
 *    但标签页、子框架这些能力仍然只有宿主有，动作名不得随手换成旧通道的写法。
 * 3. 声明顺序有代价。工具选择器在角色工具总数超上限时按顺序截断（DEFAULT_MAX_TOOLS=12），
 *    所以高频动作在前、标签页管理在后，截图这种又贵又非必需的不排在第一位。
 */

import type { ToolDefinition, ToolHandler, JSONSchema } from '@/types'
import { runBrowserAction, beginAgentUse, endAgentUse, awaitManualRelease } from './browser-session'
import type { BrowserActionResult } from './browser-manager'
import { confirmNavigation } from './browser-policy'

/**
 * 允许透传给页面的按键名。
 * 与 electron/browser-rules.cjs 的 ALLOWED_KEYS 手工保持一致（主进程侧还会二次校验，
 * 这里写进 enum 只是让模型少走一次弯路，多写少写都不会造成越权）。
 */
const PRESS_KEYS = [
  'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'
]

/**
 * Agent 侧统一包装：
 * 1) 用户接管期间先等待（自动暂停 Agent）；
 * 2) 标记占用，让面板知道“现在是 Agent 在操作”并禁用人工按钮；
 * 3) 导航前先过一层人工确认（默认关闭）。
 */
async function withAgentBrowserUse<T>(toolName: string, fn: () => Promise<T>, confirmUrl?: string): Promise<T> {
  await awaitManualRelease()
  if (confirmUrl && !(await confirmNavigation(confirmUrl, 'agent'))) {
    throw new Error(`用户拒绝访问 ${confirmUrl}。请改用其他站点，或向用户说明为何需要该页面。`)
  }
  beginAgentUse(toolName)
  try {
    return await fn()
  } finally {
    endAgentUse()
  }
}

/**
 * Agent 侧的统一出口：在 runBrowserAction 上盖一个身份章。
 *
 * 主进程的接管锁与控制面拦截只认 actor='agent'，缺省当用户：
 * 少了这一步，模型的动作与用户自己的按钮同一个待遇，锁就等于没锁。
 */
async function agentAction(
  action: Parameters<typeof runBrowserAction>[0],
  params: Record<string, any> = {}
): Promise<BrowserActionResult> {
  return await runBrowserAction(action, params, { actor: 'agent' })
}

// ============ 公共小工具 ============

/** 只在参数非空时带上 tabId，省略即“当前活动标签页” */
function tabParam(tabId: unknown): Record<string, any> {
  return typeof tabId === 'string' && tabId ? { tabId } : {}
}

/**
 * 把失败原因翻译成模型能照着做的下一步。
 * 内嵌宿主的失败大多不是「这一步做错了」，而是「此刻没有合成层」，
 * 措辞必须把两者分开，否则模型会对同一个需要画面的动作反复重试。
 */
function browserFailure(res: BrowserActionResult, fallback: string): Error {
  const raw = res.error || fallback
  if (res.hint) return new Error(`${raw}｜${res.hint}`)
  if (res.retryable) {
    return new Error(`${raw}｜这是暂时性的（画面还没准备好），可以稍后重试，` +
      '或改用不依赖画面的 browser_query / browser_snapshot / browser_evaluate')
  }
  return new Error(raw)
}

/** 页面身份信息：URL / 标题 / 标签页 id / 视口 */
function pageFields(res: BrowserActionResult): Record<string, any> {
  const out: Record<string, any> = {}
  if (typeof res.url === 'string' && res.url) out.url = res.url
  if (typeof res.title === 'string' && res.title) out.title = res.title
  if (res.tabId) out.tabId = res.tabId
  if (res.viewport) out.viewport = res.viewport
  if (typeof res.httpStatus === 'number' && res.httpStatus) out.httpStatus = res.httpStatus
  if (typeof res.loadError === 'string' && res.loadError) out.loadError = res.loadError
  return out
}

/**
 * 画面相关字段。
 * synthetic=true 是重点：说明这一步只拿到了 JS 合成事件（isTrusted=false），
 * 风控严格的站点可能不认，模型据此决定要不要让用户切到前台再来一遍。
 */
function screenFields(res: BrowserActionResult): Record<string, any> {
  const out: Record<string, any> = {}
  if (res.fallback) out.synthetic = true
  if (res.warning) out.warning = res.warning
  if (typeof res.canCapture === 'boolean') out.screenAvailable = res.canCapture
  if (res.canCapture === false && res.visibility) out.visibility = res.visibility
  return out
}

/** 标签页列表归一成模型好读的形状 */
function tabRows(res: BrowserActionResult): Array<Record<string, any>> {
  return (res.tabs || []).map(t => ({
    tabId: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
    /** 是否正画在界面那块矩形上。false 表示页面在后台运行，取数照常但拿不到画面 */
    onScreen: t.mounted
  }))
}

const tabIdProp: JSONSchema = {
  type: 'string',
  description: '目标标签页 id，取自 browser_tab_list 或 browser_tab_open。省略时作用于当前活动标签页'
}

const jsFallbackProp: JSONSchema = {
  type: 'boolean',
  description: '画面不可用时是否允许退化为 JS 合成事件（默认允许，返回里会标注 synthetic=true、isTrusted=false）。' +
    '设为 false 时画面不可用会直接失败，用于必须产生可信事件的场合',
  default: true
}

const selectorProp: JSONSchema = {
  type: 'string',
  description: 'CSS 选择器，如 "button.submit"、"#login-btn"、"input[name=email]"'
}

// ============ 页面操作 ============

export const browserNavigateTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_navigate',
    description: '打开指定 URL 的网页。仅支持 http/https。默认在当前活动标签页导航；newTab=true 另开一个标签页并置为活动页。' +
      '返回最终 URL、页面标题与 HTTP 状态码。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的网页地址，如 "https://example.com"' },
        newTab: { type: 'boolean', description: '是否在新标签页打开，默认 false', default: false },
        tabId: tabIdProp
      },
      required: ['url']
    }
  }
}

export const browserSnapshotTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_snapshot',
    description: '获取页面无障碍树（Accessibility Tree）文本。包含可见元素的类型、名称与层级，是理解页面结构、' +
      '找可点击元素的首选手段。不依赖画面，窗口被遮挡时依然可用，因此优先于截图。',
    parameters: {
      type: 'object',
      properties: { tabId: tabIdProp }
    }
  }
}

export const browserClickTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_click',
    description: '点击页面元素。用 CSS 选择器指定目标。页面会先被滚进视口。' +
      '若返回 synthetic=true，说明只拿到了 JS 合成事件（isTrusted=false），严格站点可能不认。',
    parameters: {
      type: 'object',
      properties: {
        selector: selectorProp,
        tabId: tabIdProp,
        jsFallback: jsFallbackProp
      },
      required: ['selector']
    }
  }
}

export const browserTypeTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_type',
    description: '在输入框填写文字。默认先清空原值再输入，并补发 change 事件以兼容受控组件。' +
      '需要按键（如回车提交）时配合 browser_press。',
    parameters: {
      type: 'object',
      properties: {
        selector: selectorProp,
        text: { type: 'string', description: '要填写的文字内容' },
        append: { type: 'boolean', description: 'true 为在原有内容后追加，默认 false（先清空）', default: false },
        tabId: tabIdProp,
        jsFallback: jsFallbackProp
      },
      required: ['selector', 'text']
    }
  }
}

export const browserScreenshotTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_screenshot',
    description: '截取当前页面画面，返回 base64 图片。注意：只有页面真的画在界面上时才截得到，' +
      '窗口被遮挡或面板收起时会返回暂时性失败（retryable）。取内容请优先用 browser_snapshot 或 browser_query。',
    parameters: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean', description: '是否截取完整页面（含滚动区域），默认 false', default: false },
        tabId: tabIdProp
      }
    }
  }
}

export const browserEvaluateTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_evaluate',
    description: '在页面上下文执行 JavaScript 表达式并返回结果，可用于取数据、检查元素状态。' +
      '禁止 require/import/process/global。该能力不依赖画面，窗口不可见时仍然可靠，是后台取数的首选。',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'JavaScript 表达式，如 "document.title" 或 "Array.from(document.querySelectorAll(\'a\')).map(a => a.href)"'
        },
        tabId: tabIdProp
      },
      required: ['expression']
    }
  }
}

// ============ 状态与页面级动作 ============

export const browserStateTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_state',
    description: '无副作用地查看浏览器现状：当前 URL、标题、历史栈是否可前后退、视口尺寸、' +
      '画面是否可用（不可用的原因）、全部标签页。做任何浏览器动作前先调它，能省掉大量试错。',
    parameters: {
      type: 'object',
      properties: { tabId: tabIdProp }
    }
  }
}

export const browserQueryTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_query',
    description: '按选择器精确读取元素的文本、HTML 或属性，比 browser_evaluate 写起来短，比 browser_snapshot 更聚焦。' +
      'all=true 返回列表（最多 50 条），适合抓列表数据。需要读取跨域 iframe 时改用 browser_frame_query。',
    parameters: {
      type: 'object',
      properties: {
        selector: selectorProp,
        attribute: {
          type: 'string',
          description: '要读的内容：留空或 "text" 取可见文本，"html" 取 innerHTML，其余按属性名，如 "href"、"src"、"value"'
        },
        all: { type: 'boolean', description: 'true 时返回所有匹配元素，默认 false 只返回第一个', default: false },
        tabId: tabIdProp
      },
      required: ['selector']
    }
  }
}

export const browserFrameQueryTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_frame_query',
    description: '在指定跨域子 iframe 里执行 JavaScript。普通 browser_evaluate 进不了跨域框架（浏览器同源策略），'
      + '而支付、登录、验证码组件常常就在 iframe 里。urlPart 用来自匹配子框架（地址片段，如 "payment"），省略时取第一个；页面里有很多 iframe 时请带上它。',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '在 iframe 上下文执行的 JavaScript 表达式' },
        urlPart: { type: 'string', description: '子框架地址的片段，如 "payment"；省略时取第一个跨域 iframe' },
        tabId: tabIdProp
      },
      required: ['expression']
    }
  }
}

export const browserScrollTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_scroll',
    description: '滚动页面。给 selector 时把该元素滚进视口（不需要画面，后台也能做）；' +
      '给 deltaY 时按像素滚动（正值向下），用于触发懒加载。',
    parameters: {
      type: 'object',
      properties: {
        deltaY: { type: 'number', description: '纵向滚动像素，正值向下、负值向上，范围 -3000~3000' },
        deltaX: { type: 'number', description: '横向滚动像素，正值向右' },
        selector: { type: 'string', description: '把该元素滚进视口，与 deltaY 二选一' },
        block: {
          type: 'string',
          description: '配合 selector：元素对齐到视口的位置，默认 center',
          enum: ['start', 'center', 'end', 'nearest'],
          default: 'center'
        },
        tabId: tabIdProp
      }
    }
  }
}

export const browserHoverTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_hover',
    description: '把鼠标悬停在元素上，用于展开下拉菜单、触发 hover 显示。' +
      '真事件需要画面，后台会退化为 JS 合成事件（返回 synthetic=true），只靠 :hover 样式的菜单在退化时不会展开。',
    parameters: {
      type: 'object',
      properties: {
        selector: selectorProp,
        tabId: tabIdProp,
        jsFallback: jsFallbackProp
      },
      required: ['selector']
    }
  }
}

export const browserPressTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_press',
    description: '按一个功能键，作用于当前焦点元素。常用：Enter 提交表单、Escape 关弹层、Tab 切焦点、' +
      'PageDown 翻页。只接受功能键，输入文字请用 browser_type。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', enum: PRESS_KEYS, description: '按键名' },
        tabId: tabIdProp
      },
      required: ['key']
    }
  }
}

// ============ 标签页 ============

export const browserTabListTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_tab_list',
    description: '列出所有标签页（id、URL、标题、是否活动、是否正画在界面上）。要并行处理多个站点时靠它拿 id 再配合各工具的 tabId。',
    parameters: { type: 'object', properties: {} }
  }
}

export const browserTabOpenTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_tab_open',
    description: '新建标签页。不传 url 时开空白页。background=true 表示在后台打开、不切换活动页' +
      '（活动页会接着被其它工具当作默认目标）。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '可选，新标签页要打开的地址' },
        background: { type: 'boolean', description: 'true 为后台打开，保持当前活动页不变，默认 false', default: false }
      }
    }
  }
}

export const browserTabSelectTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_tab_select',
    description: '把指定标签页切成活动页。之后的浏览器工具不带 tabId 时就作用于它。',
    parameters: {
      type: 'object',
      properties: { tabId: { type: 'string', description: '要切换过去的标签页 id' } },
      required: ['tabId']
    }
  }
}

export const browserTabCloseTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_tab_close',
    description: '关闭标签页并释放它的独立会话（cookie、存储随之隔离回收）。省略 tabId 时关闭当前活动页。',
    parameters: {
      type: 'object',
      properties: { tabId: tabIdProp }
    }
  }
}

// ============ 工具处理器 ============

export const browserNavigateHandler: ToolHandler = async (args) => {
  return withAgentBrowserUse('browser_navigate', async () => {
    if (args.newTab) {
      const res = await agentAction('tab-open', { url: args.url })
      if (!res.success) throw browserFailure(res, '在新标签页打开失败')
      return {
        message: `已在新标签页打开: ${res.title || args.url}`,
        ...pageFields(res),
        ...screenFields(res)
      }
    }
    const result = await agentAction('navigate', { url: args.url, ...tabParam(args.tabId) })
    if (!result.success) throw browserFailure(result, '导航失败')
    return {
      message: `已打开: ${result.title || result.url}`,
      ...pageFields(result),
      ...screenFields(result)
    }
  }, typeof args.url === 'string' ? args.url : undefined)
}

export const browserSnapshotHandler: ToolHandler = async (args) => {
  return withAgentBrowserUse('browser_snapshot', async () => {
    const result = await agentAction('snapshot', tabParam(args.tabId))
    if (!result.success) throw browserFailure(result, '获取快照失败')
    return {
      title: result.title,
      url: result.url,
      accessibilityTree: result.accessibilityTree,
      truncated: result.truncated,
      message: `页面快照: ${result.title || result.url}`
    }
  })
}

export const browserClickHandler: ToolHandler = async (args) => {
  return withAgentBrowserUse('browser_click', async () => {
    const result = await agentAction('click', {
      selector: args.selector,
      ...tabParam(args.tabId),
      ...(args.jsFallback === false ? { jsFallback: false } : {})
    })
    if (!result.success) throw browserFailure(result, '点击失败')
    return {
      message: result.message || `已点击: ${args.selector}`,
      ...pageFields(result),
      ...screenFields(result)
    }
  })
}

export const browserTypeHandler: ToolHandler = async (args) => {
  return withAgentBrowserUse('browser_type', async () => {
    const result = await agentAction('type', {
      selector: args.selector,
      text: args.text,
      ...(args.append === true ? { append: true } : {}),
      ...tabParam(args.tabId),
      ...(args.jsFallback === false ? { jsFallback: false } : {})
    })
    if (!result.success) throw browserFailure(result, '填写失败')
    return {
      message: result.message || `已填写: ${args.selector}`,
      ...pageFields(result),
      ...screenFields(result)
    }
  })
}

export const browserScreenshotHandler: ToolHandler = async (args) => {
  return withAgentBrowserUse('browser_screenshot', async () => {
    // jpeg 比 png 小一个量级，面板轮询与模型上传都依赖它
    const result = await agentAction('screenshot', {
      fullPage: args.fullPage || false,
      type: 'jpeg',
      quality: 80,
      ...tabParam(args.tabId)
    })
    if (!result.success) throw browserFailure(result, '截图失败')
    return {
      type: 'image',
      format: result.type || 'jpeg',
      data: result.data,
      message: '截图已生成（base64 格式）',
      ...screenFields(result)
    }
  })
}

export const browserEvaluateHandler: ToolHandler = async (args) => {
  return withAgentBrowserUse('browser_evaluate', async () => {
    const result = await agentAction('evaluate', {
      expression: args.expression,
      ...tabParam(args.tabId)
    })
    if (!result.success) throw browserFailure(result, '执行失败')
    return {
      result: result.result,
      ...pageFields(result),
      message: 'JavaScript 执行成功'
    }
  })
}

export const browserStateHandler: ToolHandler = async (args) => {
  return withAgentBrowserUse('browser_state', async () => {
    const res = await agentAction('state', tabParam(args.tabId))
    if (!res.success) throw browserFailure(res, '读取浏览器状态失败')
    const rows = tabRows(res)
    const screen = typeof res.canCapture === 'boolean'
      ? (res.canCapture ? '画面可用' : `画面不可用（${res.visibility || 'unknown'}）`)
      : ''
    const hint = res.canCapture === false && res.captureHint ? `｜${res.captureHint}` : ''
    // 点击位单独报：模型拿到「画面不可用」时容易误以为输入也停了，
    // 而真实边界是只有鼠标点击会退化，按键与滚动照旧是真实事件
    const click = res.canClick === false ? `｜鼠标点击不可达（会退化为 JS 合成事件）${res.clickHint ? `：${res.clickHint}` : ''}` : ''
    // 后台承载（M8-b）：面板不可见时页面住在离屏 ghost 孪生视图里，真点击与截图照旧可用，
    // 此时不再提示「画面不可用」——那是对前台遮挡态的描述，与后台承载是两回事
    const bg = res.carrier === 'bg' ? '｜后台运行中（面板不可见时在离屏承载，真点击/截图可用）' : ''
    return {
      url: res.url,
      title: res.title,
      active: res.active,
      canBack: res.canBack,
      canForward: res.canForward,
      viewport: res.viewport,
      visibility: res.visibility,
      carrier: res.carrier,
      offscreen: res.offscreen,
      screenAvailable: res.canCapture,
      captureHint: res.captureHint,
      canClick: res.canClick,
      canWheel: res.canWheel,
      canKey: res.canKey,
      clickHint: res.clickHint,
      tabs: rows,
      tabCount: rows.length,
      message: `当前: ${res.title || res.url || '空白页'}｜标签页 ${rows.length} 个` +
        (bg ? bg : (screen ? `｜${screen}${hint}` : '') + click)
    }
  })
}

export const browserQueryHandler: ToolHandler = async (args) => {
  return withAgentBrowserUse('browser_query', async () => {
    const res = await agentAction('query', {
      selector: args.selector,
      ...(args.attribute ? { attribute: args.attribute } : {}),
      ...(args.all === true ? { all: true } : {}),
      ...tabParam(args.tabId)
    })
    if (!res.success) throw browserFailure(res, '读取元素失败')
    return {
      result: res.result,
      truncated: res.truncated,
      ...pageFields(res),
      message: `已读取 ${args.selector}`
    }
  })
}

export const browserFrameQueryHandler: ToolHandler = async (args) => {
  return withAgentBrowserUse('browser_frame_query', async () => {
    const res = await agentAction('frame-evaluate', {
      expression: args.expression,
      ...(args.urlPart ? { urlPart: args.urlPart } : {}),
      ...tabParam(args.tabId)
    })
    if (!res.success) throw browserFailure(res, '读取子框架失败')
    return { result: res.result, frameUrl: res.frameUrl, message: `已执行于子框架: ${res.frameUrl || ''}` }
  })
}

export const browserScrollHandler: ToolHandler = async (args) => {
  return withAgentBrowserUse('browser_scroll', async () => {
    const params: Record<string, any> = { ...tabParam(args.tabId) }
    if (args.selector) {
      params.selector = args.selector
      if (args.block) params.block = args.block
    } else {
      params.deltaY = args.deltaY ?? 0
      if (args.deltaX !== undefined) params.deltaX = args.deltaX
    }
    const res = await agentAction('scroll', params)
    if (!res.success) throw browserFailure(res, '滚动失败')
    return { message: res.message || '已滚动', ...screenFields(res) }
  })
}

export const browserHoverHandler: ToolHandler = async (args) => {
  return withAgentBrowserUse('browser_hover', async () => {
    const res = await agentAction('hover', {
      selector: args.selector,
      ...tabParam(args.tabId),
      ...(args.jsFallback === false ? { jsFallback: false } : {})
    })
    if (!res.success) throw browserFailure(res, '悬停失败')
    return { message: res.message || `已悬停: ${args.selector}`, ...screenFields(res) }
  })
}

export const browserPressHandler: ToolHandler = async (args) => {
  return withAgentBrowserUse('browser_press', async () => {
    const res = await agentAction('keyboard', { key: args.key, ...tabParam(args.tabId) })
    if (!res.success) throw browserFailure(res, '按键失败')
    return { message: res.message || `已按下 ${args.key}`, ...screenFields(res) }
  })
}

export const browserTabListHandler: ToolHandler = async () => {
  return withAgentBrowserUse('browser_tab_list', async () => {
    const res = await agentAction('tab-list', {})
    if (!res.success) throw browserFailure(res, '获取标签页列表失败')
    const rows = tabRows(res)
    return {
      tabs: rows,
      activeTabId: res.activeTabId || res.tabId || '',
      message: `共 ${rows.length} 个标签页，活动页 ${rows.filter(r => r.active).map(r => r.tabId).join(',') || '（无）'}`
    }
  })
}

export const browserTabOpenHandler: ToolHandler = async (args) => {
  return withAgentBrowserUse('browser_tab_open', async () => {
    const res = await agentAction('tab-open', {
      ...(args.url ? { url: args.url } : {}),
      ...(args.background === true ? { activate: false } : {})
    })
    if (!res.success) throw browserFailure(res, '新建标签页失败')
    const rows = tabRows(res)
    return {
      message: `已${args.background === true ? '在后台' : ''}打开标签页 ${res.tabId || ''}`,
      tabId: res.tabId,
      tabs: rows,
      ...pageFields(res)
    }
  }, typeof args.url === 'string' ? args.url : undefined)
}

export const browserTabSelectHandler: ToolHandler = async (args) => {
  return withAgentBrowserUse('browser_tab_select', async () => {
    const res = await agentAction('tab-select', { tabId: args.tabId })
    if (!res.success) throw browserFailure(res, '切换标签页失败')
    return { message: `已切到标签页 ${args.tabId}`, ...pageFields(res) }
  })
}

export const browserTabCloseHandler: ToolHandler = async (args) => {
  return withAgentBrowserUse('browser_tab_close', async () => {
    const res = await agentAction('tab-close', tabParam(args.tabId))
    if (!res.success) throw browserFailure(res, '关闭标签页失败')
    const rows = tabRows(res)
    return {
      message: `标签页已关闭，剩余 ${rows.length} 个`,
      tabs: rows,
      ...pageFields(res)
    }
  })
}

// 汇总所有工具定义和处理器
export const browserToolDefinitions: ToolDefinition[] = [
  browserNavigateTool,
  browserSnapshotTool,
  browserClickTool,
  browserTypeTool,
  browserScreenshotTool,
  browserEvaluateTool,
  browserStateTool,
  browserQueryTool,
  browserFrameQueryTool,
  browserScrollTool,
  browserHoverTool,
  browserPressTool,
  browserTabListTool,
  browserTabOpenTool,
  browserTabSelectTool,
  browserTabCloseTool
]

export const browserToolHandlers: Record<string, ToolHandler> = {
  browser_navigate: browserNavigateHandler,
  browser_snapshot: browserSnapshotHandler,
  browser_click: browserClickHandler,
  browser_type: browserTypeHandler,
  browser_screenshot: browserScreenshotHandler,
  browser_evaluate: browserEvaluateHandler,
  browser_state: browserStateHandler,
  browser_query: browserQueryHandler,
  browser_frame_query: browserFrameQueryHandler,
  browser_scroll: browserScrollHandler,
  browser_hover: browserHoverHandler,
  browser_press: browserPressHandler,
  browser_tab_list: browserTabListHandler,
  browser_tab_open: browserTabOpenHandler,
  browser_tab_select: browserTabSelectHandler,
  browser_tab_close: browserTabCloseHandler
}
