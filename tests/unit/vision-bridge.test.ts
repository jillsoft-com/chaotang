/**
 * 视觉桥接测试
 *
 * 覆盖：
 * - 图像结果识别（browser_screenshot 的 { type:'image', format, data }）
 * - 工具结果入栈：base64 不进 content
 * - 未开启视觉时的文本降级提示
 * - 带图消息挂载与旧图裁剪
 */

import { describe, it, expect } from 'vitest'
import type { ChatMessage, ToolCallResult } from '@/types'
import {
  MAX_IMAGE_MESSAGES,
  extractImagePayload,
  stringifyToolResult,
  pushToolResultMessage,
  attachRoundImages,
  pruneImageMessages,
  visionPromptHint
} from '@/services/agent/vision-bridge'

const BASE64 = 'iVBORw0KGgoAAAANSUhEUg'.repeat(64)

function makeResult(result: any, status: ToolCallResult['status'] = 'success'): ToolCallResult {
  return {
    toolCallId: 'call-1',
    functionName: 'browser_screenshot',
    arguments: {},
    result,
    status,
    duration: 12
  }
}

function imageResult(): any {
  return { type: 'image', format: 'png', data: BASE64, message: '截图已生成（base64 格式）' }
}

describe('extractImagePayload', () => {
  it('识别 base64 图片结果并补全 data URL 前缀', () => {
    const payload = extractImagePayload(imageResult())
    expect(payload?.format).toBe('png')
    expect(payload?.url.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('已是 data URL 时原样使用', () => {
    const payload = extractImagePayload({ type: 'image', format: 'jpeg', data: 'data:image/jpeg;base64,AAA' })
    expect(payload?.url).toBe('data:image/jpeg;base64,AAA')
  })

  it('非图片结果返回 null', () => {
    expect(extractImagePayload({ success: true, content: '文本' })).toBeNull()
    expect(extractImagePayload('普通字符串')).toBeNull()
    expect(extractImagePayload({ type: 'image', format: 'png', data: '' })).toBeNull()
  })
})

describe('stringifyToolResult', () => {
  it('剥离 base64 负载但保留元信息', () => {
    const text = stringifyToolResult(imageResult(), true)
    expect(text).not.toContain(BASE64)
    expect(text).toContain('"type": "image"')
    expect(text).toContain('图像数据已随本轮结果单独提供')
  })

  it('普通结果保持原样序列化', () => {
    expect(stringifyToolResult({ url: 'https://example.com' }, false)).toContain('https://example.com')
  })
})

describe('pushToolResultMessage', () => {
  it('视觉模型：tool 消息不含 base64，返回待挂载的图片', () => {
    const messages: ChatMessage[] = []
    const url = pushToolResultMessage(messages, makeResult(imageResult()), 'call-1', 'browser_screenshot', true)

    expect(url?.startsWith('data:image/png;base64,')).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('tool')
    expect(messages[0].content).not.toContain(BASE64)
    // 图片不进 content，因此不参与字符统计（上下文压缩不会误判）
    expect(messages[0].images).toBeUndefined()
  })

  it('非视觉模型：不返回图片，改用文本提示引导走 snapshot', () => {
    const messages: ChatMessage[] = []
    const url = pushToolResultMessage(messages, makeResult(imageResult()), 'call-1', 'browser_screenshot', false)

    expect(url).toBeNull()
    expect(messages[0].content).toContain('未开启图片识别')
    expect(messages[0].content).toContain('browser_snapshot')
    expect(messages[0].content).not.toContain(BASE64)
  })

  it('截图失败时不当作图片处理', () => {
    const messages: ChatMessage[] = []
    const failed = makeResult({ success: false, error: '页面未加载' }, 'error')
    const url = pushToolResultMessage(messages, failed, 'call-1', 'browser_screenshot', true)

    expect(url).toBeNull()
    expect(messages[0].content).toContain('页面未加载')
  })

  it('普通工具结果原样入栈', () => {
    const messages: ChatMessage[] = []
    const result = makeResult({ title: '示例站点', url: 'https://example.com' })
    result.functionName = 'browser_navigate'
    const url = pushToolResultMessage(messages, result, 'call-1', 'browser_navigate', true)

    expect(url).toBeNull()
    expect(messages[0].content).toContain('示例站点')
  })
})

describe('attachRoundImages', () => {
  it('在整轮工具结果之后追加一条带图 user 消息', () => {
    const messages: ChatMessage[] = [
      { role: 'tool', content: '{"type":"image"}', tool_call_id: 'call-1', name: 'browser_screenshot' }
    ]
    attachRoundImages(messages, ['data:image/png;base64,AAA'])

    const last = messages[messages.length - 1]
    expect(last.role).toBe('user')
    expect(last.images).toEqual(['data:image/png;base64,AAA'])
  })

  it('无图片时不追加消息', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: '目标' }]
    attachRoundImages(messages, [])
    expect(messages).toHaveLength(1)
  })

  it('单轮多图受限于上限', () => {
    const messages: ChatMessage[] = []
    attachRoundImages(messages, ['data:image/png;base64,A', 'data:image/png;base64,B', 'data:image/png;base64,C'])
    expect(messages[messages.length - 1].images).toHaveLength(MAX_IMAGE_MESSAGES)
  })
})

describe('pruneImageMessages', () => {
  it('只保留最近若干条图片，旧的降级为纯文本', () => {
    const messages: ChatMessage[] = []
    for (let i = 0; i < 4; i++) {
      attachRoundImages(messages, [`data:image/png;base64#${i}`])
    }
    pruneImageMessages(messages)

    const withImages = messages.filter(m => m.images && m.images.length > 0)
    expect(withImages).toHaveLength(MAX_IMAGE_MESSAGES)
    // 被裁剪的消息仍留在历史里，只是不再携带 base64
    const dropped = messages.filter(m => !m.images && m.content.includes('更早的图像已过期省略'))
    expect(dropped.length).toBeGreaterThan(0)
  })
})

describe('visionPromptHint', () => {
  it('按能力给出不同的提示词', () => {
    expect(visionPromptHint(true)).toContain('图片识别能力')
    expect(visionPromptHint(false)).toContain('browser_snapshot')
  })
})
