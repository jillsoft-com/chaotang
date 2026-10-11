/**
 * 插件安全测试
 *
 * 覆盖：
 * - 沙箱编译：禁止危险 API
 * - 第三方插件敏感工具授权检查
 * - 授权记录的持久化
 * - 提示注入隔离
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LocalStorageBackend } from '@/services/storage/local-storage'
import { setStorageBackend, resetStorageBackend } from '@/services/storage/factory'
import { initializeAppStorage, flushAppStorage, resetAppStorageForTest } from '@/services/storage/app-storage'
import {
  compileInSandbox,
  createSandboxContext,
  grantPlugin,
  revokePlugin,
  isPluginGranted,
  isSensitiveTool,
  getPluginGrants
} from '@/services/plugins/sandbox'

describe('插件沙箱', () => {
  beforeEach(async () => {
    localStorage.clear()
    resetAppStorageForTest()
    setStorageBackend(new LocalStorageBackend(''))
    await initializeAppStorage()
  })

  afterEach(async () => {
    await flushAppStorage()
    resetAppStorageForTest()
    resetStorageBackend()
    localStorage.clear()
  })

  describe('安全检查', () => {
    it('禁止 require', () => {
      expect(() => {
        compileInSandbox('require("fs")', ['test_tool'], 'test-plugin')
      }).toThrow('禁止的 API')
    })

    it('禁止 import', () => {
      expect(() => {
        compileInSandbox('import fs from "fs"', ['test_tool'], 'test-plugin')
      }).toThrow('禁止的 API')
    })

    it('禁止 eval', () => {
      expect(() => {
        compileInSandbox('eval("1+1")', ['test_tool'], 'test-plugin')
      }).toThrow('禁止的 API')
    })

    it('禁止 process 访问', () => {
      expect(() => {
        compileInSandbox('process.env', ['test_tool'], 'test-plugin')
      }).toThrow('禁止的 API')
    })

    it('禁止 globalThis 访问', () => {
      expect(() => {
        compileInSandbox('globalThis.foo', ['test_tool'], 'test-plugin')
      }).toThrow('禁止的 API')
    })
  })

  describe('敏感工具授权', () => {
    it('write_file 是敏感工具', () => {
      expect(isSensitiveTool('write_file')).toBe(true)
    })

    it('read_file 不是敏感工具', () => {
      expect(isSensitiveTool('read_file')).toBe(false)
    })

    it('第三方插件使用敏感工具需授权', () => {
      expect(() => {
        compileInSandbox(
          'function handler(args) { return args }',
          ['write_file'],
          'untrusted-plugin',
          'third-party'
        )
      }).toThrow('未获授权使用敏感工具')
    })

    it('授权后可使用敏感工具', () => {
      grantPlugin('trusted-plugin', ['write_file'])
      const handlers = compileInSandbox(
        'function handler(args) { return { ok: true } }',
        ['write_file'],
        'trusted-plugin',
        'third-party'
      )
      expect(handlers['write_file']).toBeDefined()
    })

    it('内置插件无需授权', () => {
      const handlers = compileInSandbox(
        'function handler(args) { return { ok: true } }',
        ['write_file'],
        'builtin-plugin',
        'builtin'
      )
      expect(handlers['write_file']).toBeDefined()
    })
  })

  describe('授权记录', () => {
    it('grantPlugin 保存授权', () => {
      grantPlugin('plugin-1', ['write_file', 'execute_command'])
      expect(isPluginGranted('plugin-1', 'write_file')).toBe(true)
      expect(isPluginGranted('plugin-1', 'execute_command')).toBe(true)
      expect(isPluginGranted('plugin-1', 'run_tests')).toBe(false)
    })

    it('revokePlugin 撤销授权', () => {
      grantPlugin('plugin-1', ['write_file'])
      revokePlugin('plugin-1')
      expect(isPluginGranted('plugin-1', 'write_file')).toBe(false)
    })

    it('授权记录持久化到所选存储后端', async () => {
      grantPlugin('plugin-1', ['write_file'])
      await flushAppStorage()
      const grants = getPluginGrants()
      expect(grants).toHaveLength(1)
      expect(grants[0].pluginId).toBe('plugin-1')
      expect(grants[0].grantedTools).toContain('write_file')
      expect(localStorage.getItem('ct_plugin_grants')).toContain('plugin-1')
    })

    it('合并已有授权', () => {
      grantPlugin('plugin-1', ['write_file'])
      grantPlugin('plugin-1', ['execute_command'])
      const grants = getPluginGrants()
      expect(grants).toHaveLength(1)
      expect(grants[0].grantedTools).toContain('write_file')
      expect(grants[0].grantedTools).toContain('execute_command')
    })
  })

  describe('沙箱上下文', () => {
    it('createSandboxContext 暴露安全 API', () => {
      const ctx = createSandboxContext(['my_tool'])
      expect(ctx.JSON).toBeDefined()
      expect(ctx.Math).toBeDefined()
      expect(ctx.Date).toBeDefined()
    })

    it('createSandboxContext 不暴露危险 API', () => {
      const ctx = createSandboxContext(['my_tool'])
      expect(ctx.fetch).toBeUndefined()
      expect(ctx.require).toBeUndefined()
      expect(ctx.process).toBeUndefined()
      expect(ctx.globalThis).toBeUndefined()
    })
  })

  describe('编译与执行', () => {
    it('成功编译简单 handler', () => {
      const code = `
        function handler(args) {
          return { result: args.x + args.y }
        }
      `
      const handlers = compileInSandbox(code, ['add'], 'test-plugin', 'builtin')
      expect(handlers['add']).toBeDefined()
    })

    it('handler 未定义时返回错误提示', () => {
      const code = `const x = 1`
      const handlers = compileInSandbox(code, ['missing_tool'], 'test-plugin', 'builtin')
      expect(handlers['missing_tool']).toBeDefined()
    })
  })
})
