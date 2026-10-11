/**
 * 资源读写锁 — 并发控制
 *
 * 写任务运行时，对同一文件的读节点排队。
 * 不同资源的只读节点仍可并行。
 * 取消/异常时释放锁。
 *
 * 设计依据：朝堂任务树运行时改进说明 R5。
 */

// ============ 类型 ============

export type LockType = 'read' | 'write'

export interface ResourceLock {
  resourcePath: string
  lockType: LockType
  holderNodeId: string
  acquiredAt: number
  /** 共享读锁的所有持有者（仅当 lockType === 'read' 时使用） */
  readers: Set<string>
  /** 等待此锁的节点 ID 列表 */
  waitQueue: string[]
}

export interface LockAcquireResult {
  acquired: boolean
  /** 未获取时的等待原因 */
  waitReason?: string
  /** 当前锁持有者 */
  holder?: string
}

// ============ 写工具名单 ============

/** 写操作工具列表：只读节点不应使用这些工具 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'create_directory',
  'execute_command',
  'git_operation',
  'run_tests',
  'refactor_rename'
])

/**
 * 过滤只读节点的可用工具名称列表
 * readOnly 节点不应拥有写工具，即使声明了也应被过滤掉。
 */
export function filterToolsForReadOnlyNode(allowedToolNames: string[]): string[] {
  return allowedToolNames.filter(t => !WRITE_TOOLS.has(t))
}

/**
 * 过滤只读节点的工具定义列表（实际传入 LLM 的工具集）
 * ToolDefinition 格式：{ type: 'function', function: { name: string, ... } }
 * 确保只读节点实际无法调用写工具。
 */
export function filterToolDefinitionsForReadOnlyNode<T extends { function?: { name?: string } }>(toolDefs: T[]): T[] {
  return toolDefs.filter(t => !t.function?.name || !WRITE_TOOLS.has(t.function.name))
}

// ============ 锁管理器 ============

export class ResourceLockManager {
  private locks: Map<string, ResourceLock> = new Map()

  /**
   * 尝试获取资源锁
   *
   * @param resourcePath 资源路径
   * @param lockType 锁类型
   * @param nodeId 请求者节点 ID
   * @returns 获取结果
   */
  acquire(resourcePath: string, lockType: LockType, nodeId: string): LockAcquireResult {
    const normalized = this.normalizePath(resourcePath)
    const existing = this.locks.get(normalized)

    if (!existing) {
      // 无锁：直接获取
      this.locks.set(normalized, {
        resourcePath: normalized,
        lockType,
        holderNodeId: nodeId,
        acquiredAt: Date.now(),
        readers: lockType === 'read' ? new Set([nodeId]) : new Set(),
        waitQueue: []
      })
      return { acquired: true }
    }

    // 已有锁
    if (lockType === 'read' && existing.lockType === 'read') {
      // 读-读不冲突：登记为共享读者
      existing.readers.add(nodeId)
      return { acquired: true }
    }

    // 写-写、写-读、读-写 冲突
    existing.waitQueue.push(nodeId)
    return {
      acquired: false,
      waitReason: `资源 ${resourcePath} 被节点 ${existing.holderNodeId} 以 ${existing.lockType} 锁持有`,
      holder: existing.holderNodeId
    }
  }

  /**
   * 释放资源锁
   *
   * @param resourcePath 资源路径
   * @param nodeId 释放者节点 ID
   * @returns 等待队列中的下一个节点 ID（如果有）
   */
  release(resourcePath: string, nodeId: string): string | null {
    const normalized = this.normalizePath(resourcePath)
    const lock = this.locks.get(normalized)

    if (!lock) return null

    // 共享读锁：从读者集合中移除
    if (lock.lockType === 'read' && lock.readers.has(nodeId)) {
      lock.readers.delete(nodeId)
      if (lock.readers.size > 0) {
        // 还有其他读者：不删除锁
        return null
      }
      // 最后一个读者释放：通知等待队列
      const nextWaiter = lock.waitQueue.length > 0 ? lock.waitQueue.shift()! : null
      if (nextWaiter) {
        lock.holderNodeId = nextWaiter
        lock.lockType = 'write' // 等待者通常是写者
        lock.readers = new Set()
        lock.acquiredAt = Date.now()
      } else {
        this.locks.delete(normalized)
      }
      return nextWaiter
    }

    // 写锁：检查是否是持有者
    if (lock.holderNodeId !== nodeId) {
      return null
    }

    const nextWaiter = lock.waitQueue.length > 0 ? lock.waitQueue.shift()! : null

    if (nextWaiter) {
      // 将锁转移给等待者
      lock.holderNodeId = nextWaiter
      lock.acquiredAt = Date.now()
    } else {
      // 无等待者：删除锁
      this.locks.delete(normalized)
    }

    return nextWaiter
  }

  /**
   * 强制释放节点持有的所有锁（异常退出时使用）
   */
  releaseAll(nodeId: string): string[] {
    const released: string[] = []

    for (const [path, lock] of this.locks) {
      // 检查是否是读锁的读者之一
      if (lock.lockType === 'read' && lock.readers.has(nodeId)) {
        lock.readers.delete(nodeId)
        if (lock.readers.size === 0 && lock.waitQueue.length === 0) {
          this.locks.delete(path)
        }
        released.push(path)
        continue
      }

      // 检查是否是写锁持有者
      if (lock.holderNodeId === nodeId) {
        const next = lock.waitQueue.shift()
        if (next) {
          lock.holderNodeId = next
          lock.acquiredAt = Date.now()
        } else {
          this.locks.delete(path)
        }
        released.push(path)
      } else {
        // 从等待队列中移除
        const idx = lock.waitQueue.indexOf(nodeId)
        if (idx !== -1) {
          lock.waitQueue.splice(idx, 1)
        }
      }
    }

    return released
  }

  /**
   * 获取所有当前锁状态（调试用）
   */
  getStatus(): ResourceLock[] {
    return Array.from(this.locks.values())
  }

  /**
   * 检查资源是否被锁定
   */
  isLocked(resourcePath: string): boolean {
    return this.locks.has(this.normalizePath(resourcePath))
  }

  /** 路径标准化 */
  private normalizePath(path: string): string {
    return path.replace(/\\/g, '/').toLowerCase()
  }
}

/** 全局资源锁管理器单例 */
export const resourceLockManager = new ResourceLockManager()
