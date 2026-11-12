/**
 * OpenAIProvider.chatStreamWithTools - 推理通道（reasoning）捕获测试
 *
 * 锁定一个真实缺陷：推理模型发工具调用时 content 通道为空，思考内容走
 * delta.reasoning_content / delta.reasoning。此前解析逻辑只读 content/tool_calls，
 * 导致执行时间线的思考段永远为空、被 endThink 判空删除，回溯时只剩「执行命令」。
 *
 * 断言口径：onReasoning 每次回传的是本轮累计的完整思考文本，
 * 且 reasoning_content 与 reasoning 两种字段变体都要覆盖，纯 content 轮次不误触。
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenAIProvider } from '@/services/llm/openai'
import type { ToolCall } from '@/types'

/** 把一组 SSE 事件对象包装成 fetch 可用的流式 Response */
function sseResponse(events: any[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    }
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  })
}

function mockFetch(events: any[]) {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(events))
  return spy
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('chatStreamWithTools - reasoning 通道捕获', () => {
  it('reasoning_content 增量被累计并按回调透传，tool_calls 正常解析', async () => {
    mockFetch([
      { choices: [{ delta: { reasoning_content: '先分析' } }] },
      { choices: [{ delta: { reasoning_content: '任务目标，' } }] },
      { choices: [{ delta: { reasoning_content: '再决定调用工具' } }] },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: { name: 'execute_command', arguments: '{"cmd":"ls"}' }
            }]
          }
        }]
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ])

    const provider = new OpenAIProvider('test-key', 'test-model')
    const reasoningSnapshots: string[] = []
    const toolCalls: ToolCall[] = []

    const content = await provider.chatStreamWithTools(
      [{ role: 'user', content: '列出目录' }],
      () => { /* onChunk 本用例不关心 */ },
      (tcs) => toolCalls.push(...tcs),
      undefined,
      (text) => reasoningSnapshots.push(text)
    )

    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].function.name).toBe('execute_command')
    // 每次回调都是累计值（与 onChunk 口径一致，调用方可直接覆盖写入 think 段）
    expect(reasoningSnapshots).toEqual(['先分析', '先分析任务目标，', '先分析任务目标，再决定调用工具'])
    // content 为空的推理轮次，正文仍返回空串（think 段文本由调用方用 reasoning 合成）
    expect(content).toBe('')
  })

  it('reasoning 字段变体同样被捕获', async () => {
    mockFetch([
      { choices: [{ delta: { reasoning: '思考A' } }] },
      { choices: [{ delta: { reasoning: '思考B' } }] },
      { choices: [{ delta: { content: '正文' }, finish_reason: 'stop' }] }
    ])

    const provider = new OpenAIProvider('test-key', 'test-model')
    let lastReasoning = ''
    const content = await provider.chatStreamWithTools(
      [{ role: 'user', content: 'hi' }],
      () => { /* ignore */ },
      () => { /* ignore */ },
      undefined,
      (text) => { lastReasoning = text }
    )

    expect(lastReasoning).toBe('思考A思考B')
    expect(content).toBe('正文')
  })

  it('非推理模型（无 reasoning 增量）不触发 onReasoning', async () => {
    mockFetch([
      { choices: [{ delta: { content: '普通回答' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ])

    const provider = new OpenAIProvider('test-key', 'test-model')
    const onReasoning = vi.fn()
    const content = await provider.chatStreamWithTools(
      [{ role: 'user', content: 'hi' }],
      () => { /* ignore */ },
      () => { /* ignore */ },
      undefined,
      onReasoning
    )

    expect(content).toBe('普通回答')
    expect(onReasoning).not.toHaveBeenCalled()
  })

  it('未传 onReasoning 时解析 reasoning 不报错（向后兼容）', async () => {
    mockFetch([
      { choices: [{ delta: { reasoning_content: '静默思考' } }] },
      { choices: [{ delta: { content: '结果' }, finish_reason: 'stop' }] }
    ])

    const provider = new OpenAIProvider('test-key', 'test-model')
    const content = await provider.chatStreamWithTools(
      [{ role: 'user', content: 'hi' }],
      () => { /* ignore */ },
      () => { /* ignore */ }
    )
    expect(content).toBe('结果')
  })
})
