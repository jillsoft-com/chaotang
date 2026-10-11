/**
 * 唤醒事件接口 — 任务树与后台任务的统一唤醒契约
 *
 * BackgroundScheduler 通过事件总线投递 WakeEvent，
 * TaskScheduler 监听并按 dedupKey 去重、按 authorization 决定执行方式。
 *
 * 设计依据：朝堂任务树运行时改进说明 R2。
 */

// ============ 类型 ============

export type WakeTriggerType = 'time' | 'file_change' | 'external_event'

export type WakeAuthorization = 'auto' | 'user-confirm'

export interface WakeEvent {
  /** 来源标识（bg-task-id / file-watcher / timer） */
  sourceId: string
  /** 目标树 runId */
  targetRunId: string
  /** 目标节点 ID（可选，空表示整棵树） */
  targetNodeId?: string
  /** 触发类型 */
  triggerType: WakeTriggerType
  /** 去重键：同一 dedupKey 在窗口期内不重复处理 */
  dedupKey: string
  /** 授权级别：auto = 自动执行，user-confirm = 需用户确认 */
  authorization: WakeAuthorization
  /** 事件时间戳 */
  timestamp: number
  /** 过期时间（ms 时间戳），过期后不再处理 */
  expiresAt?: number
  /** 附加数据（如文件路径、变化内容等） */
  payload?: Record<string, any>
}

// ============ 去重窗口 ============

/** 默认去重窗口（ms） */
export const DEFAULT_DEDUP_WINDOW_MS = 5000

// ============ 唤醒事件总线 ============

type WakeEventListener = (event: WakeEvent) => void

/**
 * 唤醒事件总线
 *
 * - 支持发布/订阅
 * - 按 dedupKey 去重（窗口期内同一 key 只通知一次）
 * - 过期事件自动丢弃
 */
export class WakeEventBus {
  private listeners: WakeEventListener[] = []
  private recentDedupKeys: Map<string, number> = new Map()
  private dedupWindowMs: number

  constructor(dedupWindowMs: number = DEFAULT_DEDUP_WINDOW_MS) {
    this.dedupWindowMs = dedupWindowMs
  }

  /** 订阅唤醒事件 */
  onWake(listener: WakeEventListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener)
    }
  }

  /**
   * 发布唤醒事件
   * @returns true 表示事件已投递，false 表示被去重或过期丢弃
   */
  publish(event: WakeEvent): boolean {
    // 过期检查
    if (event.expiresAt && Date.now() > event.expiresAt) {
      return false
    }

    // 去重检查
    const lastSeen = this.recentDedupKeys.get(event.dedupKey)
    if (lastSeen && Date.now() - lastSeen < this.dedupWindowMs) {
      return false
    }

    // 记录去重键
    this.recentDedupKeys.set(event.dedupKey, Date.now())

    // 清理过期的去重记录
    this.cleanupDedupKeys()

    // 通知所有监听者
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* 监听者异常不影响其他监听者 */
      }
    }

    return true
  }

  /** 清除所有监听者和去重记录 */
  destroy(): void {
    this.listeners = []
    this.recentDedupKeys.clear()
  }

  /** 清除过期的去重记录 */
  private cleanupDedupKeys(): void {
    const now = Date.now()
    for (const [key, timestamp] of this.recentDedupKeys) {
      if (now - timestamp > this.dedupWindowMs * 2) {
        this.recentDedupKeys.delete(key)
      }
    }
  }
}

/** 全局唤醒事件总线单例 */
export const wakeEventBus = new WakeEventBus()
