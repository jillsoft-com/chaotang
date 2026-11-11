/**
 * 浏览器动作可视化数据层测试（M5）
 *
 * 假鼠标画在独立的透明覆盖窗里，没有 Electron 就看不见，所以能被单测钉住的
 * 是它背后的判断规则：什么算一条合法动作、坐标怎么落进可视区、
 * 哪个标签页的动作才配显示、什么时候该闭嘴。这些规则错了，
 * 界面上的表现就是「箭头乱指」或「永远不动」，而且现场很难复现，所以在这里钉死。
 */

import { describe, it } from 'vitest'
import {
  GESTURE_LOG_LIMIT,
  GESTURE_FRESH_MS,
  GESTURE_TYPES,
  belongsToTab,
  clampToViewport,
  gestureLabel,
  gesturesSince,
  isFresh,
  latestVisibleGesture,
  normalizeGesture,
  pushGesture,
  type Gesture
} from '@/services/browser/browser-gesture'

function make(over: Partial<Gesture> = {}): Gesture {
  return {
    seq: 1,
    type: 'click',
    tabId: 'b1',
    x: 100,
    y: 200,
    key: '',
    deltaX: 0,
    deltaY: 0,
    length: 0,
    synthetic: false,
    at: 1000,
    ...over
  }
}

describe('normalizeGesture 把不可信载荷规整成内部结构', () => {
  it('五种动作都能落地，坐标取整、缺省字段有默认值', () => {
    for (const type of GESTURE_TYPES) {
      const g = normalizeGesture({ type, tabId: 'b2', x: 12.7, y: 30.2 }, 7, 5000)
      expect(g?.type).toBe(type)
      expect(g?.seq).toBe(7)
      expect(g?.x).toBe(13)
      expect(g?.y).toBe(30)
      expect(g?.tabId).toBe('b2')
      expect(g?.at).toBe(5000)
      expect(g?.synthetic).toBe(false)
    }
  })

  it('未知类型、缺类型、空载荷一律丢弃', () => {
    expect(normalizeGesture({ type: 'drag' }, 1)).toBeNull()
    expect(normalizeGesture({}, 1)).toBeNull()
    expect(normalizeGesture(null, 1)).toBeNull()
    expect(normalizeGesture(undefined, 1)).toBeNull()
    // 主进程将来可能新增动作类型：界面看不懂就不要画，别画个含义不明的箭头
    expect(normalizeGesture({ type: 'doubleClick', x: 1, y: 1 }, 1)).toBeNull()
  })

  it('seq 非法时丢弃（序号是消费方判断新唯一的依据，缺了就是脏数据）', () => {
    expect(normalizeGesture({ type: 'click' }, Number.NaN)).toBeNull()
  })

  it('没有坐标的动作允许存在，但坐标非有限值时记为 null 而不是 0', () => {
    const keyOnly = normalizeGesture({ type: 'key', key: 'Enter' }, 3)
    expect(keyOnly?.x).toBeNull()
    expect(keyOnly?.y).toBeNull()
    // 0,0 会被当成「点了页面左上角」，这是凭空造假象，必须丢
    expect(normalizeGesture({ type: 'click', x: 'abc', y: undefined }, 3)?.x).toBeNull()
    expect(normalizeGesture({ type: 'click', x: Number.NaN, y: 5 }, 3)?.x).toBeNull()
    expect(normalizeGesture({ type: 'click', x: 5, y: 5 }, 3)?.y).toBe(5)
  })

  it('synthetic 只认真正的 true', () => {
    expect(normalizeGesture({ type: 'click', x: 1, y: 1, synthetic: true }, 1)?.synthetic).toBe(true)
    expect(normalizeGesture({ type: 'click', x: 1, y: 1, synthetic: 'true' as any }, 1)?.synthetic).toBe(false)
    expect(normalizeGesture({ type: 'click', x: 1, y: 1 }, 1)?.synthetic).toBe(false)
  })

  it('delta 与字数取非负整数，tabId 缺失时留空串', () => {
    const g = normalizeGesture({ type: 'wheel', deltaX: -120.4, deltaY: 0 }, 1)
    expect(g?.deltaX).toBe(-120)
    expect(g?.deltaY).toBe(0)
    expect(g?.tabId).toBe('')
    // 负数是坏数据，钳成 0：字数只用来显示「填了几个字」，不该出现 -5
    expect(normalizeGesture({ type: 'type', length: -5 }, 1)?.length).toBe(0)
    expect(normalizeGesture({ type: 'type', length: 8.6 }, 1)?.length).toBe(9)
  })
})

describe('坐标与标签页过滤', () => {
  it('坐标钳进可视区，越界的假鼠标不能飘到窗口外面', () => {
    const vp = { width: 800, height: 600 }
    expect(clampToViewport(make({ x: 1200, y: -30 }), vp)).toEqual({ x: 799, y: 0 })
    expect(clampToViewport(make({ x: 400, y: 300 }), vp)).toEqual({ x: 400, y: 300 })
    expect(clampToViewport(make({ x: 799, y: 599 }), vp)).toEqual({ x: 799, y: 599 })
  })

  it('没有坐标 / 视口非法时不给出坐标', () => {
    expect(clampToViewport(make({ x: null, y: 10 }), { width: 800, height: 600 })).toBeNull()
    expect(clampToViewport(make(), { width: 0, height: 0 })).toEqual({ x: 100, y: 200 })
    expect(clampToViewport(make(), undefined as any)).toEqual({ x: 100, y: 200 })
  })

  it('只有活动标签页的动作才该画在那块矩形上', () => {
    expect(belongsToTab(make({ tabId: 'b1' }), 'b1')).toBe(true)
    // 后台标签页的动作画到活动页上等于指错地方，比什么都不画更糟
    expect(belongsToTab(make({ tabId: 'b2' }), 'b1')).toBe(false)
    expect(belongsToTab(make({ tabId: '' }), 'b1')).toBe(true)
    expect(belongsToTab(make({ tabId: 'b1' }), '')).toBe(false)
  })

  it('新鲜度：过期动作不再提示', () => {
    expect(isFresh(make({ at: 1000 }), 1000 + GESTURE_FRESH_MS)).toBe(true)
    expect(isFresh(make({ at: 1000 }), 1000 + GESTURE_FRESH_MS + 1)).toBe(false)
    expect(isFresh(null)).toBe(false)
  })

  it('latestVisibleGesture 跳过别的标签页与过期项，取最近一条可见的', () => {
    const now = 10_000
    const log = [
      make({ seq: 1, at: now - 100 }),
      make({ seq: 2, tabId: 'b9', at: now - 50 }),
      make({ seq: 3, type: 'hover', at: now - GESTURE_FRESH_MS - 5000 }),
      make({ seq: 4, tabId: 'b9', at: now - 20 })
    ]
    const got = latestVisibleGesture(log, 'b1', now)
    // 序号 2/4 属于其它标签页、序号 3 已经过期，都不能顶替唯一合规的 1
    expect(got?.seq).toBe(1)
    expect(latestVisibleGesture([log[1], log[2]], 'b1', now)).toBeNull()
    expect(latestVisibleGesture([], 'b1', now)).toBeNull()
  })
})

describe('动作日志的边界', () => {
  it('有条数上限，超出后丢最旧的（内存与响应式开销必须有界）', () => {
    let log: Gesture[] = []
    for (let i = 1; i <= GESTURE_LOG_LIMIT + 5; i++) {
      log = pushGesture(log, make({ seq: i }))
    }
    expect(log.length).toBe(GESTURE_LOG_LIMIT)
    expect(log[0].seq).toBe(6)
    expect(log[log.length - 1].seq).toBe(GESTURE_LOG_LIMIT + 5)
  })

  it('pushGesture 返回新数组，不改原数组（Vue 的响应式靠引用变化）', () => {
    const origin: Gesture[] = [make({ seq: 1 })]
    const next = pushGesture(origin, make({ seq: 2 }))
    expect(origin.length).toBe(1)
    expect(next.length).toBe(2)
  })

  it('gesturesSince 能捞出同帧内连续多条，不丢动作', () => {
    const log = [make({ seq: 3 }), make({ seq: 4 }), make({ seq: 5 })]
    expect(gesturesSince(log, 3).map(g => g.seq)).toEqual([4, 5])
    // 面板刚挂载时记住当前序号，之前的历史不该被当成新动作再放一遍动画
    expect(gesturesSince(log, 5)).toEqual([])
  })
})

describe('gestureLabel 的措辞', () => {
  it('五种动作各有一句人话', () => {
    expect(gestureLabel(make())).toBe('点击 (100, 200)')
    expect(gestureLabel(make({ type: 'hover' }))).toBe('悬停 (100, 200)')
    expect(gestureLabel(make({ type: 'key', key: 'Enter' }))).toBe('按下 Enter')
    expect(gestureLabel(make({ type: 'key', key: '' }))).toBe('按下 键')
    expect(gestureLabel(make({ type: 'wheel', deltaY: 400 }))).toBe('向下滚动 400px')
    expect(gestureLabel(make({ type: 'wheel', deltaY: -200 }))).toBe('向上滚动 200px')
    expect(gestureLabel(make({ type: 'wheel', deltaX: 300, deltaY: 100 }))).toBe('向右滚动 300px')
    expect(gestureLabel(make({ type: 'wheel', deltaX: -300, deltaY: -100 }))).toBe('向左滚动 300px')
  })

  it('填写动作只报字数，正文绝不进文案（表单里可能是密码）', () => {
    const g = make({ type: 'type', length: 12 })
    const text = gestureLabel(g)
    expect(text).toContain('12 字')
    expect(text).not.toContain('正文')
    expect(text).not.toContain('password')
  })

  it('合成事件必须标成示意，不让人误以为页面真收到了事件', () => {
    expect(gestureLabel(make({ synthetic: true }))).toContain('示意')
    expect(gestureLabel(make({ synthetic: true }))).toContain('合成')
    expect(gestureLabel(make({ synthetic: false }))).not.toContain('示意')
  })

  it('没有坐标时不编造坐标', () => {
    expect(gestureLabel(make({ x: null, y: null }))).toBe('点击')
    expect(gestureLabel(make({ type: 'hover', x: null, y: null }))).toBe('悬停')
  })
})
