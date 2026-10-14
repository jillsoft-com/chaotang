/**
 * test-loop 测试循环引擎 — 单元测试
 *
 * 测试测试命令检测、循环执行、修复轮次、事件发射等核心逻辑。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestLoopEngine } from '@/services/agent/test-loop'
import type { TestLoopConfig, TestLoopEvent, TestLoopResult } from '@/services/agent/test-loop'
import type { CommandExecutor } from '@/services/agent/acceptance-gate'
import type { LLMProvider } from '@/services/llm/types'
import type { ToolDefinition } from '@/types'

// ============ Mock ============

// Mock toolExecutor
vi.mock('@/services/tools/executor', () => ({
  toolExecutor: {
    execute: vi.fn()
  }
}))

// Mock context-compressor
vi.mock('@/services/agent/context-compressor', () => ({
  compressContext: vi.fn((text: string) => text)
}))

import { toolExecutor } from '@/services/tools/executor'

// ============ 辅助函数 ============

/** 模拟命令执行器 */
function mockExecutor(responses: Record<string, { exitCode: number; stdout?: string; stderr?: string; timedOut?: boolean }>): CommandExecutor {
  return {
    execute: async (cmd: string) => {
      for (const [pattern, response] of Object.entries(responses)) {
        if (cmd.includes(pattern)) {
          return {
            exitCode: response.exitCode,
            stdout: response.stdout || '',
            stderr: response.stderr || '',
            timedOut: response.timedOut || false
          }
        }
      }
      return { exitCode: 1, stdout: '', stderr: 'unknown command', timedOut: false }
    }
  }
}

/** 模拟 LLM Provider */
function mockProvider(options: { content?: string; toolCalls?: any[] } = {}): LLMProvider {
  const { content = '修复完成', toolCalls = [] } = options
  return {
    chat: vi.fn(),
    chatStream: vi.fn(),
    chatWithTools: vi.fn(),
    chatStreamWithTools: vi.fn(async (_msgs, onContent, onToolCalls) => {
      onContent?.(content)
      if (toolCalls.length > 0) {
        onToolCalls?.(toolCalls)
      }
      return content
    }),
    countTokens: vi.fn(async (text: string) => text.length),
    model: 'test-model',
    provider: 'test'
  } as any
}

/** 标准测试配置 */
function makeConfig(overrides: Partial<TestLoopConfig> = {}): TestLoopConfig {
  return {
    workingDirectory: '/test/project',
    maxRounds: 3,
    testTimeoutMs: 5000,
    ...overrides
  }
}

/** 简单工具定义 */
const mockToolDefs: ToolDefinition[] = [
  {
    function: {
      name: 'write_file',
      description: '写文件',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    function: {
      name: 'read_file',
      description: '读文件',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        },
        required: ['path']
      }
    }
  }
]

// ============ 测试用例 ============

describe('TestLoopEngine 测试循环引擎', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('测试命令检测', () => {
    it('从 package.json 检测 npm test', async () => {
      const engine = new TestLoopEngine(makeConfig())
      const executor = mockExecutor({
        'Get-Content': {
          exitCode: 0,
          stdout: JSON.stringify({ scripts: { test: 'vitest' } })
        },
        'npm run test': { exitCode: 0, stdout: 'All tests passed' }
      })

      const result = await engine.execute({
        provider: mockProvider(),
        systemPrompt: 'test',
        toolDefs: mockToolDefs,
        executor,
        goal: '修复代码',
        changedFiles: ['/test/project/src/index.ts']
      })

      expect(result.testCommand).toBe('npm run test')
      expect(result.passed).toBe(true)
      expect(result.totalRounds).toBe(1)
    })

    it('从 Cargo.toml 检测 cargo test', async () => {
      const engine = new TestLoopEngine(makeConfig())
      const executor = mockExecutor({
        'Get-Content': { exitCode: 1 },
        'Test-Path': { exitCode: 0, stdout: '' },
        '__EXISTS__': { exitCode: 0, stdout: '__EXISTS__' },
        'cargo test': { exitCode: 0, stdout: 'test result: ok' }
      })

      const result = await engine.execute({
        provider: mockProvider(),
        systemPrompt: 'test',
        toolDefs: mockToolDefs,
        executor,
        goal: '修复代码',
        changedFiles: ['/test/project/src/main.rs']
      })

      expect(result.testCommand).toBe('cargo test')
      expect(result.passed).toBe(true)
    })

    it('无法检测测试命令时返回 passed=false, testCommand=none', async () => {
      const engine = new TestLoopEngine(makeConfig())
      const executor = mockExecutor({
        'Get-Content': { exitCode: 1 },
        'Test-Path': { exitCode: 0, stdout: '' },
        'test -f': { exitCode: 1 },
        'pytest': { exitCode: 1 },
        'grep': { exitCode: 1 }
      })

      const result = await engine.execute({
        provider: mockProvider(),
        systemPrompt: 'test',
        toolDefs: mockToolDefs,
        executor,
        goal: '修复代码',
        changedFiles: ['/test/project/src/index.ts']
      })

      expect(result.passed).toBe(false)
      expect(result.testCommand).toBe('none')
      expect(result.totalRounds).toBe(0)
    })

    it('使用指定的测试命令（跳过检测）', async () => {
      const engine = new TestLoopEngine(makeConfig({ testCommand: 'npx jest --coverage' }))
      const executor = mockExecutor({
        'npx jest --coverage': { exitCode: 0, stdout: 'Tests: 5 passed' }
      })

      const result = await engine.execute({
        provider: mockProvider(),
        systemPrompt: 'test',
        toolDefs: mockToolDefs,
        executor,
        goal: '修复代码',
        changedFiles: ['/test/project/src/index.ts']
      })

      expect(result.testCommand).toBe('npx jest --coverage')
      expect(result.passed).toBe(true)
    })
  })

  describe('测试循环执行', () => {
    it('第一轮通过 → 直接返回', async () => {
      const engine = new TestLoopEngine(makeConfig({ testCommand: 'npm test' }))
      const executor = mockExecutor({
        'npm test': { exitCode: 0, stdout: 'All tests passed' }
      })

      const result = await engine.execute({
        provider: mockProvider(),
        systemPrompt: 'test',
        toolDefs: mockToolDefs,
        executor,
        goal: '修复代码',
        changedFiles: ['/test/project/src/index.ts']
      })

      expect(result.passed).toBe(true)
      expect(result.totalRounds).toBe(1)
      expect(result.rounds).toHaveLength(1)
      expect(result.rounds[0].passed).toBe(true)
      expect(result.fixToolCalls).toHaveLength(0)
    })

    it('超时视为失败', async () => {
      const engine = new TestLoopEngine(makeConfig({ testCommand: 'npm test', maxRounds: 1 }))
      const executor = mockExecutor({
        'npm test': { exitCode: 0, stdout: '', timedOut: true }
      })

      const result = await engine.execute({
        provider: mockProvider(),
        systemPrompt: 'test',
        toolDefs: mockToolDefs,
        executor,
        goal: '修复代码',
        changedFiles: ['/test/project/src/index.ts']
      })

      expect(result.passed).toBe(false)
      expect(result.rounds[0].passed).toBe(false)
      expect(result.rounds[0].timedOut).toBe(true)
    })

    it('达到最大轮次后停止', async () => {
      const engine = new TestLoopEngine(makeConfig({ testCommand: 'npm test', maxRounds: 2 }))
      const executor = mockExecutor({
        'npm test': { exitCode: 1, stderr: 'FAIL: test case 1' }
      })

      // LLM 每次修复都返回工具调用（但工具执行不影响测试仍然失败）
      vi.mocked(toolExecutor.execute).mockResolvedValue({
        toolCallId: 'tc-1',
        functionName: 'write_file',
        arguments: { path: '/test/project/src/index.ts', content: 'fixed' },
        result: { success: true },
        status: 'success',
        duration: 100
      })

      const provider = mockProvider({
        content: '已修复',
        toolCalls: [{
          id: 'tc-1',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: '/test/project/src/index.ts', content: 'fixed' })
          }
        }]
      })

      const result = await engine.execute({
        provider,
        systemPrompt: 'test',
        toolDefs: mockToolDefs,
        executor,
        goal: '修复代码',
        changedFiles: ['/test/project/src/index.ts']
      })

      expect(result.passed).toBe(false)
      expect(result.totalRounds).toBe(2)
      expect(result.rounds).toHaveLength(2)
    })
  })

  describe('事件发射', () => {
    it('发射 test-start 和 test-passed 事件', async () => {
      const engine = new TestLoopEngine(makeConfig({ testCommand: 'npm test' }))
      const executor = mockExecutor({
        'npm test': { exitCode: 0, stdout: 'All tests passed' }
      })

      const events: TestLoopEvent[] = []
      engine.onEvent((e) => events.push(e))

      await engine.execute({
        provider: mockProvider(),
        systemPrompt: 'test',
        toolDefs: mockToolDefs,
        executor,
        goal: '修复代码',
        changedFiles: ['/test/project/src/index.ts']
      })

      const eventTypes = events.map(e => e.type)
      expect(eventTypes).toContain('test-start')
      expect(eventTypes).toContain('test-result')
      expect(eventTypes).toContain('test-passed')
    })

    it('发射 fixing 事件（当测试失败时）', async () => {
      const engine = new TestLoopEngine(makeConfig({ testCommand: 'npm test', maxRounds: 2 }))
      const executor = mockExecutor({
        'npm test': { exitCode: 1, stderr: 'FAIL' }
      })

      // LLM 不返回工具调用（直接放弃修复）
      const provider = mockProvider({ content: '无法修复', toolCalls: [] })

      const events: TestLoopEvent[] = []
      engine.onEvent((e) => events.push(e))

      await engine.execute({
        provider,
        systemPrompt: 'test',
        toolDefs: mockToolDefs,
        executor,
        goal: '修复代码',
        changedFiles: ['/test/project/src/index.ts']
      })

      const eventTypes = events.map(e => e.type)
      expect(eventTypes).toContain('fixing')
      expect(eventTypes).toContain('test-failed')
    })

    it('onEvent 返回取消函数', async () => {
      const engine = new TestLoopEngine(makeConfig({ testCommand: 'npm test' }))
      const executor = mockExecutor({
        'npm test': { exitCode: 0, stdout: 'ok' }
      })

      const events: TestLoopEvent[] = []
      const unsubscribe = engine.onEvent((e) => events.push(e))
      unsubscribe() // 立即取消

      await engine.execute({
        provider: mockProvider(),
        systemPrompt: 'test',
        toolDefs: mockToolDefs,
        executor,
        goal: '修复代码',
        changedFiles: ['/test/project/src/index.ts']
      })

      expect(events).toHaveLength(0)
    })
  })

  describe('结果结构', () => {
    it('结果包含正确的 duration 和 rounds', async () => {
      const engine = new TestLoopEngine(makeConfig({ testCommand: 'npm test' }))
      const executor = mockExecutor({
        'npm test': { exitCode: 0, stdout: 'ok' }
      })

      const result = await engine.execute({
        provider: mockProvider(),
        systemPrompt: 'test',
        toolDefs: mockToolDefs,
        executor,
        goal: '修复代码',
        changedFiles: ['/test/project/src/index.ts']
      })

      expect(result.duration).toBeGreaterThanOrEqual(0)
      expect(result.rounds[0].round).toBe(1)
      expect(result.rounds[0].exitCode).toBe(0)
      expect(result.rounds[0].duration).toBeGreaterThanOrEqual(0)
      expect(typeof result.testCommand).toBe('string')
    })
  })
})
