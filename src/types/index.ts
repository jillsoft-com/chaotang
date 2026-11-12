export type { LLMProviderType } from './llm'
export type { ToolDefinition, ToolCall, ToolCallResult, ToolHandler, ToolCallStatus, JSONSchema } from './tool'
export type { Skill, SkillConfig, SkillCategory, MinisterSkillBinding } from './skill'
export { SKILL_CATEGORY_LABELS } from './skill'
import type { LLMProviderType } from './llm'
import type { ToolCall, ToolCallResult, ToolCallStatus } from './tool'
import type { Skill } from './skill'

export interface Minister {
  id: string
  name: string
  title: string
  avatar: string
  systemPrompt: string
  llm: LLMConfig
  order: number
  description: string
  skills?: Skill[]           // 角色绑定的技能列表
}

/**
 * 思考模式（推理模型）：定义在 types 层，以免 types 反向依赖 services。
 * auto=按模型名/网关域名特征识别；on=强制下发思考开关；off=强制关闭。
 */
export type ThinkingMode = 'auto' | 'on' | 'off'

export interface LLMConfig {
  provider: LLMProviderType
  model: string
  apiKey?: string
  baseURL?: string
  temperature?: number
  maxTokens?: number
  llmId?: string
  /** 模型支持图片识别（多模态视觉）：浏览器截图等图像结果才会下发给模型 */
  supportsVision?: boolean
  /**
   * 思考模式（推理模型）：决定请求体里是否携带思考开关。
   * auto=按模型名/网关域名特征识别；on=强制下发；off=强制关闭。
   * 不下发时服务端常走非思考模式，reasoning_content 一条不发，执行过程就只剩工具行。
   */
  thinkingMode?: ThinkingMode
}

/**
 * Agent 执行时间线片段 —— “思考→执行工具→思考→…”交错展示的数据单元。
 * 仅在 Agent 模式下 worker 执行任务时构建（speech.execTimeline），
 * 会话区按顺序渲染为可折叠块：think 段展开看思考全文，tool 段展开看命令行与返回内容。
 */
export type ExecSegment =
  | {
      type: 'think'
      id: string
      /** 本轮思考正文（流式追加） */
      text: string
      /** 本轮 LLM 输出是否已结束 */
      done: boolean
    }
  | {
      type: 'tool'
      id: string
      /** 对应的工具调用 id */
      toolCallId: string
      functionName: string
      displayName: string
      status: 'executing' | 'completed' | 'error' | 'timeout'
      /** 工具入参（命令原文/参数摘要，JSON 字符串） */
      input?: string
      /** 工具返回内容（截断后） */
      output?: string
      /** 文件变更 diff 数据（write_file / search_replace 时捕获） */
      diffData?: {
        filePath: string
        oldContent: string
        newContent: string
        isNew: boolean
      }
    }

export interface Speech {
  id: string
  ministerId: string
  content: string
  timestamp: number
  status: 'pending' | 'streaming' | 'completed' | 'error'
  toolCalls?: ToolCallResult[]   // 本次发言中的工具调用记录
  toolStatuses?: ToolCallStatus[] // 工具调用状态（UI 展示用）
  /** Agent 执行时间线（思考/工具交错有序，仅 worker 执行发言使用） */
  execTimeline?: ExecSegment[]
  /** Token 使用统计（估算或 API 返回） */
  tokenUsage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  /** 使用的 LLM 模型标识 */
  model?: string
  /** 响应耗时（毫秒） */
  durationMs?: number
}

/** 朝议执行模式 */
export type DebateMode = 'serial' | 'parallel' | 'agent'

/** 附件（用户上传的文件，注入朝议上下文） */
export interface Attachment {
  id: string
  /** 文件名（含扩展名） */
  fileName: string
  /** 文件完整路径 */
  filePath: string
  /** 文件大小（字节） */
  fileSize: number
  /** 文件类型（扩展名，如 pdf / docx / txt） */
  fileType: string
  /** 提取的文本内容（截断后） */
  content?: string
  /** 添加时间 */
  addedAt: number
}

export interface Debate {
  id: string
  topic: string
  mode: 'court' | 'compare' | 'private'
  compareMode?: 'serial' | 'parallel' | 'blind'
  debateMode?: DebateMode   // 朝议执行模式（串行/并行/Agent）
  speeches: Speech[]
  status: 'idle' | 'running' | 'paused' | 'completed'
  createdAt: number
  completedAt?: number
  imperialDecree?: string
  /** 结构化决策报告（拍板后自动生成） */
  decisionReport?: DecisionReport
  /** 用户自定义标签，用于分类和检索（Sprint A - #10） */
  tags?: string[]
  mentionedMinisters?: string[]
  workingDirectory?: string   // 会话工作目录，输出产物保存到此目录
  /** 附件列表（合同、文档等，注入朝议上下文） */
  attachments?: Attachment[]
  /** 任务树快照（Agent 模式下使用，类型为 TaskTreeSnapshot） */
  taskTreeSnapshot?: any
  /** Agent 模式：PM 已拆解但用户尚未批准执行的计划（TaskDecomposition）。用于离开/重进会话后恢复“执行计划审阅”面板 */
  pendingPlan?: any
  /**
   * 交付报告（执行结束后生成，随会话持久化，确认交付或切换标签页后仍可回看）
   * 类型为 services/agent/delivery-report 的 DeliveryReport；此处用 any 避免 types 反向依赖服务层
   */
  deliveryReport?: any
  /** 用户点击“确认交付”的时间戳（确认后报告保留，仅收起面板） */
  deliveryConfirmedAt?: number
}

/**
 * 多模态内容分片（OpenAI 兼容格式）。
 * 仅在发送给模型前由 OpenAIProvider 从 ChatMessage 组装出来，
 * 应用内部消息仍用 content: string，避免各处字符串操作全面改造。
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: ToolCall[]       // assistant 返回的工具调用
  tool_call_id?: string         // tool role 对应的调用 ID
  name?: string                 // tool role 的函数名
  /**
   * 图片负载（data URL 数组）。
   * base64 不进入 content，因此不参与字符统计 / 截断 / 摘要，
   * 发送前由 provider 转成多模态 content（仅视觉模型下发）。
   */
  images?: string[]
}

// ============ 决策质量可视化（Sprint A - #1） ============

/** 四象限中的单个条目 */
export interface DecisionEntry {
  id: string
  title: string
  detail: string
  /** 来源角色 ID 列表（minister.id 或 'emperor'），用于追溯谁提出了这条 */
  sources?: string[]
  /** 重要程度 1-5 */
  importance?: number
}

/** 拍板后的结构化决策报告（共识/分歧/风险/假设 四象限） */
export interface DecisionReport {
  /** 共识点：多位角色共同支持的观点、事实或结论 */
  consensus: DecisionEntry[]
  /** 分歧点：角色间存在争议或不同立场的内容 */
  disagreements: DecisionEntry[]
  /** 风险清单：需要注意的潜在问题、障碍或代价 */
  risks: DecisionEntry[]
  /** 待验证假设：尚未确认、需要后续验证的前提、数据或结论 */
  assumptions: DecisionEntry[]
  /** 一句话决策结论 */
  verdict?: string
  /** 下一步行动建议（按优先级排序） */
  nextSteps?: string[]
  /** 生成时间戳 */
  generatedAt: number
  /** 生成使用的 LLM 标识（provider:model） */
  generatedBy?: string
}

// ============ 本轮改动的 diff 查看 ============

/**
 * 从会话改动清单点开右侧 diff 面板时的载荷。
 *
 * 与会话层解耦：ChatSession 只负责把本轮快照交出去，
 * 具体用快照算 diff 还是回退 git 基准，由右侧文件面板决定。
 */
export interface FileDiffRequest {
  /** 绝对路径（工具执行时已按工作目录解析） */
  path: string
  /** 本轮写入前的正文快照（新建文件时缺省） */
  oldContent?: string
  /** 本轮写入后的正文快照 */
  newContent?: string
  status: 'created' | 'modified' | 'deleted'
  linesAdded: number
  linesRemoved: number
  /** 快照生成后文件又被外部改动，展示时要如实标注 */
  drift?: boolean
  /** 正文超过落盘上限已被裁剪，只能回退 git 基准 */
  trimmed?: boolean
  /** 递增序号：同一路径重复点开时也能触发面板刷新 */
  seq: number
}

/**
 * 会话侧交出的载荷：seq 属于面板层的分发细节，由 HomeView 补上。
 */
export type FileDiffRequestInput = Omit<FileDiffRequest, 'seq'>
