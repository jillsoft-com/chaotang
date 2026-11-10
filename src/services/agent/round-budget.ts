/**
 * 执行轮次与预算的统一换算
 *
 * 背景：轮次额度原先散落在多处写死（Worker 工具循环 3 轮、自主引擎与任务节点迭代 10 轮、
 * 单节点工具调用 50 次、整树 200 次），一个正常的小任务随手就撞上额度，
 * 触发“预算耗尽/监护报警”把已经完成的工作打断作废。现统一为：
 * - 轮次基准取自设置项 max_tool_rounds（默认 500，可在设置界面调整）
 * - 工具调用额度按轮次换算，仅作为兜底上限；触顶后只告警不中断（见 execution-guardian / task-scheduler）
 */
import { appStorage } from '@/services/storage'

/** 设置项键名，与设置界面「最大工具调用轮次」共用同一个旋钮 */
export const MAX_TOOL_ROUNDS_KEY = 'max_tool_rounds'

/** 默认轮次上限，同时是设置界面允许的最大值 */
export const DEFAULT_MAX_TOOL_ROUNDS = 500

/** 单轮 LLM 回复最多可能并行发出的工具调用数，用于换算工具调用额度 */
const TOOL_CALLS_PER_ROUND = 5

/** 一轮任务树大致包含的节点数（与 limits.maxNodes 对齐），用于换算整树工具调用额度 */
const NODES_PER_RUN = 20

/** 单节点工具调用额度（纯换算，不读配置） */
export function calcNodeToolCalls(rounds: number): number {
  return rounds * TOOL_CALLS_PER_ROUND
}

/** 整棵任务树工具调用额度（纯换算，不读配置） */
export function calcRunToolCalls(rounds: number): number {
  return calcNodeToolCalls(rounds) * NODES_PER_RUN
}

/** 单节点时间预算：仅用于超时告警，不打断执行 */
export const NODE_TIMEOUT_MS = 30 * 60 * 1000

/**
 * 读取工具调用轮次上限
 * 存储尚未初始化或值非法时回落到默认值，保证执行链路不因配置读取失败而中断
 */
export function getMaxToolRounds(): number {
  let saved: string | null = null
  try {
    saved = appStorage.getItem(MAX_TOOL_ROUNDS_KEY)
  } catch {
    return DEFAULT_MAX_TOOL_ROUNDS
  }
  const val = saved ? parseInt(saved, 10) : NaN
  if (!Number.isFinite(val) || val <= 0) return DEFAULT_MAX_TOOL_ROUNDS
  return Math.min(val, DEFAULT_MAX_TOOL_ROUNDS)
}

/** 单节点工具调用上限（跟随轮次设置） */
export function getNodeMaxToolCalls(): number {
  return calcNodeToolCalls(getMaxToolRounds())
}

/** 整树工具调用上限（跟随轮次设置） */
export function getRunMaxToolCalls(): number {
  return calcRunToolCalls(getMaxToolRounds())
}
