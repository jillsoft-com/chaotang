/**
 * 视觉桥接 — 把工具返回的图像（浏览器截图等）安全地交给支持视觉的模型
 *
 * 为什么单独一层：
 * - ChatMessage.content 是 string，各处按长度做统计 / 截断 / 摘要，
 *   把 base64 直接塞进去会污染上下文并撑爆 token；
 * - OpenAI 兼容接口只保证 user 消息可携带 image_url，tool 消息带图
 *   会被部分网关拒绝。
 *
 * 做法：图像放进 ChatMessage.images（data URL），挂在整轮工具结果之后的
 * 一条 user 消息上；tool 消息只保留去掉 base64 的文本摘要。
 * 模型不支持视觉时，改为文本提示引导它用 browser_snapshot / browser_evaluate。
 */

import type { ChatMessage, ToolCallResult } from '@/types'

/** 上下文中最多保留的带图消息条数（截图只在看当下页面时有价值） */
export const MAX_IMAGE_MESSAGES = 2

export interface ImagePayload {
  /** data URL，可直接作为 image_url.url */
  url: string
  format: string
}

/** 识别工具返回值中的图像结果（形如 { type: 'image', format, data }） */
export function extractImagePayload(raw: unknown): ImagePayload | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, any>
  if (obj.type !== 'image' || typeof obj.data !== 'string' || obj.data.length === 0) return null
  const format = typeof obj.format === 'string' && obj.format ? obj.format : 'png'
  const url = obj.data.startsWith('data:') ? obj.data : `data:image/${format};base64,${obj.data}`
  return { url, format }
}

/** 工具结果的文本形态：剥掉 base64 负载，保留元信息 */
export function stringifyToolResult(raw: unknown, hadImage: boolean): string {
  if (typeof raw === 'string') return raw
  if (!hadImage || !raw || typeof raw !== 'object') return JSON.stringify(raw, null, 2)
  const clone: Record<string, any> = { ...(raw as Record<string, any>) }
  delete clone.data
  clone.message = `${clone.message || ''}（图像数据已随本轮结果单独提供）`.trim()
  return JSON.stringify(clone, null, 2)
}

/**
 * 追加工具结果消息
 * @returns 需要挂载的图像 data URL（调用方在本轮工具全部结束后交给 attachRoundImages），无图时返回 null
 */
export function pushToolResultMessage(
  messages: ChatMessage[],
  result: ToolCallResult,
  toolCallId: string,
  toolName: string,
  visionCapable: boolean
): string | null {
  const image = result.status === 'success' ? extractImagePayload(result.result) : null

  if (image && !visionCapable) {
    // 当前模型看不到图：把话说清楚，引导它改用文本通道获取页面信息
    messages.push({
      role: 'tool',
      content: `${stringifyToolResult(result.result, true)}\n\n⚠️ 该工具返回了一张图像，但当前模型未开启图片识别能力，无法查看图像内容。请改用 browser_snapshot 获取页面无障碍树，或用 browser_evaluate 提取所需文本。`,
      tool_call_id: toolCallId,
      name: toolName
    })
    return null
  }

  messages.push({
    role: 'tool',
    content: stringifyToolResult(result.result, !!image),
    tool_call_id: toolCallId,
    name: toolName
  })
  return image ? image.url : null
}

/**
 * 一轮工具调用全部结束后，把本轮图像作为一条 user 消息交给模型。
 * 放在 tool 消息之后，避免打散 assistant 的 tool_calls 应答序列。
 */
export function attachRoundImages(messages: ChatMessage[], imageUrls: string[]): void {
  const urls = imageUrls.filter(Boolean).slice(0, MAX_IMAGE_MESSAGES)
  if (urls.length === 0) return
  messages.push({
    role: 'user',
    content: urls.length > 1
      ? `以下是上一步工具返回的 ${urls.length} 张图像。请直接观察图像中的页面布局、文字、控件状态与报错提示，再决定下一步。`
      : '以下是上一步工具返回的图像。请直接观察图像中的页面布局、文字、控件状态与报错提示，再决定下一步。',
    images: urls
  })
  pruneImageMessages(messages)
}

/** 只保留最近若干条带图消息，更早的降级为纯文本，避免 base64 反复上传 */
export function pruneImageMessages(messages: ChatMessage[], keep = MAX_IMAGE_MESSAGES): void {
  const imageIdx: number[] = []
  messages.forEach((m, i) => {
    if (m.images && m.images.length > 0) imageIdx.push(i)
  })
  const dropCount = imageIdx.length - keep
  for (let i = 0; i < dropCount; i++) {
    const m = messages[imageIdx[i]]
    m.images = undefined
    m.content = `${m.content}\n（更早的图像已过期省略，如需查看请重新截图）`
  }
}

/** 按模型视觉能力，给系统提示词追加对应说明 */
export function visionPromptHint(visionCapable: boolean): string {
  const panel = `\n\n浏览器页面会实时显示在右侧「浏览器」面板，用户可能正在观看甚至点击「接管」亲自操作。\n若工具返回「用户正在接管浏览器操作」或「DOMAIN_BLOCKED」，不要连续重试：前者请提示用户退出接管或改用 browser_snapshot，后者请改用白名单内的地址或向用户说明所需站点。`
  if (visionCapable) {
    return `\n\n### 图片识别能力\n你已开启视觉能力。browser_screenshot 返回的截图会以图像形式跟在本轮工具结果之后，请直接观察图像判断页面状态，不要凭文字猜测。${panel}`
  }
  return `\n\n### 浏览器操作提示\n当前模型未开启图片识别，看不到 browser_screenshot 返回的图像。理解页面请优先使用 browser_snapshot（无障碍树）与 browser_evaluate（提取文本、属性）。${panel}`
}
