/**
 * 后台任务调度器 — 退朝后持续运行
 *
 * 支持：
 * 1. 延时任务：指定时间后执行
 * 2. 周期任务：按间隔重复执行
 * 3. "再上奏"机制：丞相在朝议结束后跟踪指标，触发新奏报
 * 4. 任务持久化：通过 localStorage 跨会话保留
 *
 * Sprint C - #9
 */

// ============ 类型 ============

export type BackgroundTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export type BackgroundTaskType =
  | 'delayed'       // 延时执行一次
  | 'interval'      // 周期执行
  | 'follow-up'     // 再上奏（朝议后续跟踪）
  | 'long-debate'   // 长辩论（跨会话的持续讨论）

export interface BackgroundTask {
  id: string
  type: BackgroundTaskType
  /** 关联的朝议 ID（可选） */
  debateId?: string
  /** 任务标题 */
  title: string
  /** 任务描述 */
  description: string
  /** 创建时间 */
  createdAt: number
  /** 下次执行时间 */
  nextRunAt: number
  /** 执行间隔（ms），仅 interval 类型 */
  intervalMs?: number
  /** 最大执行次数，仅 interval 类型 */
  maxRuns?: number
  /** 已执行次数 */
  runCount: number
  /** 状态 */
  status: BackgroundTaskStatus
  /** 最近一次执行结果 */
  lastResult?: string
  /** 最近一次执行时间 */
  lastRunAt?: number
  /** 错误信息 */
  error?: string
  /** 任务载荷（JSON） */
  payload?: Record<string, any>
}

export interface FollowUpConfig {
  /** 朝议 ID */
  debateId: string
  /** 跟踪指标/问题 */
  metrics: string[]
  /** 触发条件描述 */
  triggerCondition: string
  /** 跟踪截止时间（ms 时间戳，0 = 永久） */
  deadline?: number
  /** 检查间隔（ms），默认 30 分钟 */
  checkIntervalMs?: number
}

type TaskHandler = (task: BackgroundTask) => Promise<string>

// ============ 调度器 ============

class BackgroundScheduler {
  private tasks = new Map<string, BackgroundTask>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private handlers = new Map<BackgroundTaskType, TaskHandler>()
  private listeners: Array<(event: string, task: BackgroundTask) => void> = []

  constructor() {
    this.loadTasks()
    this.registerDefaultHandlers()
    this.resumePendingTasks()
  }

  // ============ 公共 API ============

  /**
   * 创建一个延时任务
   */
  scheduleDelayed(params: {
    title: string
    description: string
    delayMs: number
    debateId?: string
    payload?: Record<string, any>
  }): BackgroundTask {
    const task: BackgroundTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'delayed',
      title: params.title,
      description: params.description,
      debateId: params.debateId,
      createdAt: Date.now(),
      nextRunAt: Date.now() + params.delayMs,
      runCount: 0,
      status: 'pending',
      payload: params.payload
    }
    this.addTask(task)
    return task
  }

  /**
   * 创建一个周期任务
   */
  scheduleInterval(params: {
    title: string
    description: string
    intervalMs: number
    maxRuns?: number
    debateId?: string
    payload?: Record<string, any>
  }): BackgroundTask {
    const task: BackgroundTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'interval',
      title: params.title,
      description: params.description,
      debateId: params.debateId,
      createdAt: Date.now(),
      nextRunAt: Date.now() + params.intervalMs,
      intervalMs: params.intervalMs,
      maxRuns: params.maxRuns || 100,
      runCount: 0,
      status: 'pending',
      payload: params.payload
    }
    this.addTask(task)
    return task
  }

  /**
   * 创建"再上奏"跟踪任务
   * 朝议结束后，丞相持续跟踪指定指标，条件满足时触发新奏报
   */
  scheduleFollowUp(config: FollowUpConfig): BackgroundTask {
    const task: BackgroundTask = {
      id: `followup_${config.debateId}_${Date.now()}`,
      type: 'follow-up',
      debateId: config.debateId,
      title: `再上奏：跟踪 ${config.metrics.join(', ')}`,
      description: `跟踪条件：${config.triggerCondition}`,
      createdAt: Date.now(),
      nextRunAt: Date.now() + (config.checkIntervalMs || 30 * 60 * 1000),
      intervalMs: config.checkIntervalMs || 30 * 60 * 1000,
      maxRuns: 50,
      runCount: 0,
      status: 'pending',
      payload: {
        metrics: config.metrics,
        triggerCondition: config.triggerCondition,
        deadline: config.deadline || 0
      }
    }
    this.addTask(task)
    return task
  }

  /**
   * 创建长辩论任务（跨会话的持续讨论）
   * 将朝议拆解为多个阶段，在不同时间段依次执行
   */
  scheduleLongDebate(params: {
    debateId: string
    topic: string
    stages: string[]
    stageIntervalMs?: number
  }): BackgroundTask {
    const task: BackgroundTask = {
      id: `longdebate_${params.debateId}`,
      type: 'long-debate',
      debateId: params.debateId,
      title: `长辩论：${params.topic}`,
      description: `共 ${params.stages.length} 个阶段`,
      createdAt: Date.now(),
      nextRunAt: Date.now() + (params.stageIntervalMs || 60 * 60 * 1000),
      intervalMs: params.stageIntervalMs || 60 * 60 * 1000,
      maxRuns: params.stages.length,
      runCount: 0,
      status: 'pending',
      payload: {
        topic: params.topic,
        stages: params.stages,
        currentStage: 0
      }
    }
    this.addTask(task)
    return task
  }

  /**
   * 取消任务
   */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false

    task.status = 'cancelled'
    const timer = this.timers.get(taskId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(taskId)
    }
    this.saveTasks()
    this.emit('cancelled', task)
    return true
  }

  /**
   * 获取所有任务
   */
  getAll(): BackgroundTask[] {
    return Array.from(this.tasks.values())
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * 获取活跃任务（pending + running）
   */
  getActive(): BackgroundTask[] {
    return this.getAll().filter(t => t.status === 'pending' || t.status === 'running')
  }

  /**
   * 获取指定任务
   */
  get(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId)
  }

  /**
   * 注册任务类型处理器
   */
  registerHandler(type: BackgroundTaskType, handler: TaskHandler): void {
    this.handlers.set(type, handler)
  }

  /**
   * 添加事件监听
   */
  onEvent(callback: (event: string, task: BackgroundTask) => void): () => void {
    this.listeners.push(callback)
    return () => {
      this.listeners = this.listeners.filter(cb => cb !== callback)
    }
  }

  /**
   * 清理已完成/已取消的旧任务（保留最近 30 天）
   */
  cleanup(maxAgeDays: number = 30): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    let removed = 0
    for (const [id, task] of this.tasks) {
      if ((task.status === 'completed' || task.status === 'cancelled' || task.status === 'failed')
          && task.createdAt < cutoff) {
        this.tasks.delete(id)
        removed++
      }
    }
    if (removed > 0) this.saveTasks()
    return removed
  }

  // ============ 内部实现 ============

  private addTask(task: BackgroundTask): void {
    this.tasks.set(task.id, task)
    this.saveTasks()
    this.scheduleTimer(task)
    this.emit('created', task)
  }

  private scheduleTimer(task: BackgroundTask): void {
    if (task.status !== 'pending') return

    // 清理旧定时器
    const existing = this.timers.get(task.id)
    if (existing) clearTimeout(existing)

    const delay = Math.max(0, task.nextRunAt - Date.now())
    const timer = setTimeout(() => this.executeTask(task.id), delay)
    this.timers.set(task.id, timer)
  }

  private async executeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task || task.status === 'cancelled') return

    task.status = 'running'
    this.emit('running', task)

    const handler = this.handlers.get(task.type)
    if (!handler) {
      task.status = 'failed'
      task.error = `未注册处理器: ${task.type}`
      this.saveTasks()
      this.emit('failed', task)
      return
    }

    try {
      const result = await handler(task)
      task.lastResult = result.slice(0, 500)
      task.lastRunAt = Date.now()
      task.runCount++

      // 周期任务：安排下次执行
      if (task.type === 'interval' || task.type === 'follow-up' || task.type === 'long-debate') {
        if (task.runCount < (task.maxRuns || 100)) {
          // 检查截止时间
          if (task.payload?.deadline && Date.now() > task.payload.deadline) {
            task.status = 'completed'
            this.emit('completed', task)
          } else {
            task.status = 'pending'
            task.nextRunAt = Date.now() + (task.intervalMs || 30 * 60 * 1000)
            this.scheduleTimer(task)
            this.emit('rescheduled', task)
          }
        } else {
          task.status = 'completed'
          this.emit('completed', task)
        }
      } else {
        task.status = 'completed'
        this.emit('completed', task)
      }
    } catch (error) {
      task.status = 'failed'
      task.error = error instanceof Error ? error.message : '未知错误'
      task.lastRunAt = Date.now()
      this.emit('failed', task)
    }

    this.saveTasks()
  }

  private emit(event: string, task: BackgroundTask): void {
    for (const listener of this.listeners) {
      try { listener(event, task) } catch { /* 监听器错误不影响主流程 */ }
    }
  }

  /**
   * 恢复挂起的任务（应用启动时调用）
   */
  private resumePendingTasks(): void {
    let resumed = 0
    for (const task of this.tasks.values()) {
      if (task.status === 'pending' && task.nextRunAt <= Date.now()) {
        // 已过期，立即执行
        this.executeTask(task.id)
        resumed++
      } else if (task.status === 'pending') {
        this.scheduleTimer(task)
        resumed++
      } else if (task.status === 'running') {
        // 上次运行中但应用重启了，标记为 pending 重新调度
        task.status = 'pending'
        this.scheduleTimer(task)
        resumed++
      }
    }
    if (resumed > 0) {
      console.log(`[Scheduler] 恢复了 ${resumed} 个后台任务`)
    }
  }

  /**
   * 注册默认处理器
   */
  private registerDefaultHandlers(): void {
    // 延时任务：直接执行 payload 中的回调描述
    this.handlers.set('delayed', async (task) => {
      return `[延时任务已触发] ${task.title}\n${task.description}`
    })

    // 周期任务
    this.handlers.set('interval', async (task) => {
      return `[周期任务第 ${task.runCount + 1} 次执行] ${task.title}\n${task.description}`
    })

    // 再上奏：检查指标变化，生成跟踪报告
    this.handlers.set('follow-up', async (task) => {
      const metrics = task.payload?.metrics || []
      const condition = task.payload?.triggerCondition || '未知'
      return `[再上奏 - 第 ${task.runCount + 1} 次检查]\n跟踪指标: ${metrics.join(', ')}\n触发条件: ${condition}\n状态: 已检查，等待下次触发或自动完成。`
    })

    // 长辩论：执行下一个阶段
    this.handlers.set('long-debate', async (task) => {
      const stages: string[] = task.payload?.stages || []
      const currentStage = task.payload?.currentStage || 0
      if (currentStage >= stages.length) {
        return '[长辩论] 所有阶段已完成'
      }
      // 递增阶段计数
      if (task.payload) task.payload.currentStage = currentStage + 1
      return `[长辩论 - 阶段 ${currentStage + 1}/${stages.length}]\n${stages[currentStage]}`
    })
  }

  // ============ 持久化 ============

  private loadTasks(): void {
    try {
      const saved = localStorage.getItem('background_tasks')
      if (saved) {
        const arr: BackgroundTask[] = JSON.parse(saved)
        for (const task of arr) {
          this.tasks.set(task.id, task)
        }
      }
    } catch { /* 解析失败使用空集合 */ }
  }

  private saveTasks(): void {
    const arr = Array.from(this.tasks.values())
    localStorage.setItem('background_tasks', JSON.stringify(arr))
  }
}

/** 全局后台任务调度器单例 */
export const backgroundScheduler = new BackgroundScheduler()
