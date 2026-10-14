/**
 * 任务树 — 纯数据模块
 *
 * 管理任务树的创建、校验、状态迁移、序列化和遍历。
 * 不依赖任何 LLM、UI 或副作用代码。
 *
 * 设计依据：朝堂任务树与执行监护设计方案（修订版）第四节。
 */

// ============ 工具函数 ============

function genId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function emptyUsage(): TaskUsage {
  return { iterations: 0, toolCalls: 0, elapsedMs: 0 }
}

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'awaiting_approval'
  | 'waiting'
  | 'paused'
  | 'interrupted'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'blocked'
  | 'skipped'
  | 'cancelled'

export type Verification = 'none' | 'model_claim' | 'tool_evidence' | 'user_confirmed'

export interface TaskDependency {
  taskId: string
  kind: 'required' | 'advisory'
}

export type WakeCondition =
  | { type: 'time'; notBefore: number }
  | { type: 'external_event'; source: string; key: string }
  | { type: 'file_change'; path: string; event: 'created' | 'modified' }

export interface TaskBudget {
  maxIterations: number
  maxToolCalls: number
  timeoutMs: number
  maxInputTokens?: number
}

export interface TaskUsage {
  iterations: number
  toolCalls: number
  inputTokens?: number
  outputTokens?: number
  elapsedMs: number
}

import type { GateState, CheckRecord } from './acceptance-gate'

export interface TaskNode {
  id: string
  parentId: string | null
  childIds: string[]
  title: string
  description: string
  createdBy: string               // 角色 ID 或 'user'
  assigneeId: string | null       // 根节点为空
  requiredForParent: boolean
  mode: 'analysis' | 'action'
  autonomous: boolean
  decomposition: 'unexamined' | 'leaf' | 'expanded'
  dependencies: TaskDependency[]
  priority: 0 | 1 | 2 | 3
  readOnly: boolean
  allowedToolNames: string[]
  requiresApproval: boolean
  acceptance: string[]
  status: TaskStatus
  waitingReason?: string
  wakeCondition?: WakeCondition
  verification: Verification
  resultSummary?: string
  unresolvedQuestions: string[]
  inputRefs: string[]
  evidenceRefs: string[]
  budget: TaskBudget
  usage: TaskUsage
  maxRetries: number
  attempt: number
  revision: number
  createdAt: number
  startedAt?: number
  finishedAt?: number
  /** 验收状态（P0-B） */
  acceptanceState?: GateState
  /** 验收检查详情（P0-B） */
  acceptanceChecks?: CheckRecord[]
  /** 文件基线记录（P1-C）— 写操作前后 SHA-256 */
  fileBaselines?: Record<string, { beforeSha256: string; afterSha256?: string; originalContent?: string }>
  /** 子 Agent ID（三期 Phase A）— 指定执行策略 */
  subAgentId?: string
}

export type TreeState =
  | 'planning'
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  | 'interrupted'
  | 'completed'
  | 'completed_with_gaps'
  | 'failed'
  | 'cancelled'

export interface TreeLimits {
  maxDepth: number
  maxChildren: number
  maxNodes: number
  maxIterationsPerLeaf: number
  maxToolCallsPerRun: number
  maxEstimatedTokensPerRun?: number
}

export interface TaskTreeSnapshot {
  schemaVersion: 1
  runId: string
  debateId: string
  rootId: string
  nodes: Record<string, TaskNode>
  planRevision: number
  usage: TaskUsage
  state: TreeState
  limits: TreeLimits
  updatedAt: number
  /** 长期目标（三期 Phase B） */
  longTermGoal?: LongTermGoal
}

/** 长期目标定义 */
export interface LongTermGoal {
  /** 目标陈述 */
  statement: string
  /** 成功标准（数组） */
  successCriteria: string[]
  /** 进度百分比 0-100 */
  progressPercent: number
  /** 心跳检查次数 */
  checkCount: number
  /** 上次心跳时间戳 */
  lastCheckAt?: number
  /** 目标是否停滞（连续 N 次心跳进度未变） */
  stalled: boolean
  /** 连续停滞次数 */
  stallCount: number
  /** 创建时间 */
  createdAt: number
  /** 达成时间（100% 时设置） */
  achievedAt?: number
}

// ============ 结果类型 ============

export interface TreeResult {
  ok: boolean
  error?: string
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

export interface ParentSummary {
  completed: string[]
  failed: string[]
  blocked: string[]
  skipped: string[]
  partial: string[]
  conflicts: string[]
  gaps: string[]
}

// ============ 长期目标操作 ============

/**
 * 设定长期目标
 */
export function setLongTermGoal(
  tree: TaskTreeSnapshot,
  statement: string,
  successCriteria: string[]
): TreeResult {
  tree.longTermGoal = {
    statement,
    successCriteria,
    progressPercent: 0,
    checkCount: 0,
    lastCheckAt: undefined,
    stalled: false,
    stallCount: 0,
    createdAt: Date.now(),
    achievedAt: undefined
  }
  tree.updatedAt = Date.now()
  return { ok: true }
}

/**
 * 更新目标进度（心跳检查）
 * 自动检测停滞：连续 3 次心跳进度未变 → stalled = true
 */
export function updateGoalProgress(
  tree: TaskTreeSnapshot,
  progressPercent: number
): TreeResult {
  if (!tree.longTermGoal) {
    return { ok: false, error: '未设定长期目标' }
  }

  const goal = tree.longTermGoal
  const clamped = Math.max(0, Math.min(100, progressPercent))

  goal.checkCount++
  goal.lastCheckAt = Date.now()

  // 停滞检测：进度未变 → stallCount++
  if (clamped === goal.progressPercent) {
    goal.stallCount++
  } else {
    goal.stallCount = 0
    goal.stalled = false
  }

  // 连续 3 次未变 → 标记停滞
  if (goal.stallCount >= 3) {
    goal.stalled = true
  }

  goal.progressPercent = clamped

  // 达成目标
  if (clamped >= 100 && !goal.achievedAt) {
    goal.achievedAt = Date.now()
    goal.stalled = false
    goal.stallCount = 0
  }

  tree.updatedAt = Date.now()
  return { ok: true }
}

/**
 * 获取目标进度摘要（供提示词注入）
 */
export function getGoalSummary(tree: TaskTreeSnapshot): string {
  if (!tree.longTermGoal) return ''
  const g = tree.longTermGoal
  const stall = g.stalled ? ' ⚠️ 目标停滞' : ''
  const achieved = g.achievedAt ? ' ✅ 已达成' : ''
  return `长期目标: ${g.statement}\n进度: ${g.progressPercent}%${stall}${achieved}\n成功标准: ${g.successCriteria.join('; ')}`
}

// ============ 默认值 ============

const DEFAULT_BUDGET: TaskBudget = {
  maxIterations: 10,
  maxToolCalls: 50,
  timeoutMs: 5 * 60 * 1000
}

const DEFAULT_LIMITS: TreeLimits = {
  maxDepth: 3,
  maxChildren: 5,
  maxNodes: 20,
  maxIterationsPerLeaf: 10,
  maxToolCallsPerRun: 200
}

// ============ 合法状态迁移表 ============

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending:             ['ready', 'waiting', 'blocked', 'cancelled', 'skipped'],
  ready:               ['running', 'waiting', 'paused', 'cancelled', 'skipped'],
  running:             ['completed', 'partial', 'failed', 'paused', 'interrupted', 'cancelled'],
  awaiting_approval:   ['ready', 'cancelled'],
  waiting:             ['ready', 'paused', 'cancelled'],
  paused:              ['ready', 'cancelled'],
  interrupted:         ['ready', 'pending', 'cancelled'],
  completed:           ['ready'],                    // 恢复：写入丢失时允许重新执行
  partial:             [],
  failed:              ['ready', 'cancelled'],      // 重试：用户批准或只读自动重试
  blocked:             ['ready', 'partial', 'cancelled'],
  skipped:             [],
  cancelled:           []
}

// ============ 创建与修改 ============

/**
 * 创建只有根节点的任务树
 */
export function createTree(
  debateId: string,
  title: string,
  description: string,
  createdBy: string = 'user',
  limits?: Partial<TreeLimits>
): TaskTreeSnapshot {
  const rootId = genId()
  const now = Date.now()
  const root: TaskNode = {
    id: rootId,
    parentId: null,
    childIds: [],
    title,
    description,
    createdBy,
    assigneeId: null,
    requiredForParent: false,
    mode: 'analysis',
    autonomous: false,
    decomposition: 'unexamined',
    dependencies: [],
    priority: 0,
    readOnly: false,
    allowedToolNames: [],
    requiresApproval: false,
    acceptance: [],
    status: 'pending',
    verification: 'none',
    unresolvedQuestions: [],
    inputRefs: [],
    evidenceRefs: [],
    budget: { ...DEFAULT_BUDGET },
    usage: emptyUsage(),
    maxRetries: 0,
    attempt: 0,
    revision: 0,
    createdAt: now
  }

  return {
    schemaVersion: 1,
    runId: genId(),
    debateId,
    rootId,
    nodes: { [rootId]: root },
    planRevision: 0,
    usage: emptyUsage(),
    state: 'planning',
    limits: { ...DEFAULT_LIMITS, ...limits },
    updatedAt: now
  }
}

/**
 * 创建新节点（不含 tree 引用，调用者通过 addNode 加入树）
 */
export function createNode(partial: Partial<TaskNode> & { title: string; description: string; parentId: string; createdBy: string }): TaskNode {
  const now = Date.now()
  return {
    id: genId(),
    childIds: [],
    assigneeId: null,
    requiredForParent: true,
    mode: 'action',
    autonomous: false,
    decomposition: 'unexamined',
    dependencies: [],
    priority: 0,
    readOnly: false,
    allowedToolNames: [],
    requiresApproval: false,
    acceptance: [],
    status: 'pending',
    verification: 'none',
    unresolvedQuestions: [],
    inputRefs: [],
    evidenceRefs: [],
    budget: { ...DEFAULT_BUDGET },
    usage: emptyUsage(),
    maxRetries: 0,
    attempt: 0,
    revision: 0,
    createdAt: now,
    ...partial
  }
}

/**
 * 添加节点到树中
 */
export function addNode(tree: TaskTreeSnapshot, node: TaskNode): TreeResult {
  // 校验父节点存在
  if (node.parentId && !tree.nodes[node.parentId]) {
    return { ok: false, error: `父节点不存在: ${node.parentId}` }
  }

  // 校验节点总数
  if (Object.keys(tree.nodes).length >= tree.limits.maxNodes) {
    return { ok: false, error: `节点数已达上限 (${tree.limits.maxNodes})` }
  }

  // 校验深度
  if (node.parentId) {
    const depth = computeDepth(tree, node.parentId) + 1
    if (depth > tree.limits.maxDepth) {
      return { ok: false, error: `深度超限: ${depth} > ${tree.limits.maxDepth}` }
    }
  }

  // 校验子节点数
  if (node.parentId) {
    const parent = tree.nodes[node.parentId]
    if (parent.childIds.length >= tree.limits.maxChildren) {
      return { ok: false, error: `父节点子任务数已达上限 (${tree.limits.maxChildren})` }
    }
  }

  // 添加节点
  tree.nodes[node.id] = node

  // 更新父节点的 childIds
  if (node.parentId) {
    tree.nodes[node.parentId].childIds.push(node.id)
  }

  tree.updatedAt = Date.now()
  return { ok: true }
}

/**
 * 从树中移除节点（级联删除子节点）
 */
export function removeNode(tree: TaskTreeSnapshot, nodeId: string): TreeResult {
  const node = tree.nodes[nodeId]
  if (!node) return { ok: false, error: `节点不存在: ${nodeId}` }
  if (nodeId === tree.rootId) return { ok: false, error: '不能删除根节点' }

  // 级联删除子节点
  for (const childId of [...node.childIds]) {
    removeNode(tree, childId)
  }

  // 从父节点移除引用
  if (node.parentId) {
    const parent = tree.nodes[node.parentId]
    if (parent) {
      parent.childIds = parent.childIds.filter(id => id !== nodeId)
    }
  }

  // 清除其他节点对它的依赖引用
  for (const other of Object.values(tree.nodes)) {
    other.dependencies = other.dependencies.filter(d => d.taskId !== nodeId)
  }

  delete tree.nodes[nodeId]
  tree.updatedAt = Date.now()
  return { ok: true }
}

// ============ 结构校验 ============

/**
 * 校验整棵树的结构完整性
 */
export function validateStructure(tree: TaskTreeSnapshot): ValidationResult {
  const errors: string[] = []

  // 1. 根节点存在
  if (!tree.nodes[tree.rootId]) {
    errors.push('根节点不存在')
    return { valid: false, errors }
  }

  // 2. 所有 parentId 引用的节点存在
  for (const [id, node] of Object.entries(tree.nodes)) {
    if (node.parentId && !tree.nodes[node.parentId]) {
      errors.push(`节点 ${id} 的父节点 ${node.parentId} 不存在`)
    }
  }

  // 3. childIds 双向一致性
  for (const [id, node] of Object.entries(tree.nodes)) {
    for (const childId of node.childIds) {
      const child = tree.nodes[childId]
      if (!child) {
        errors.push(`节点 ${id} 的 childIds 引用了不存在的 ${childId}`)
      } else if (child.parentId !== id) {
        errors.push(`节点 ${childId} 的 parentId 与 ${id} 的 childIds 不一致`)
      }
    }
  }

  // 4. 依赖引用存在
  for (const [id, node] of Object.entries(tree.nodes)) {
    for (const dep of node.dependencies) {
      if (!tree.nodes[dep.taskId]) {
        errors.push(`节点 ${id} 依赖了不存在的 ${dep.taskId}`)
      }
    }
  }

  // 5. 不允许自依赖
  for (const [id, node] of Object.entries(tree.nodes)) {
    if (node.dependencies.some(d => d.taskId === id)) {
      errors.push(`节点 ${id} 依赖自身`)
    }
  }

  // 6. 不允许依赖祖先或后代
  for (const [id, node] of Object.entries(tree.nodes)) {
    const ancestors = getAncestors(tree, id)
    const descendants = getDescendants(tree, id)
    for (const dep of node.dependencies) {
      if (ancestors.has(dep.taskId)) {
        errors.push(`节点 ${id} 依赖了祖先 ${dep.taskId}`)
      }
      if (descendants.has(dep.taskId)) {
        errors.push(`节点 ${id} 依赖了后代 ${dep.taskId}`)
      }
    }
  }

  // 7. 不允许依赖环
  if (hasDependencyCycle(tree)) {
    errors.push('存在依赖环')
  }

  return { valid: errors.length === 0, errors }
}

// ============ 状态迁移 ============

/**
 * 状态迁移（带乐观锁校验）
 * @param strict 严格模式：非法迁移抛异常而非返回错误（测试用）
 */
export function transitionStatus(
  tree: TaskTreeSnapshot,
  nodeId: string,
  newStatus: TaskStatus,
  reason?: string,
  strict?: boolean
): TreeResult {
  const node = tree.nodes[nodeId]
  if (!node) {
    const msg = `节点不存在: ${nodeId}`
    if (strict) throw new Error(msg)
    return { ok: false, error: msg }
  }

  const allowed = VALID_TRANSITIONS[node.status]
  if (!allowed || !allowed.includes(newStatus)) {
    const msg = `非法状态迁移: ${node.status} → ${newStatus}${reason ? ` (${reason})` : ''}`
    if (strict) throw new Error(msg)
    return { ok: false, error: msg }
  }

  node.status = newStatus
  node.revision++

  // 自动设置时间戳
  if (newStatus === 'running' && !node.startedAt) {
    node.startedAt = Date.now()
  }
  if (['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(newStatus)) {
    node.finishedAt = Date.now()
  }

  // 设置等待原因
  if (reason && ['waiting', 'blocked', 'paused'].includes(newStatus)) {
    node.waitingReason = reason
  } else if (!['waiting', 'blocked', 'paused'].includes(newStatus)) {
    node.waitingReason = undefined
  }

  tree.updatedAt = Date.now()
  return { ok: true }
}

// ============ 查询与遍历 ============

/**
 * 从父链推导节点深度（根为 0）
 */
export function computeDepth(tree: TaskTreeSnapshot, nodeId: string): number {
  let depth = 0
  let current = tree.nodes[nodeId]
  const visited = new Set<string>()
  while (current && current.parentId) {
    if (visited.has(current.id)) break // 防护环
    visited.add(current.id)
    depth++
    current = tree.nodes[current.parentId]
  }
  return depth
}

/**
 * 获取所有祖先节点 ID
 */
function getAncestors(tree: TaskTreeSnapshot, nodeId: string): Set<string> {
  const ancestors = new Set<string>()
  let current = tree.nodes[nodeId]
  while (current && current.parentId) {
    if (ancestors.has(current.parentId)) break
    ancestors.add(current.parentId)
    current = tree.nodes[current.parentId]
  }
  return ancestors
}

/**
 * 获取所有后代节点 ID
 */
function getDescendants(tree: TaskTreeSnapshot, nodeId: string): Set<string> {
  const descendants = new Set<string>()
  const queue = [nodeId]
  while (queue.length > 0) {
    const id = queue.shift()!
    const node = tree.nodes[id]
    if (!node) continue
    for (const childId of node.childIds) {
      if (!descendants.has(childId)) {
        descendants.add(childId)
        queue.push(childId)
      }
    }
  }
  return descendants
}

/**
 * 检测依赖环（DFS）
 */
function hasDependencyCycle(tree: TaskTreeSnapshot): boolean {
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color: Record<string, number> = {}
  for (const id of Object.keys(tree.nodes)) {
    color[id] = WHITE
  }

  function dfs(nodeId: string): boolean {
    color[nodeId] = GRAY
    const node = tree.nodes[nodeId]
    if (node) {
      for (const dep of node.dependencies) {
        if (color[dep.taskId] === GRAY) return true
        if (color[dep.taskId] === WHITE && dfs(dep.taskId)) return true
      }
    }
    color[nodeId] = BLACK
    return false
  }

  for (const id of Object.keys(tree.nodes)) {
    if (color[id] === WHITE && dfs(id)) return true
  }
  return false
}

/**
 * 获取所有叶子节点（无子节点）
 */
export function getLeafNodes(tree: TaskTreeSnapshot): TaskNode[] {
  return Object.values(tree.nodes).filter(n => n.childIds.length === 0 && n.id !== tree.rootId)
}

/**
 * 获取所有就绪的节点（必需依赖已完成、未暂停、未取消）
 */
export function getReadyNodes(tree: TaskTreeSnapshot): TaskNode[] {
  const candidates: TaskNode[] = []

  for (const node of Object.values(tree.nodes)) {
    if (node.status !== 'pending' && node.status !== 'ready') continue

    // 检查所有必需依赖是否完成
    const requiredDeps = node.dependencies.filter(d => d.kind === 'required')
    const allRequiredDone = requiredDeps.every(dep => {
      const depNode = tree.nodes[dep.taskId]
      return depNode && depNode.status === 'completed'
    })

    if (allRequiredDone) {
      candidates.push(node)
    }
  }

  // 按优先级（高到低）、计划顺序（childIds 中的位置）稳定排序
  candidates.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority
    // 同优先级：按创建时间排序
    return a.createdAt - b.createdAt
  })

  return candidates
}

/**
 * 对同一父节点下的子任务按依赖拓扑排序
 */
export function topologicalSort(tree: TaskTreeSnapshot, childIds: string[]): string[] {
  const result: string[] = []
  const visited = new Set<string>()
  const childSet = new Set(childIds)

  function visit(id: string) {
    if (visited.has(id) || !childSet.has(id)) return
    visited.add(id)
    const node = tree.nodes[id]
    if (node) {
      for (const dep of node.dependencies) {
        if (childSet.has(dep.taskId)) {
          visit(dep.taskId)
        }
      }
    }
    result.push(id)
  }

  for (const id of childIds) {
    visit(id)
  }
  return result
}

// ============ 父节点汇总 ============

/**
 * 汇总父节点的子任务状态
 */
export function aggregateParent(tree: TaskTreeSnapshot, parentId: string): ParentSummary {
  const parent = tree.nodes[parentId]
  if (!parent) {
    return { completed: [], failed: [], blocked: [], skipped: [], partial: [], conflicts: [], gaps: [] }
  }

  const summary: ParentSummary = {
    completed: [],
    failed: [],
    blocked: [],
    skipped: [],
    partial: [],
    conflicts: [],
    gaps: []
  }

  for (const childId of parent.childIds) {
    const child = tree.nodes[childId]
    if (!child) continue

    switch (child.status) {
      case 'completed':
        summary.completed.push(child.id)
        break
      case 'failed':
        summary.failed.push(child.id)
        break
      case 'blocked':
        summary.blocked.push(child.id)
        break
      case 'skipped':
      case 'cancelled':
        summary.skipped.push(child.id)
        break
      case 'partial':
        summary.partial.push(child.id)
        break
    }

    // 收集必需子任务的失败
    if (child.requiredForParent && (child.status === 'failed' || child.status === 'blocked')) {
      summary.gaps.push(`${child.title} (${child.status})`)
    }

    // 收集未解决问题
    summary.conflicts.push(...child.unresolvedQuestions)
  }

  return summary
}

/**
 * 根据子节点状态推导父节点状态
 */
export function deriveParentStatus(tree: TaskTreeSnapshot, parentId: string): TaskStatus | null {
  const parent = tree.nodes[parentId]
  if (!parent || parent.childIds.length === 0) return null

  const summary = aggregateParent(tree, parentId)
  const totalRequired = parent.childIds.filter(id => {
    const child = tree.nodes[id]
    return child && child.requiredForParent
  }).length

  // 所有必需子任务完成 -> 完成
  if (summary.completed.length === parent.childIds.length) {
    return 'completed'
  }

  // 有必需子任务失败，且没有其他正在执行的
  const hasRunning = parent.childIds.some(id => {
    const c = tree.nodes[id]
    return c && ['running', 'pending', 'ready', 'waiting'].includes(c.status)
  })

  if (summary.failed.length > 0 && !hasRunning) {
    // 如果所有必需子任务都失败
    if (summary.failed.length >= totalRequired) {
      return 'failed'
    }
    return 'partial'
  }

  // 有正在执行的子任务
  if (hasRunning) return null // 保持当前状态

  return null
}

// ============ 序列化 ============

/**
 * 序列化为 JSON 字符串
 */
export function serializeSnapshot(tree: TaskTreeSnapshot): string {
  return JSON.stringify(tree)
}

/**
 * 从 JSON 字符串反序列化
 */
export function deserializeSnapshot(json: string): TaskTreeSnapshot | null {
  try {
    const parsed = JSON.parse(json)
    if (parsed && parsed.schemaVersion === 1 && parsed.nodes && parsed.rootId) {
      return parsed as TaskTreeSnapshot
    }
    return null
  } catch {
    return null
  }
}

// ============ 全树用量汇总 ============

/**
 * 汇总整棵树的用量
 */
export function aggregateTreeUsage(tree: TaskTreeSnapshot): TaskUsage {
  const total: TaskUsage = { iterations: 0, toolCalls: 0, elapsedMs: 0 }
  for (const node of Object.values(tree.nodes)) {
    total.iterations += node.usage.iterations
    total.toolCalls += node.usage.toolCalls
    total.elapsedMs += node.usage.elapsedMs
  }
  tree.usage = total
  return total
}

// ============ 树状态推导 ============

/**
 * 推导整棵树的运行状态
 */
export function deriveTreeState(tree: TaskTreeSnapshot): TreeState {
  const nodes = Object.values(tree.nodes)

  // 有正在运行的节点
  if (nodes.some(n => n.status === 'running')) return 'running'

  // 有等待批准的
  if (nodes.some(n => n.status === 'awaiting_approval')) return 'awaiting_approval'

  // 有暂停的
  if (nodes.some(n => n.status === 'paused')) return 'paused'

  // 有中断的
  if (nodes.some(n => n.status === 'interrupted')) return 'interrupted'

  // 所有叶子都完成
  const leaves = getLeafNodes(tree)
  if (leaves.length > 0 && leaves.every(n => n.status === 'completed')) {
    return 'completed'
  }

  // 所有叶子均失败/阻塞/取消（无成功节点）→ 全线失败
  const failStatuses = new Set(['failed', 'blocked', 'cancelled'])
  if (leaves.length > 0 && leaves.every(n => failStatuses.has(n.status))) {
    return 'failed'
  }

  // 所有叶子都有最终状态
  const terminalStatuses = new Set(['completed', 'failed', 'skipped', 'cancelled', 'partial', 'blocked'])
  const allTerminal = leaves.length > 0 && leaves.every(n => terminalStatuses.has(n.status))

  if (allTerminal) {
    // 有部分完成 → 有缺口地完成
    if (leaves.some(n => n.status === 'partial')) return 'completed_with_gaps'
    // 其余混合结果（部分成功、部分失败/跳过）→ 有缺口地完成
    return 'completed_with_gaps'
  }

  // 仍有叶子未到达终态（pending / ready / waiting 等）→ 保持当前状态
  return tree.state
}

// ============ 手动编辑操作 ============

/**
 * 添加依赖（自动校验无环）
 */
export function addDependency(tree: TaskTreeSnapshot, nodeId: string, dep: TaskDependency): TreeResult {
  const node = tree.nodes[nodeId]
  if (!node) return { ok: false, error: `节点 ${nodeId} 不存在` }

  const depNode = tree.nodes[dep.taskId]
  if (!depNode) return { ok: false, error: `依赖目标 ${dep.taskId} 不存在` }

  if (nodeId === dep.taskId) return { ok: false, error: '不能依赖自己' }

  // 检查是否已是祖先/后代
  if (isAncestor(tree, nodeId, dep.taskId)) {
    return { ok: false, error: '不能依赖自己的后代' }
  }
  if (isAncestor(tree, dep.taskId, nodeId)) {
    return { ok: false, error: '不能依赖自己的祖先' }
  }

  // 检查是否已存在
  if (node.dependencies.some(d => d.taskId === dep.taskId)) {
    return { ok: false, error: '依赖已存在' }
  }

  // 添加依赖并检查是否有环
  node.dependencies.push(dep)
  if (hasCycle(tree)) {
    node.dependencies.pop() // 回滚
    return { ok: false, error: '添加该依赖会产生循环' }
  }

  node.revision++
  tree.updatedAt = Date.now()
  return { ok: true }
}

/**
 * 移除依赖
 */
export function removeDependency(tree: TaskTreeSnapshot, nodeId: string, depTaskId: string): TreeResult {
  const node = tree.nodes[nodeId]
  if (!node) return { ok: false, error: `节点 ${nodeId} 不存在` }

  const idx = node.dependencies.findIndex(d => d.taskId === depTaskId)
  if (idx === -1) return { ok: false, error: '依赖不存在' }

  node.dependencies.splice(idx, 1)
  node.revision++
  tree.updatedAt = Date.now()
  return { ok: true }
}

/**
 * 重排子节点顺序
 */
export function reorderChildren(tree: TaskTreeSnapshot, parentId: string, newOrder: string[]): TreeResult {
  const parent = tree.nodes[parentId]
  if (!parent) return { ok: false, error: `父节点 ${parentId} 不存在` }

  // 验证 newOrder 包含所有现有子节点
  const existing = new Set(parent.childIds)
  const ordered = new Set(newOrder)
  if (existing.size !== ordered.size) {
    return { ok: false, error: '子节点数量不匹配' }
  }
  for (const id of newOrder) {
    if (!existing.has(id)) return { ok: false, error: `未知子节点 ${id}` }
  }

  parent.childIds = [...newOrder]
  parent.revision++
  tree.updatedAt = Date.now()
  return { ok: true }
}

/**
 * 修改节点优先级
 */
export function changePriority(tree: TaskTreeSnapshot, nodeId: string, priority: 0 | 1 | 2 | 3): TreeResult {
  const node = tree.nodes[nodeId]
  if (!node) return { ok: false, error: `节点 ${nodeId} 不存在` }

  node.priority = priority
  node.revision++
  tree.updatedAt = Date.now()
  return { ok: true }
}

/**
 * 移动节点到新父节点
 */
export function moveNode(tree: TaskTreeSnapshot, nodeId: string, newParentId: string): TreeResult {
  const node = tree.nodes[nodeId]
  if (!node) return { ok: false, error: `节点 ${nodeId} 不存在` }
  const newParent = tree.nodes[newParentId]
  if (!newParent) return { ok: false, error: `新父节点 ${newParentId} 不存在` }

  if (nodeId === tree.rootId) return { ok: false, error: '不能移动根节点' }
  if (nodeId === newParentId) return { ok: false, error: '不能成为自己的子节点' }

  // 不能移动到后代节点下
  if (isAncestor(tree, nodeId, newParentId)) {
    return { ok: false, error: '不能移动到自己的后代节点下' }
  }

  // 记住旧父节点，便于回滚
  const oldParentId = node.parentId

  // 从旧父节点移除
  if (oldParentId) {
    const oldParent = tree.nodes[oldParentId]
    if (oldParent) {
      oldParent.childIds = oldParent.childIds.filter(id => id !== nodeId)
      oldParent.revision++
    }
  }

  // 加入新父节点
  node.parentId = newParentId
  newParent.childIds.push(nodeId)
  newParent.revision++
  node.revision++

  // 检查深度是否超限
  const newDepth = computeDepth(tree, nodeId)
  if (newDepth > tree.limits.maxDepth) {
    // 完整回滚：恢复旧父节点 childIds + node.parentId
    newParent.childIds = newParent.childIds.filter(id => id !== nodeId)
    newParent.revision++
    node.parentId = oldParentId
    if (oldParentId) {
      const oldParent = tree.nodes[oldParentId]
      if (oldParent) {
        oldParent.childIds.push(nodeId)
        oldParent.revision++
      }
    }
    node.revision++
    return { ok: false, error: `移动后深度 ${newDepth} 超过最大限制 ${tree.limits.maxDepth}` }
  }

  tree.updatedAt = Date.now()
  return { ok: true }
}

// ============ 编辑辅助函数 ============

/**
 * 检查 ancestorId 是否为 descendantId 的祖先
 */
function isAncestor(tree: TaskTreeSnapshot, ancestorId: string, descendantId: string): boolean {
  let current = tree.nodes[descendantId]
  while (current && current.parentId) {
    if (current.parentId === ancestorId) return true
    current = tree.nodes[current.parentId]
  }
  return false
}

/**
 * 检查整棵树是否有循环依赖
 */
function hasCycle(tree: TaskTreeSnapshot): boolean {
  const visited = new Set<string>()
  const inStack = new Set<string>()

  function dfs(nodeId: string): boolean {
    if (inStack.has(nodeId)) return true
    if (visited.has(nodeId)) return false

    visited.add(nodeId)
    inStack.add(nodeId)

    const node = tree.nodes[nodeId]
    if (node) {
      for (const dep of node.dependencies) {
        if (dfs(dep.taskId)) return true
      }
    }

    inStack.delete(nodeId)
    return false
  }

  for (const nodeId of Object.keys(tree.nodes)) {
    if (dfs(nodeId)) return true
  }
  return false
}
