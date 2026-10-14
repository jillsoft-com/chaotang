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

export { buildProjectIndex, searchProjectIndex, generateContextHint, getProjectIndex, invalidateIndexOnWrite, semanticSearch, clearSemanticIndexCache, symbolSearch } from './repository-context'
export type { SymbolInfo, ReferenceInfo, SymbolKind } from './symbol-index'
export { SymbolIndex, extractSymbols, extractReferences } from './symbol-index'
export type { ModuleGraph, ModuleDependency } from './module-graph'
export { extractDependencies, buildModuleGraph, getModuleDependencies, getModuleDependents, detectCycles, getTransitiveDependencies } from './module-graph'

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
  moveNode,
  setLongTermGoal,
  updateGoalProgress,
  getGoalSummary
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
  ParentSummary,
  LongTermGoal
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

// ── 验收状态机（P0-B） ──
export { runAcceptance, buildAcceptancePlan, runAcceptanceChecks, evaluateGate, collectChangedFiles, extractRepairDiagnostics, hasNewEvidence, validateFileBaselines } from './acceptance-gate'
export type {
  GateState,
  CheckRecord,
  AcceptancePlan,
  CommandExecutor,
  AcceptanceConfig,
  RepairConfig,
  RepairResult,
  FileBaselineStatus,
  FileBaselineEntry,
  FileValidationResult
} from './acceptance-gate'

// ── 交付报告（P1-B） ──
export { buildDeliveryReport, extractFileChanges, extractUnresolvedQuestions, formatDeliverySummary, countLineDiff } from './delivery-report'
export type { DeliveryReport, FileChange } from './delivery-report'

// ── 测试循环引擎（Phase 2） ──
export { TestLoopEngine } from './test-loop'
export type { TestLoopConfig, TestLoopEvent, TestLoopEventType, TestLoopResult, TestRoundResult } from './test-loop'

// ── Git 工作流（Phase 3） ──
export { autoCommit, createBranch, pushAndCreatePR, getDiffSummary } from './git-workflow'
export type { AutoCommitResult, CreateBranchResult, PushPRResult, DiffSummary } from './git-workflow'

// ── Lint 自动修复（Phase 4） ──
export { LintFixEngine } from './lint-fix-loop'
export type { LintFixConfig, LintFixEvent, LintFixEventType, LintFixResult } from './lint-fix-loop'

// ── 向量索引（Phase 5） ──
export { VectorIndex, createTfIdfIndex, createEmbedIndex } from './vector-index'
export type { VectorDocument, VectorSearchResult, EmbedFunction, VectorIndexConfig } from './vector-index'

// ── 代码审查（三期 Phase F） ──
export {
  createReviewSession,
  getReviewSession,
  addCodeChange,
  acceptChange,
  rejectChange,
  acceptAllChanges,
  rejectAllChanges,
  completeReviewSession,
  getPendingChangeCount,
  getReviewStats
} from './code-review'
export type { CodeChange, CodeReviewSession } from './code-review'

// ── Git Worktree 隔离（三期 Phase G） ──
export {
  createWorktree,
  removeWorktree,
  listWorktrees,
  getWorktreePath,
  hasActiveWorktree,
  cleanupAllWorktrees,
  executeInWorktree
} from './git-worktree'
export type { WorktreeInfo, CreateWorktreeResult, RemoveWorktreeResult } from './git-worktree'

// ── 子 Agent 注册表（三期 Phase A） ──
export { subAgentRegistry } from './subagent-registry'
export type { SubAgentProfile } from './subagent-registry'
