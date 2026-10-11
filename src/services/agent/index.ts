export { CoordinatorAgent, coordinatorAgent } from './coordinator'
export type {
  WorkerTask,
  TaskDecomposition,
  WorkerResult,
  AgentEventType,
  AgentEvent,
  CoordinatorConfig
} from './coordinator'

export { AutonomousEngine, autonomousEngine, enhanceWithAutonomousPrompt } from './autonomous-engine'
export { AUTONOMOUS_PROMPT_SUFFIX, AUTONOMOUS_DEV_PROMPT_SUFFIX } from './autonomous-engine'
export type {
  AutonomousConfig,
  AutonomousEvent,
  AutonomousEventType,
  AutonomousResult,
  CheckpointState
} from './autonomous-engine'

export { PostDebateExecutor, postDebateExecutor } from './post-debate'
export type {
  ImperialDecree,
  ActionItem,
  PostDebateResult,
  PostDebateAction
} from './post-debate'

export {
  parseActionItemsFromReport,
  parseActionItemsFromDecree,
  executeActionItems,
  formatExecutionReport
} from './imperial-executor'
export type { ExecutionReport } from './imperial-executor'

export { buildProjectIndex, searchProjectIndex, generateContextHint, getProjectIndex } from './repository-context'

// ── 任务树 ──
export {
  createTree,
  createNode,
  addNode,
  removeNode,
  validateStructure,
  getReadyNodes,
  transitionStatus,
  aggregateParent,
  deriveParentStatus,
  computeDepth,
  getLeafNodes,
  topologicalSort,
  serializeSnapshot,
  deserializeSnapshot,
  aggregateTreeUsage,
  deriveTreeState,
  addDependency,
  removeDependency,
  reorderChildren,
  changePriority,
  moveNode
} from './task-tree'
export type {
  TaskStatus,
  Verification,
  TaskDependency,
  WakeCondition,
  TaskBudget,
  TaskUsage,
  TaskNode,
  TreeState,
  TreeLimits,
  TaskTreeSnapshot,
  TreeResult,
  ValidationResult,
  ParentSummary
} from './task-tree'

// ── 任务调度器 ──
export { TaskScheduler, taskScheduler } from './task-scheduler'
export type {
  SchedulerConfig,
  LeafExecContext,
  LeafResult,
  ExecutionContext,
  SchedulerEventType,
  SchedulerEvent,
  TreeEdit
} from './task-scheduler'

// ── 事件日志 ──
export { eventLogger } from './event-logger'
export type { EventLogEntry } from './event-logger'

// ── 执行监护器 ──
export { ExecutionGuardian, executionGuardian } from './execution-guardian'
export {
  computeFingerprint,
  detectLoop,
  detectStall,
  isReadOnlyTool,
  isReadOnlyNode,
  canAutoRetry
} from './execution-guardian'
export type {
  GuardianConfig,
  ToolFingerprint,
  GuardianRecord,
  NodeCost,
  GuardianNotification
} from './execution-guardian'
