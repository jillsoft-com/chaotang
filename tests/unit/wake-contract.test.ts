/**
 * 唤醒契约测试
 *
 * 覆盖：
 * - WakeEventBus 发布/订阅
 * - 去重：同一 dedupKey 在窗口期内不重复
 * - 过期事件自动丢弃
 * - BackgroundScheduler 投递唤醒事件
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WakeEventBus } from '@/services/scheduler/wake-event'
import type { WakeEvent } from '@/services/scheduler/wake-event'

function makeWakeEvent(overrides?: Partial<WakeEvent>): WakeEvent {
  return {
    sourceId: 'test-source',
    targetRunId: 'run-1',
    triggerType: 'time',
    dedupKey: 'key-1',
    authorization: 'auto',
    timestamp: Date.now(),
    ...overrides
  }
}

describe('WakeEventBus', () => {
  let bus: WakeEventBus

  beforeEach(() => {
    vi.useFakeTimers()
    bus = new WakeEventBus(5000) // 5秒去重窗口
  })

  afterEach(() => {
    bus.destroy()
    vi.useRealTimers()
  })

  describe('发布/订阅', () => {
    it('订阅者收到事件', () => {
      const received: WakeEvent[] = []
      bus.onWake(e => received.push(e))

      const event = makeWakeEvent()
      const result = bus.publish(event)

      expect(result).toBe(true)
      expect(received).toHaveLength(1)
      expect(received[0].dedupKey).toBe('key-1')
    })

    it('多个订阅者都收到', () => {
      let count = 0
      bus.onWake(() => { count++ })
      bus.onWake(() => { count++ })

      bus.publish(makeWakeEvent())
      expect(count).toBe(2)
    })

    it('取消订阅后不再收到', () => {
      let count = 0
      const unsub = bus.onWake(() => { count++ })

      bus.publish(makeWakeEvent({ dedupKey: 'a' }))
      expect(count).toBe(1)

      unsub()
      bus.publish(makeWakeEvent({ dedupKey: 'b' }))
      expect(count).toBe(1)
    })
  })

  describe('去重', () => {
    it('同一 dedupKey 在窗口内不重复', () => {
      let count = 0
      bus.onWake(() => { count++ })

      const event = makeWakeEvent({ dedupKey: 'same-key' })
      bus.publish(event)
      bus.publish(event)
      bus.publish(event)

      expect(count).toBe(1)
    })

    it('不同 dedupKey 不互相影响', () => {
      let count = 0
      bus.onWake(() => { count++ })

      bus.publish(makeWakeEvent({ dedupKey: 'key-a' }))
      bus.publish(makeWakeEvent({ dedupKey: 'key-b' }))

      expect(count).toBe(2)
    })

    it('窗口过后同一 dedupKey 可再次投递', () => {
      let count = 0
      bus.onWake(() => { count++ })

      bus.publish(makeWakeEvent({ dedupKey: 'key-1' }))
      expect(count).toBe(1)

      // 推进 6 秒（超过 5 秒窗口）
      vi.advanceTimersByTime(6000)
      bus.publish(makeWakeEvent({ dedupKey: 'key-1' }))
      expect(count).toBe(2)
    })
  })

  describe('过期事件', () => {
    it('已过期的事件被丢弃', () => {
      let count = 0
      bus.onWake(() => { count++ })

      const event = makeWakeEvent({
        dedupKey: 'expired',
        expiresAt: Date.now() - 1000 // 已过期
      })
      const result = bus.publish(event)

      expect(result).toBe(false)
      expect(count).toBe(0)
    })

    it('未过期的事件正常投递', () => {
      let count = 0
      bus.onWake(() => { count++ })

      const event = makeWakeEvent({
        dedupKey: 'not-expired',
        expiresAt: Date.now() + 60000 // 1分钟后过期
      })
      const result = bus.publish(event)

      expect(result).toBe(true)
      expect(count).toBe(1)
    })
  })

  describe('监听者异常隔离', () => {
    it('一个监听者抛异常不影响其他', () => {
      let received = false
      bus.onWake(() => { throw new Error('监听者异常') })
      bus.onWake(() => { received = true })

      bus.publish(makeWakeEvent({ dedupKey: 'isolation-test' }))
      expect(received).toBe(true)
    })
  })

  describe('destroy', () => {
    it('销毁后不再通知', () => {
      let count = 0
      bus.onWake(() => { count++ })

      bus.publish(makeWakeEvent({ dedupKey: 'before' }))
      expect(count).toBe(1)

      bus.destroy()
      bus.publish(makeWakeEvent({ dedupKey: 'after' }))
      expect(count).toBe(1)
    })
  })
})
