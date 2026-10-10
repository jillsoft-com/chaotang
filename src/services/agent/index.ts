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
  AutonomousResult
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
