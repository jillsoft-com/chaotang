/**
 * acceptance-gate 验收状态机 — 单元测试
 *
 * 测试验收状态推导、命令推断、GateState 转换等核心逻辑。
 */

import { describe, it, expect } from 'vitest'
import {
  evaluateGate,
  collectChangedFiles,
  runAcceptanceChecks,
  buildAcceptancePlan,
  runAcceptance,
  extractRepairDiagnostics,
  hasNewEvidence
} from '@/services/agent/acceptance-gate'
import type { AcceptancePlan, CheckRecord, CommandExecutor } from '@/services/agent/acceptance-gate'

// ============ 辅助函数 ============

function makeCheck(overrides: Partial<CheckRecord> = {}): CheckRecord {
  return {
    kind: 'test',
    command: 'npm test',
    status: 'pending',
    summary: '',
    ...overrides
  }
}

function makePlan(checks: CheckRecord[]): AcceptancePlan {
  return { checks, overallState: 'pending' }
}

/** 模拟命令执行器 */
function mockExecutor(responses: Record<string, { exitCode: number; stdout?: string; stderr?: string; timedOut?: boolean }>): CommandExecutor {
  return {
    execute: async (cmd: string) => {
      // 查找匹配的响应（支持部分匹配）
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

// ============ 测试用例 ============

describe('acceptance-gate 验收状态机', () => {
  describe('evaluateGate — 状态推导', () => {
    it('无检查 → unverified', () => {
      const plan = makePlan([])
      expect(evaluateGate(plan)).toBe('unverified')
    })

    it('全部 passed → passed', () => {
      const plan = makePlan([
        makeCheck({ status: 'passed' }),
        makeCheck({ kind: 'build', status: 'passed' })
      ])
      expect(evaluateGate(plan)).toBe('passed')
    })

    it('任一 failed → failed', () => {
      const plan = makePlan([
        makeCheck({ status: 'passed' }),
        makeCheck({ status: 'failed' })
      ])
      expect(evaluateGate(plan)).toBe('failed')
    })

    it('有 pending → running', () => {
      const plan = makePlan([
        makeCheck({ status: 'passed' }),
        makeCheck({ status: 'pending' })
      ])
      expect(evaluateGate(plan)).toBe('running')
    })

    it('有 running → running', () => {
      const plan = makePlan([
        makeCheck({ status: 'running' }),
        makeCheck({ status: 'passed' })
      ])
      expect(evaluateGate(plan)).toBe('running')
    })

    it('全部 failed → failed', () => {
      const plan = makePlan([
        makeCheck({ status: 'failed' }),
        makeCheck({ kind: 'build', status: 'failed' })
      ])
      expect(evaluateGate(plan)).toBe('failed')
    })

    it('单条 passed → passed', () => {
      const plan = makePlan([makeCheck({ status: 'passed' })])
      expect(evaluateGate(plan)).toBe('passed')
    })

    it('单条 failed → failed', () => {
      const plan = makePlan([makeCheck({ status: 'failed' })])
      expect(evaluateGate(plan)).toBe('failed')
    })
  })

  describe('collectChangedFiles — 文件收集', () => {
    it('收集 write_file 成功的路径', () => {
      const toolCalls = [
        { functionName: 'write_file', status: 'success', arguments: { path: '/a/b.ts' } },
        { functionName: 'read_file', status: 'success', arguments: { path: '/c/d.ts' } }
      ]
      const files = collectChangedFiles(toolCalls)
      expect(files).toEqual(['/a/b.ts'])
    })

    it('收集 search_replace 成功的路径', () => {
      const toolCalls = [
        { functionName: 'search_replace', status: 'success', arguments: { path: '/x/y.ts' } }
      ]
      const files = collectChangedFiles(toolCalls)
      expect(files).toEqual(['/x/y.ts'])
    })

    it('收集 create_directory 成功的路径', () => {
      const toolCalls = [
        { functionName: 'create_directory', status: 'success', arguments: { path: '/new/dir' } }
      ]
      const files = collectChangedFiles(toolCalls)
      expect(files).toEqual(['/new/dir'])
    })

    it('忽略失败的写操作', () => {
      const toolCalls = [
        { functionName: 'write_file', status: 'error', arguments: { path: '/fail.ts' } }
      ]
      const files = collectChangedFiles(toolCalls)
      expect(files).toEqual([])
    })

    it('去重', () => {
      const toolCalls = [
        { functionName: 'write_file', status: 'success', arguments: { path: '/same.ts' } },
        { functionName: 'write_file', status: 'success', arguments: { path: '/same.ts' } }
      ]
      const files = collectChangedFiles(toolCalls)
      expect(files).toEqual(['/same.ts'])
    })

    it('空工具调用 → 空数组', () => {
      const files = collectChangedFiles([])
      expect(files).toEqual([])
    })

    it('无参数时安全处理', () => {
      const toolCalls = [
        { functionName: 'write_file', status: 'success' }
      ]
      const files = collectChangedFiles(toolCalls)
      expect(files).toEqual([])
    })
  })

  describe('runAcceptanceChecks — 执行检查', () => {
    it('命令成功 → passed', async () => {
      const plan = makePlan([
        makeCheck({ kind: 'test', command: 'npm test' })
      ])
      const executor = mockExecutor({
        'npm test': { exitCode: 0, stdout: 'All tests passed' }
      })

      const result = await runAcceptanceChecks(plan, executor, '/work')
      expect(result.checks[0].status).toBe('passed')
      expect(result.checks[0].exitCode).toBe(0)
      expect(result.overallState).toBe('passed')
    })

    it('命令失败 → failed', async () => {
      const plan = makePlan([
        makeCheck({ kind: 'test', command: 'npm test' })
      ])
      const executor = mockExecutor({
        'npm test': { exitCode: 1, stderr: 'FAIL: test case' }
      })

      const result = await runAcceptanceChecks(plan, executor, '/work')
      expect(result.checks[0].status).toBe('failed')
      expect(result.checks[0].exitCode).toBe(1)
      expect(result.overallState).toBe('failed')
    })

    it('命令超时 → failed', async () => {
      const plan = makePlan([
        makeCheck({ kind: 'build', command: 'npm run build' })
      ])
      const executor = mockExecutor({
        'npm run build': { exitCode: -1, timedOut: true }
      })

      const result = await runAcceptanceChecks(plan, executor, '/work')
      expect(result.checks[0].status).toBe('failed')
      expect(result.checks[0].timedOut).toBe(true)
      expect(result.overallState).toBe('failed')
    })

    it('多条检查：部分失败不影响后续执行', async () => {
      const plan = makePlan([
        makeCheck({ kind: 'typecheck', command: 'tsc --noEmit' }),
        makeCheck({ kind: 'test', command: 'npm test' })
      ])
      const executor = mockExecutor({
        'tsc --noEmit': { exitCode: 1, stderr: 'Type error' },
        'npm test': { exitCode: 0, stdout: 'OK' }
      })

      const result = await runAcceptanceChecks(plan, executor, '/work')
      expect(result.checks[0].status).toBe('failed')
      expect(result.checks[1].status).toBe('passed')
      expect(result.overallState).toBe('failed')
    })

    it('空检查列表 → unverified', async () => {
      const plan = makePlan([])
      const executor = mockExecutor({})

      const result = await runAcceptanceChecks(plan, executor, '/work')
      expect(result.overallState).toBe('unverified')
    })

    it('记录执行时间', async () => {
      const plan = makePlan([
        makeCheck({ kind: 'test', command: 'npm test' })
      ])
      const executor = mockExecutor({
        'npm test': { exitCode: 0 }
      })

      const result = await runAcceptanceChecks(plan, executor, '/work')
      expect(result.checks[0].startedAt).toBeDefined()
      expect(result.checks[0].finishedAt).toBeDefined()
      expect(result.checks[0].finishedAt!).toBeGreaterThanOrEqual(result.checks[0].startedAt!)
    })

    it('不修改原 plan 对象', async () => {
      const plan = makePlan([
        makeCheck({ kind: 'test', command: 'npm test', status: 'pending' })
      ])
      const executor = mockExecutor({
        'npm test': { exitCode: 0 }
      })

      await runAcceptanceChecks(plan, executor, '/work')
      // 原始 plan 不变
      expect(plan.checks[0].status).toBe('pending')
    })
  })

  describe('buildAcceptancePlan — 命令推断', () => {
    it('无变更文件 → unverified', async () => {
      const executor = mockExecutor({})
      const plan = await buildAcceptancePlan('/work', [], executor)
      expect(plan.overallState).toBe('unverified')
      expect(plan.checks.length).toBe(0)
    })

    it('有 package.json test 脚本 → 推断 test 检查', async () => {
      const executor = mockExecutor({
        'cat package.json': {
          exitCode: 0,
          stdout: JSON.stringify({ scripts: { test: 'vitest run', build: 'vite build' } })
        }
      })
      const plan = await buildAcceptancePlan('/work', ['/src/a.ts'], executor)
      expect(plan.checks.length).toBeGreaterThan(0)
      // build 优先级高于 test
      expect(plan.checks[0].kind).toBe('build')
    })

    it('有 tsconfig.json 但无 package.json → typecheck', async () => {
      const executor = mockExecutor({
        'cat package.json': { exitCode: 1 },
        'test -f tsconfig.json': { exitCode: 0, stdout: 'exists' },
        'npx tsc --version': { exitCode: 0, stdout: 'Version 5.0.0' }
      })
      const plan = await buildAcceptancePlan('/work', ['/src/a.ts'], executor)
      expect(plan.checks.length).toBeGreaterThan(0)
      expect(plan.checks.some(c => c.kind === 'typecheck')).toBe(true)
    })

    it('有 Cargo.toml → cargo build + cargo test', async () => {
      const executor = mockExecutor({
        'cat package.json': { exitCode: 1 },
        'test -f tsconfig.json': { exitCode: 1 },
        'test -f Cargo.toml': { exitCode: 0, stdout: 'exists' }
      })
      const plan = await buildAcceptancePlan('/work', ['/src/main.rs'], executor)
      expect(plan.checks.length).toBe(2)
      expect(plan.checks[0].command).toBe('cargo build')
      expect(plan.checks[1].command).toBe('cargo test')
    })

    it('有 go.mod → go build + go test', async () => {
      const executor = mockExecutor({
        'cat package.json': { exitCode: 1 },
        'test -f tsconfig.json': { exitCode: 1 },
        'test -f Cargo.toml': { exitCode: 1 },
        'test -f go.mod': { exitCode: 0, stdout: 'exists' }
      })
      const plan = await buildAcceptancePlan('/work', ['/main.go'], executor)
      expect(plan.checks.length).toBe(2)
      expect(plan.checks[0].command).toBe('go build ./...')
      expect(plan.checks[1].command).toBe('go test ./...')
    })

    it('无可用检查 → unverified', async () => {
      const executor = mockExecutor({
        'cat package.json': { exitCode: 1 },
        'test -f tsconfig.json': { exitCode: 1 },
        'test -f Cargo.toml': { exitCode: 1 },
        'test -f go.mod': { exitCode: 1 },
        'test -f requirements.txt -o -f pyproject.toml -o -f setup.py': { exitCode: 1 }
      })
      const plan = await buildAcceptancePlan('/work', ['/readme.txt'], executor)
      expect(plan.overallState).toBe('unverified')
    })
  })

  describe('runAcceptance — 一步完成验收', () => {
    it('无变更文件 → unverified', async () => {
      const executor = mockExecutor({})
      const result = await runAcceptance('/work', [], executor)
      expect(result.overallState).toBe('unverified')
    })

    it('有变更文件且检查通过 → passed', async () => {
      const executor = mockExecutor({
        'cat package.json': {
          exitCode: 0,
          stdout: JSON.stringify({ scripts: { test: 'vitest run' } })
        },
        'npm run test': { exitCode: 0, stdout: 'All passed' }
      })
      const result = await runAcceptance('/work', ['/src/a.ts'], executor)
      expect(result.overallState).toBe('passed')
    })

    it('有变更文件但检查失败 → failed', async () => {
      const executor = mockExecutor({
        'cat package.json': {
          exitCode: 0,
          stdout: JSON.stringify({ scripts: { test: 'vitest run' } })
        },
        'npm run test': { exitCode: 1, stderr: 'FAIL' }
      })
      const result = await runAcceptance('/work', ['/src/a.ts'], executor)
      expect(result.overallState).toBe('failed')
    })
  })

  describe('extractRepairDiagnostics — 诊断提取', () => {
    it('无失败检查 → 空字符串', () => {
      const plan = makePlan([makeCheck({ status: 'passed' })])
      expect(extractRepairDiagnostics(plan)).toBe('')
    })

    it('有失败检查 → 包含诊断信息', () => {
      const plan = makePlan([
        makeCheck({ kind: 'test', command: 'npm test', status: 'failed', exitCode: 1, summary: 'FAIL: test case' })
      ])
      const diag = extractRepairDiagnostics(plan)
      expect(diag).toContain('npm test')
      expect(diag).toContain('FAIL: test case')
      expect(diag).toContain('退出码')
    })

    it('多条失败检查 → 全部包含', () => {
      const plan = makePlan([
        makeCheck({ kind: 'typecheck', command: 'tsc', status: 'failed', exitCode: 2, summary: 'Type error' }),
        makeCheck({ kind: 'test', command: 'npm test', status: 'failed', exitCode: 1, summary: 'Test failed' })
      ])
      const diag = extractRepairDiagnostics(plan)
      expect(diag).toContain('tsc')
      expect(diag).toContain('npm test')
    })
  })

  describe('hasNewEvidence — 新证据检测', () => {
    it('相同失败 → 无新证据', () => {
      const prev = makePlan([
        makeCheck({ kind: 'test', command: 'npm test', status: 'failed', summary: 'FAIL: same error' })
      ])
      const curr = makePlan([
        makeCheck({ kind: 'test', command: 'npm test', status: 'failed', summary: 'FAIL: same error' })
      ])
      expect(hasNewEvidence(prev, curr)).toBe(false)
    })

    it('不同错误信息 → 有新证据', () => {
      const prev = makePlan([
        makeCheck({ kind: 'test', command: 'npm test', status: 'failed', summary: 'FAIL: error A' })
      ])
      const curr = makePlan([
        makeCheck({ kind: 'test', command: 'npm test', status: 'failed', summary: 'FAIL: error B' })
      ])
      expect(hasNewEvidence(prev, curr)).toBe(true)
    })

    it('失败数量变化 → 有新证据', () => {
      const prev = makePlan([
        makeCheck({ kind: 'test', command: 'npm test', status: 'failed', summary: 'FAIL' })
      ])
      const curr = makePlan([
        makeCheck({ kind: 'test', command: 'npm test', status: 'failed', summary: 'FAIL' }),
        makeCheck({ kind: 'build', command: 'npm run build', status: 'failed', summary: 'Build error' })
      ])
      expect(hasNewEvidence(prev, curr)).toBe(true)
    })

    it('从失败到通过 → 有新证据', () => {
      const prev = makePlan([
        makeCheck({ kind: 'test', command: 'npm test', status: 'failed', summary: 'FAIL' })
      ])
      const curr = makePlan([
        makeCheck({ kind: 'test', command: 'npm test', status: 'passed' })
      ])
      expect(hasNewEvidence(prev, curr)).toBe(true)
    })
  })
})
