/**
 * 并发控制测试
 *
 * 覆盖：
 * - 读-读不冲突
 * - 写-写冲突
 * - 写-读冲突
 * - 锁释放与等待队列
 * - 异常退出释放所有锁
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ResourceLockManager, filterToolsForReadOnlyNode, filterToolDefinitionsForReadOnlyNode, WRITE_TOOLS } from '@/services/agent/resource-lock'

describe('ResourceLockManager', () => {
  let mgr: ResourceLockManager

  beforeEach(() => {
    mgr = new ResourceLockManager()
  })

  describe('基本锁获取与释放', () => {
    it('无锁时直接获取', () => {
      const result = mgr.acquire('/src/a.ts', 'write', 'node-1')
      expect(result.acquired).toBe(true)
    })

    it('释放后锁可被其他节点获取', () => {
      mgr.acquire('/src/a.ts', 'write', 'node-1')
      mgr.release('/src/a.ts', 'node-1')
      const result = mgr.acquire('/src/a.ts', 'write', 'node-2')
      expect(result.acquired).toBe(true)
    })

    it('非持有者释放无效', () => {
      mgr.acquire('/src/a.ts', 'write', 'node-1')
      const next = mgr.release('/src/a.ts', 'node-2')
      expect(next).toBeNull()
      expect(mgr.isLocked('/src/a.ts')).toBe(true)
    })
  })

  describe('读写冲突', () => {
    it('读-读不冲突', () => {
      mgr.acquire('/src/a.ts', 'read', 'node-1')
      const result = mgr.acquire('/src/a.ts', 'read', 'node-2')
      expect(result.acquired).toBe(true)
    })

    it('写-写冲突', () => {
      mgr.acquire('/src/a.ts', 'write', 'node-1')
      const result = mgr.acquire('/src/a.ts', 'write', 'node-2')
      expect(result.acquired).toBe(false)
      expect(result.waitReason).toContain('node-1')
    })

    it('写-读冲突', () => {
      mgr.acquire('/src/a.ts', 'write', 'node-1')
      const result = mgr.acquire('/src/a.ts', 'read', 'node-2')
      expect(result.acquired).toBe(false)
    })

    it('读-写冲突', () => {
      mgr.acquire('/src/a.ts', 'read', 'node-1')
      const result = mgr.acquire('/src/a.ts', 'write', 'node-2')
      expect(result.acquired).toBe(false)
    })

    it('不同资源不冲突', () => {
      mgr.acquire('/src/a.ts', 'write', 'node-1')
      const result = mgr.acquire('/src/b.ts', 'write', 'node-2')
      expect(result.acquired).toBe(true)
    })
  })

  describe('等待队列', () => {
    it('释放时通知等待队列中的下一个', () => {
      mgr.acquire('/src/a.ts', 'write', 'node-1')
      mgr.acquire('/src/a.ts', 'write', 'node-2')
      mgr.acquire('/src/a.ts', 'write', 'node-3')

      const next = mgr.release('/src/a.ts', 'node-1')
      expect(next).toBe('node-2')

      const next2 = mgr.release('/src/a.ts', 'node-2')
      expect(next2).toBe('node-3')
    })

    it('等待队列为空时释放删除锁', () => {
      mgr.acquire('/src/a.ts', 'write', 'node-1')
      mgr.release('/src/a.ts', 'node-1')
      expect(mgr.isLocked('/src/a.ts')).toBe(false)
    })
  })

  describe('异常退出', () => {
    it('releaseAll 释放节点持有的所有锁', () => {
      mgr.acquire('/src/a.ts', 'write', 'node-1')
      mgr.acquire('/src/b.ts', 'write', 'node-1')
      mgr.acquire('/src/c.ts', 'write', 'node-2')

      const released = mgr.releaseAll('node-1')
      expect(released).toContain('/src/a.ts')
      expect(released).toContain('/src/b.ts')
      expect(mgr.isLocked('/src/c.ts')).toBe(true) // node-2 的锁不受影响
    })

    it('releaseAll 从等待队列中移除节点', () => {
      mgr.acquire('/src/a.ts', 'write', 'node-1')
      mgr.acquire('/src/a.ts', 'write', 'node-2')
      mgr.acquire('/src/a.ts', 'write', 'node-3')

      // node-2 异常退出
      mgr.releaseAll('node-2')

      // node-1 释放后应该轮到 node-3（不是 node-2）
      const next = mgr.release('/src/a.ts', 'node-1')
      expect(next).toBe('node-3')
    })
  })

  describe('路径标准化', () => {
    it('反斜杠和正斜杠视为同一路径', () => {
      mgr.acquire('C:\\src\\a.ts', 'write', 'node-1')
      const result = mgr.acquire('c:/src/a.ts', 'write', 'node-2')
      expect(result.acquired).toBe(false)
    })

    it('大小写不敏感', () => {
      mgr.acquire('/src/A.ts', 'write', 'node-1')
      const result = mgr.acquire('/src/a.ts', 'write', 'node-2')
      expect(result.acquired).toBe(false)
    })
  })

  describe('状态查询', () => {
    it('getStatus 返回所有锁', () => {
      mgr.acquire('/src/a.ts', 'write', 'node-1')
      mgr.acquire('/src/b.ts', 'read', 'node-2')
      const status = mgr.getStatus()
      expect(status).toHaveLength(2)
    })
  })

  describe('只读节点工具过滤', () => {
    it('WRITE_TOOLS 包含写操作工具（含 refactor_rename）', () => {
      expect(WRITE_TOOLS.has('write_file')).toBe(true)
      expect(WRITE_TOOLS.has('create_directory')).toBe(true)
      expect(WRITE_TOOLS.has('execute_command')).toBe(true)
      expect(WRITE_TOOLS.has('git_operation')).toBe(true)
      expect(WRITE_TOOLS.has('run_tests')).toBe(true)
      expect(WRITE_TOOLS.has('refactor_rename')).toBe(true)
    })

    it('filterToolsForReadOnlyNode 过滤写工具', () => {
      const tools = ['read_file', 'write_file', 'search_code', 'execute_command']
      const filtered = filterToolsForReadOnlyNode(tools)
      expect(filtered).toContain('read_file')
      expect(filtered).toContain('search_code')
      expect(filtered).not.toContain('write_file')
      expect(filtered).not.toContain('execute_command')
    })

    it('filterToolsForReadOnlyNode 全读工具不受影响', () => {
      const tools = ['read_file', 'search_code', 'read_directory']
      const filtered = filterToolsForReadOnlyNode(tools)
      expect(filtered).toEqual(tools)
    })

    it('filterToolsForReadOnlyNode 空列表返回空', () => {
      expect(filterToolsForReadOnlyNode([])).toEqual([])
    })
  })

  describe('ToolDefinition 过滤', () => {
    it('filterToolDefinitionsForReadOnlyNode 过滤写工具', () => {
      const defs = [
        { type: 'function' as const, function: { name: 'read_file', description: '', parameters: {} } },
        { type: 'function' as const, function: { name: 'write_file', description: '', parameters: {} } },
        { type: 'function' as const, function: { name: 'refactor_rename', description: '', parameters: {} } }
      ]
      const filtered = filterToolDefinitionsForReadOnlyNode(defs)
      expect(filtered).toHaveLength(1)
      expect(filtered[0].function.name).toBe('read_file')
    })

    it('filterToolDefinitionsForReadOnlyNode 全读工具不受影响', () => {
      const defs = [
        { type: 'function' as const, function: { name: 'read_file', description: '', parameters: {} } },
        { type: 'function' as const, function: { name: 'search_code', description: '', parameters: {} } }
      ]
      const filtered = filterToolDefinitionsForReadOnlyNode(defs)
      expect(filtered).toHaveLength(2)
    })
  })

  describe('共享读锁释放', () => {
    it('两个读者：首个释放后锁仍存在', () => {
      mgr.acquire('/src/a.ts', 'read', 'node-1')
      mgr.acquire('/src/a.ts', 'read', 'node-2')

      mgr.release('/src/a.ts', 'node-1')
      // node-2 仍在读取，锁应仍存在
      expect(mgr.isLocked('/src/a.ts')).toBe(true)
    })

    it('两个读者先后释放：第二个释放后锁删除', () => {
      mgr.acquire('/src/a.ts', 'read', 'node-1')
      mgr.acquire('/src/a.ts', 'read', 'node-2')

      mgr.release('/src/a.ts', 'node-1')
      expect(mgr.isLocked('/src/a.ts')).toBe(true)

      mgr.release('/src/a.ts', 'node-2')
      expect(mgr.isLocked('/src/a.ts')).toBe(false)
    })

    it('两个读者结束后等待的写者获得锁', () => {
      mgr.acquire('/src/a.ts', 'read', 'node-1')
      mgr.acquire('/src/a.ts', 'read', 'node-2')
      // 写者等待
      const writeResult = mgr.acquire('/src/a.ts', 'write', 'node-3')
      expect(writeResult.acquired).toBe(false)

      // node-1 释放：锁仍存在（node-2 还在读）
      mgr.release('/src/a.ts', 'node-1')
      expect(mgr.isLocked('/src/a.ts')).toBe(true)

      // node-2 释放：写者 node-3 获得锁
      const next = mgr.release('/src/a.ts', 'node-2')
      expect(next).toBe('node-3')
    })

    it('releaseAll 释放读者之一不影响其他读者', () => {
      mgr.acquire('/src/a.ts', 'read', 'node-1')
      mgr.acquire('/src/a.ts', 'read', 'node-2')

      mgr.releaseAll('node-1')
      expect(mgr.isLocked('/src/a.ts')).toBe(true)

      mgr.releaseAll('node-2')
      expect(mgr.isLocked('/src/a.ts')).toBe(false)
    })
  })
})
