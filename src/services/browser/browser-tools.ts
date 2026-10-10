/**
 * 浏览器自动化工具定义与处理器
 *
 * 提供 6 个浏览器工具：
 * 1. browser_navigate — 打开网页
 * 2. browser_screenshot — 截图
 * 3. browser_snapshot — 获取页面无障碍树
 * 4. browser_click — 点击元素
 * 5. browser_type — 填写表单
 * 6. browser_evaluate — 执行 JavaScript
 */

import type { ToolDefinition, ToolHandler } from '@/types'
import { browserAction } from './browser-manager'

// ============ 工具定义 ============

export const browserNavigateTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_navigate',
    description: '打开指定 URL 的网页。仅支持 http/https 协议。页面加载完成后返回页面标题和最终 URL。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要打开的网页地址，如 "https://example.com"'
        }
      },
      required: ['url']
    }
  }
}

export const browserScreenshotTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_screenshot',
    description: '截取当前页面的屏幕截图，返回 base64 编码的图片数据。可截取可视区域或完整页面。',
    parameters: {
      type: 'object',
      properties: {
        fullPage: {
          type: 'boolean',
          description: '是否截取完整页面（包括滚动区域），默认 false',
          default: false
        }
      }
    }
  }
}

export const browserSnapshotTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_snapshot',
    description: '获取当前页面的无障碍树（Accessibility Tree）文本表示。包含所有可见元素的类型、名称和层级关系，适合理解页面结构。',
    parameters: {
      type: 'object',
      properties: {}
    }
  }
}

export const browserClickTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_click',
    description: '点击页面上的元素。使用 CSS 选择器指定目标元素，如 "button.submit" 或 "#login-btn"。',
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS 选择器，如 "button", ".link", "#submit-btn"'
        }
      },
      required: ['selector']
    }
  }
}

export const browserTypeTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_type',
    description: '在页面的输入框中填写文字。使用 CSS 选择器指定目标输入框。',
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS 选择器，指定目标输入框，如 "input[name=email]"'
        },
        text: {
          type: 'string',
          description: '要填写的文字内容'
        }
      },
      required: ['selector', 'text']
    }
  }
}

export const browserEvaluateTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_evaluate',
    description: '在当前页面中执行 JavaScript 表达式并返回结果。可用于提取数据、检查元素状态等。禁止使用 require/import/process/global。',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'JavaScript 表达式，如 "document.title" 或 "Array.from(document.querySelectorAll(\'a\')).map(a => a.href)"'
        }
      },
      required: ['expression']
    }
  }
}

// ============ 工具处理器 ============

export const browserNavigateHandler: ToolHandler = async (args) => {
  const result = await browserAction('navigate', { url: args.url })
  if (!result.success) {
    throw new Error(result.error || '导航失败')
  }
  return {
    url: result.url,
    title: result.title,
    message: `已打开: ${result.title || result.url}`
  }
}

export const browserScreenshotHandler: ToolHandler = async (args) => {
  const result = await browserAction('screenshot', {
    fullPage: args.fullPage || false,
    type: 'png'
  })
  if (!result.success) {
    throw new Error(result.error || '截图失败')
  }
  return {
    type: 'image',
    format: result.type || 'png',
    data: result.data,
    message: '截图已生成（base64 格式）'
  }
}

export const browserSnapshotHandler: ToolHandler = async (_args) => {
  const result = await browserAction('snapshot', {})
  if (!result.success) {
    throw new Error(result.error || '获取快照失败')
  }
  return {
    title: result.title,
    url: result.url,
    accessibilityTree: result.accessibilityTree,
    truncated: result.truncated,
    message: `页面快照: ${result.title || result.url}`
  }
}

export const browserClickHandler: ToolHandler = async (args) => {
  const result = await browserAction('click', { selector: args.selector })
  if (!result.success) {
    throw new Error(result.error || '点击失败')
  }
  return { message: result.message || `已点击: ${args.selector}` }
}

export const browserTypeHandler: ToolHandler = async (args) => {
  const result = await browserAction('type', {
    selector: args.selector,
    text: args.text
  })
  if (!result.success) {
    throw new Error(result.error || '填写失败')
  }
  return { message: result.message || `已填写: ${args.selector}` }
}

export const browserEvaluateHandler: ToolHandler = async (args) => {
  const result = await browserAction('evaluate', { expression: args.expression })
  if (!result.success) {
    throw new Error(result.error || '执行失败')
  }
  return {
    result: result.result,
    message: 'JavaScript 执行成功'
  }
}

// 汇总所有工具定义和处理器
export const browserToolDefinitions: ToolDefinition[] = [
  browserNavigateTool,
  browserScreenshotTool,
  browserSnapshotTool,
  browserClickTool,
  browserTypeTool,
  browserEvaluateTool
]

export const browserToolHandlers: Record<string, ToolHandler> = {
  browser_navigate: browserNavigateHandler,
  browser_screenshot: browserScreenshotHandler,
  browser_snapshot: browserSnapshotHandler,
  browser_click: browserClickHandler,
  browser_type: browserTypeHandler,
  browser_evaluate: browserEvaluateHandler
}
