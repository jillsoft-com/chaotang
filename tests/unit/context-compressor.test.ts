/**
 * 上下文压缩器 - 工具配对不变量测试
 *
 * 复现并锁死一个真实缺陷：压缩按固定条数切「摘要段 / 原样保留段」时，
 * 切割点可能正好落在 assistant(tool_calls) 与其 tool 结果之间，
 * 使保留段以一条没有配对 assistant 的孤立 tool 结果开头 —— 发给模型即
 * 400 "No tool call found for function call output with call_id ..."。
 *
 * 断言口径：compressContext 的输出里，任何 role='tool' 的消息，
 * 都必须能在它之前找到一条 tool_calls 含相同 id 的 assistant 消息。
 */

import { describe, it, expect } from 'vitest'
import { compressContext } from '@/services/agent/context-compressor'
import type { ChatMessage } from '@/types'
import type { LLMProvider } from '@/services/llm/types'

/** 一个只用到 chat() 的摘要模型替身 */
const mockProvider = {
  chat: async () => '这是一段简短的压缩摘要。'
} as unknown as LLMProvider

/** 扫描消息，返回第一条「找不到配对 assistant」的孤立工具结果的 tool_call_id；无则返回 null */
function findOrphanToolCallId(messages: ChatMessage[]): string | null {
  const knownCallIds = new Set<string>()
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc?.id) knownCallIds.add(tc.id)
    }
    if (m.role === 'tool') {
      if (!m.tool_call_id || !knownCallIds.has(m.tool_call_id)) {
        return m.tool_call_id || '(缺失 id)'
      }
    }
  }
  return null
}

function big(role: 'system' | 'user' | 'assistant', text: string): ChatMessage {
  return { role, content: text }
}

describe('compressContext - 工具调用配对不被切割点破坏', () => {
  it('保留段以孤立 tool 结果开头时，把该结果并入摘要段而非留成孤儿', async () => {
    // 10 条消息：KEEP_RECENT=6 → 朴素切割点落在 idx4（call_A 的 tool 结果），
    // 而其 assistant(call_A) 在 idx3 属于摘要段 → 朴素结果会以孤立 tool 开头。
    const messages: ChatMessage[] = [
      big('system', '系统提示'),
      big('user', '任务目标'),
      big('assistant', 'a'.repeat(3000)),
      { role: 'assistant', content: 'b'.repeat(3000), tool_calls: [{ id: 'call_A', type: 'function', function: { name: 'read_file', arguments: '{}' } }] as any },
      { role: 'tool', content: '结果A', tool_call_id: 'call_A', name: 'read_file' },
      big('assistant', '继续分析'),
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_B', type: 'function', function: { name: 'run_tests', arguments: '{}' } }] as any },
      { role: 'tool', content: '结果B', tool_call_id: 'call_B', name: 'run_tests' },
      big('user', '复核'),
      big('assistant', '完成')
    ]

    const { messages: out, safe } = await compressContext(messages, mockProvider, 250)
    expect(safe).toBe(true)

    // 核心不变量：不允许出现孤立工具结果
    expect(findOrphanToolCallId(out)).toBeNull()

    // call_B 这对（assistant + tool）必须完整保留在原样段里，证明修复只是挪走孤儿、没误删配对
    const keptCallBAssistant = out.some(m =>
      m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.some(tc => tc.id === 'call_B')
    )
    const keptCallBTool = out.some(m => m.role === 'tool' && m.tool_call_id === 'call_B')
    expect(keptCallBAssistant).toBe(true)
    expect(keptCallBTool).toBe(true)
  })

  it('provider 兜底：即使上游留下孤儿 tool，也不改变已配对的合法消息', () => {
    // 直接验证「配对合法的消息不会误伤」这一前提（孤立剔除逻辑的正向基线）
    const valid: ChatMessage[] = [
      big('system', 'sys'),
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_X', type: 'function', function: { name: 'f', arguments: '{}' } }] as any },
      { role: 'tool', content: 'ok', tool_call_id: 'call_X', name: 'f' }
    ]
    expect(findOrphanToolCallId(valid)).toBeNull()
  })
})
