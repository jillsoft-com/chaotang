<script setup lang="ts">
import { ref, nextTick, computed, onMounted, onUnmounted, watch } from 'vue'
import { useDebateStore } from '@/stores/debate'
import { createProvider } from '@/services/llm'
import { llmService } from '@/services/llm-config'
import { Promotion, User, FolderOpened } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { renderSafeMarkdown } from '@/utils/sanitize-markdown'
import type { Speech, LLMConfig, ToolCall } from '@/types'
import { CoordinatorAgent } from '@/services/agent'
import { compressContext, getCompressThreshold, countMessageChars } from '@/services/agent/context-compressor'
import { memoryStore } from '@/services/memory'
import { skillRegistry } from '@/services/skills'
import { toolExecutor } from '@/services/tools/executor'

// ============ 危险命令审批 (Approval Mode) ============

/** 危险命令模式检测 */
const DANGEROUS_CMD_PATTERNS = [
  /\brm\b/i, /\brmdir\b/i, /\bdel\b/i,
  /\bdrop\b/i, /\btruncate\b/i, /\bdelete\b/i,
  /\bformat\b/i, /\bfdisk\b/i, /\bdiskpart\b/i,
  /\bgit\s+reset\s+--hard/i, /\bgit\s+clean\b/i, /\bgit\s+push\s+--force/i,
  /\bnpm\s+uninstall\b/i, /\bpip\s+uninstall\b/i,
  /\bshutdown\b/i, /\breboot\b/i, /\bhalt\b/i,
  /\bmkfs\b/i, /\bdd\s+if=/i,
  /\breg\s+delete\b/i, /\brd\s+\/s/i,
  /\bRemove-Item\b/i, /\bClear-RecycleBin\b/i
]

/** 检查命令是否危险 */
function isDangerousCommand(toolCall: ToolCall): boolean {
  if (toolCall.function.name !== 'execute_command') return false
  try {
    const args = JSON.parse(toolCall.function.arguments)
    const cmd = args.command || ''
    return DANGEROUS_CMD_PATTERNS.some(p => p.test(cmd))
  } catch {
    return false
  }
}

/** 弹出确认框，返回 true 表示用户批准 */
async function confirmDangerousCommand(toolCall: ToolCall): Promise<boolean> {
  let cmd = ''
  try {
    const args = JSON.parse(toolCall.function.arguments)
    cmd = args.command || ''
  } catch { /* ignore */ }

  try {
    await ElMessageBox.confirm(
      `即将执行以下命令，请确认是否批准：\n\n${cmd}`,
      '⚠️ 危险命令确认',
      {
        confirmButtonText: '批准执行',
        cancelButtonText: '拒绝',
        type: 'warning',
        distinguishCancelAndClose: true
      }
    )
    return true
  } catch {
    return false
  }
}

const props = defineProps<{ sessionId: string }>()

const debateStore = useDebateStore()
const speechesContainer = ref<HTMLElement | null>(null)
const isDebating = ref(false)
const userInput = ref('')
const courtInput = ref('')
const isSending = ref(false)
const hasStartedCourt = ref(false)

// 工具调用折叠状态（默认显示 2 行）
const TOOL_CALL_VISIBLE_COUNT = 2
const expandedToolCalls = ref<Set<string>>(new Set())

function isToolCallsExpanded(speechId: string, totalCount: number): boolean {
  return totalCount <= TOOL_CALL_VISIBLE_COUNT || expandedToolCalls.value.has(speechId)
}

function toggleToolCallsExpand(speechId: string) {
  const s = new Set(expandedToolCalls.value)
  if (s.has(speechId)) {
    s.delete(speechId)
  } else {
    s.add(speechId)
  }
  expandedToolCalls.value = s
}

// ============ Diff 预览 ============

/** diff 展开状态（按 toolCallId 跟踪） */
const expandedDiffs = ref<Set<string>>(new Set())

function toggleDiffExpand(toolCallId: string) {
  const s = new Set(expandedDiffs.value)
  if (s.has(toolCallId)) {
    s.delete(toolCallId)
  } else {
    s.add(toolCallId)
  }
  expandedDiffs.value = s
}

/** 计算简单的行级 diff */
function computeSimpleDiff(oldContent: string, newContent: string) {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  const diffLines: Array<{ type: 'unchanged' | 'added' | 'removed'; line: string; lineNum?: number }> = []

  // 简单的 LCS 行级 diff
  const oldSet = new Set(oldLines)
  const newSet = new Set(newLines)

  // 标记删除的行
  for (let i = 0; i < oldLines.length; i++) {
    if (!newSet.has(oldLines[i]) || oldLines[i].trim() === '') {
      diffLines.push({ type: 'removed', line: oldLines[i], lineNum: i + 1 })
    }
  }
  // 标记新增的行
  for (let i = 0; i < newLines.length; i++) {
    if (!oldSet.has(newLines[i]) || newLines[i].trim() === '') {
      diffLines.push({ type: 'added', line: newLines[i], lineNum: i + 1 })
    }
  }

  // 如果变更行数太多，只显示变更行
  if (diffLines.length > 100) {
    return diffLines.slice(0, 100)
  }
  return diffLines
}

/** 获取 diff 统计信息 */
function getDiffStats(oldContent: string, newContent: string) {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  const oldSet = new Set(oldLines)
  const newSet = new Set(newLines)
  const added = newLines.filter(l => !oldSet.has(l)).length
  const removed = oldLines.filter(l => !newSet.has(l)).length
  return { added, removed }
}

// ============ Session 分叉 ============

/** 从某条发言开始分叉新会话 */
function forkFromSpeech(speechId: string) {
  const sess = session.value
  if (!sess) return
  const idx = sess.speeches.findIndex(s => s.id === speechId)
  if (idx >= 0) {
    debateStore.forkSession(sess.id, idx)
  }
}

// 朝议模式：从 store 读取（全局共享）
const debateMode = computed(() => debateStore.debateMode)

// 智能自动滚动：用户手动上滚后不再强制拉回底部
let lastScrollTime = 0
let isNearBottom = true
const SCROLL_THRESHOLD = 100

// @ 提及功能（朝议模式）
const showCourtMentionPopup = ref(false)
const courtMentionFilter = ref('')

const courtFilteredMinisters = computed(() => {
  const filter = courtMentionFilter.value.toLowerCase()
  return debateStore.sortedMinisters.filter(m =>
    !filter || m.name.toLowerCase().includes(filter) || m.title.toLowerCase().includes(filter)
  )
})

watch(courtInput, (val) => {
  const match = val.match(/@(\S*)$/)
  if (match) {
    showCourtMentionPopup.value = true
    courtMentionFilter.value = match[1]
  } else {
    showCourtMentionPopup.value = false
    courtMentionFilter.value = ''
  }
})

function selectCourtMention(ministerId: string) {
  const minister = debateStore.ministers.find(m => m.id === ministerId)
  if (!minister) return
  courtInput.value = courtInput.value.replace(/@\S*$/, `@${minister.name} `)
  showCourtMentionPopup.value = false
}

function parseCourtMentions(text: string): string[] {
  const ids: string[] = []
  const matches = text.matchAll(/@(\S+)/g)
  for (const match of matches) {
    const name = match[1]
    const minister = debateStore.ministers.find(m => m.name === name)
    if (minister && !ids.includes(minister.id)) {
      ids.push(minister.id)
    }
  }
  return ids
}

const session = computed(() =>
  debateStore.sessions.find(s => s.id === props.sessionId) || null
)

// 通过 llmId 查找完整的 LLM 配置（包含 apiKey）
function resolveLLMConfig(ministerLLM: LLMConfig): LLMConfig {
  const llmId = (ministerLLM as any).llmId
  if (llmId) {
    const fullConfig = llmService.getById(llmId)
    if (fullConfig) {
      return { provider: fullConfig.provider, model: fullConfig.model, apiKey: fullConfig.apiKey, baseURL: fullConfig.baseURL }
    }
  }
  return ministerLLM
}

/** 获取摘要模型 provider（用于上下文压缩） */
function getSummaryProvider() {
  const summaryId = localStorage.getItem('summary_model_id')
  if (summaryId) {
    const cfg = llmService.getById(summaryId)
    if (cfg) return createProvider({ provider: cfg.provider, model: cfg.model, apiKey: cfg.apiKey, baseURL: cfg.baseURL })
  }
  // 回退到默认模型
  const defaultCfg = llmService.getAll().find(c => c.isDefault) || llmService.getAll()[0]
  if (defaultCfg) return createProvider({ provider: defaultCfg.provider, model: defaultCfg.model, apiKey: defaultCfg.apiKey, baseURL: defaultCfg.baseURL })
  return null
}

const isPrivate = computed(() => session.value?.mode === 'private')

// 角色管理
const activeMinisterIds = computed(() => {
  if (!session.value) return []
  const mentioned = session.value.mentionedMinisters
  return mentioned && mentioned.length > 0 ? mentioned : debateStore.ministers.map(m => m.id)
})

function isMinisterActive(ministerId: string): boolean {
  return activeMinisterIds.value.includes(ministerId)
}

function toggleMinisterInSession(ministerId: string) {
  if (!session.value || session.value.status === 'running') return
  const current = new Set(activeMinisterIds.value)
  if (current.has(ministerId)) {
    current.delete(ministerId)
  } else {
    current.add(ministerId)
  }
  debateStore.updateSessionMinisters(props.sessionId, Array.from(current))
}

// 工作目录（只读展示，仅在首页设置）

// 提取工作目录的文件夹名
const sessionDirName = computed(() => {
  const dir = session.value?.workingDirectory
  if (!dir) return ''
  const normalized = dir.replace(/[\\/]+$/, '')
  const lastSep = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  return lastSep >= 0 ? normalized.slice(lastSep + 1) : normalized
})

const progress = computed(() => {
  if (!session.value) return 0
  if (isPrivate.value) return 100
  const mentioned = session.value.mentionedMinisters
  const total = mentioned && mentioned.length > 0 ? mentioned.length : debateStore.ministers.length
  const completed = session.value.speeches.filter(
    s => s.status === 'completed' && s.ministerId !== 'emperor'
  ).length
  return Math.round((completed / total) * 100)
})

// 当切换到这个 session 时，如果是朝议模式且还没开始，自动运行
watch(() => debateStore.activeSessionId, async (newId) => {
  if (newId !== props.sessionId) return
  if (!session.value || session.value.mode !== 'court' || session.value.status !== 'running') return
  if (hasStartedCourt.value) return

  // 如果已有大臣发言（重新打开的历史会话），跳过自动朝议
  const hasMinisterSpeeches = session.value.speeches.some(s => s.ministerId !== 'emperor' && s.status === 'completed')
  if (hasMinisterSpeeches) {
    hasStartedCourt.value = true
    return
  }

  hasStartedCourt.value = true
  isDebating.value = true
  await runCourtDebate()
  isDebating.value = false
}, { immediate: true })

onMounted(() => {
  // 朝议自动启动由 watch(activeSessionId, immediate) 处理
  // 这里只做初始化滚动和滚动监听
  if (session.value) {
    nextTick(() => scrollToBottom())
  }
  // 监听用户手动滚动
  speechesContainer.value?.addEventListener('scroll', checkScrollPosition, { passive: true })
})

onUnmounted(() => {
  speechesContainer.value?.removeEventListener('scroll', checkScrollPosition)
})

/**
 * 执行单个角色的回合（支持工作目录 + 工具调用）
 * 当 session 设置了 workingDirectory 时，自动注入目录提示并启用文件操作工具
 */
async function runMinisterTurn(params: {
  ministerId: string
  systemPrompt: string
  userMessage: string
  reactiveSpeech: Speech
  onContent: (content: string) => void
}): Promise<void> {
  const { ministerId, systemPrompt, userMessage, reactiveSpeech, onContent } = params
  const workingDir = session.value?.workingDirectory
  const provider = createProvider(resolveLLMConfig(
    debateStore.ministers.find(m => m.id === ministerId)!.llm
  ))

  // 没有工作目录，走普通无工具对话
  if (!workingDir) {
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userMessage }
    ]
    await provider.chatStream(messages, onContent)
    return
  }

  // 有工作目录：注入提示 + 启用工具
  const dirHint = `\n\n项目工作目录: ${workingDir}\n你可以使用 read_file、read_directory 工具读取该目录下的文件，使用 write_file、create_directory 工具创建文件。\n操作文件时请使用相对路径（如 src/components/xxx.vue），系统会自动解析到工作目录下。`

  // 读取 AGENTS.md 项目指令
  let agentsMdHint = ''
  try {
    if (window.electronAPI?.readFile) {
      const candidates = ['AGENTS.md', 'agents.md', 'CLAUDE.md', 'RULES.md']
      for (const name of candidates) {
        const sep = workingDir.includes('\\') ? '\\' : '/'
        const filePath = `${workingDir.replace(/[\\/]+$/, '')}${sep}${name}`
        const result = await window.electronAPI.readFile(filePath)
        if (result.success && result.content) {
          agentsMdHint = `\n\n=== 项目指令 (${name}) ===\n${result.content.slice(0, 5000)}\n=== 项目指令结束 ===`
          break
        }
      }
    }
  } catch { /* 文件不存在时静默跳过 */ }

  // 加载持久记忆
  const topic = session.value?.topic || ''
  const memorySummary = memoryStore.getContextSummary(workingDir, topic)
  const memoryHint = memorySummary
    ? `\n\n=== 历史记忆（跨会话持久记忆） ===\n${memorySummary}\n=== 记忆结束 ===\n重要提示：以上是你之前会话中保存的记忆，请参考这些信息来回答。如果你发现了新的重要信息，可以使用 save_memory 工具保存。`
    : ''

  const toolDefs = skillRegistry.getToolDefinitionsForMinister(ministerId)
  // 确保至少有基础文件工具
  const allToolDefs = toolDefs.length > 0 ? toolDefs : skillRegistry.getToolDefinitionsForMinister('chancellor')

  const messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: any; tool_call_id?: string; name?: string }> = [
    { role: 'system', content: systemPrompt + dirHint + agentsMdHint + memoryHint },
    { role: 'user', content: userMessage }
  ]

  const MAX_ROUNDS = parseInt(localStorage.getItem('max_tool_rounds') || '30', 10)
  let finalContent = ''
  let accumulatedContent = ''

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const pendingToolCalls: ToolCall[] = []
    console.log(`[runMinisterTurn] 第 ${round + 1}/${MAX_ROUNDS} 轮开始, messages: ${messages.length}`)

    let roundText = ''
    const content = await provider.chatStreamWithTools(
      messages,
      (text) => {
        roundText = text
        onContent(accumulatedContent ? accumulatedContent + '\n\n' + text : text)
      },
      (tcs) => { pendingToolCalls.push(...tcs) },
      { tools: allToolDefs }
    )

    console.log(`[runMinisterTurn] 第 ${round + 1} 轮完成, 工具调用: ${pendingToolCalls.length} 个, 内容长度: ${content?.length || 0}`)

    if (pendingToolCalls.length === 0) {
      // 模型不再调用工具，这就是最终回复
      finalContent = accumulatedContent ? accumulatedContent + '\n\n' + content : content
      break
    }

    // 累加本轮文本内容
    if (roundText) {
      accumulatedContent = accumulatedContent ? accumulatedContent + '\n\n' + roundText : roundText
    }

    messages.push({ role: 'assistant', content: content || '', tool_calls: pendingToolCalls })

    for (const tc of pendingToolCalls) {
      // 相对路径解析
      if (tc.function.name === 'write_file' || tc.function.name === 'create_directory' ||
          tc.function.name === 'read_file' || tc.function.name === 'read_directory' ||
          tc.function.name === 'read_document' || tc.function.name === 'search_code') {
        try {
          const args = JSON.parse(tc.function.arguments)
          if (args.path && !/^[a-zA-Z]:[\\/]/.test(args.path) && !args.path.startsWith('/') && !args.path.startsWith('\\\\')) {
            const sep = workingDir.includes('\\') ? '\\' : '/'
            args.path = `${workingDir.replace(/[\\/]+$/, '')}${sep}${args.path.replace(/^[\\/]+/, '')}`
            tc.function.arguments = JSON.stringify(args)
          }
        } catch { /* 解析失败不处理 */ }
      }

      // execute_command: 自动注入工作目录作为 cwd
      if (tc.function.name === 'execute_command' && workingDir) {
        try {
          const args = JSON.parse(tc.function.arguments)
          if (!args.cwd) {
            args.cwd = workingDir
            tc.function.arguments = JSON.stringify(args)
          }
        } catch { /* 解析失败不处理 */ }
      }

      // git_operation: 自动注入工作目录作为 cwd
      if (tc.function.name === 'git_operation' && workingDir) {
        try {
          const args = JSON.parse(tc.function.arguments)
          if (!args.cwd) {
            args.cwd = workingDir
            tc.function.arguments = JSON.stringify(args)
          }
        } catch { /* 解析失败不处理 */ }
      }

      // run_tests: 自动注入工作目录作为 cwd
      if (tc.function.name === 'run_tests' && workingDir) {
        try {
          const args = JSON.parse(tc.function.arguments)
          if (!args.cwd) {
            args.cwd = workingDir
            tc.function.arguments = JSON.stringify(args)
          }
        } catch { /* 解析失败不处理 */ }
      }

      // 初始化 toolStatuses
      if (!reactiveSpeech.toolStatuses) reactiveSpeech.toolStatuses = []
      reactiveSpeech.toolStatuses.push({
        toolCallId: tc.id,
        functionName: tc.function.name,
        status: 'calling',
        displayName: tc.function.name,
        summary: ''
      })

      // Approval Mode: 危险命令需人工确认
      if (isDangerousCommand(tc)) {
        const approved = await confirmDangerousCommand(tc)
        if (!approved) {
          const statusEntry = reactiveSpeech.toolStatuses.find(s => s.toolCallId === tc.id)
          if (statusEntry) {
            statusEntry.status = 'error'
            statusEntry.summary = '用户拒绝执行危险命令'
          }
          messages.push({
            role: 'tool',
            content: JSON.stringify({ success: false, error: '用户拒绝执行该危险命令' }),
            tool_call_id: tc.id,
            name: tc.function.name
          })
          continue
        }
      }

      // Diff 预览：write_file 执行前读取旧内容
      let preWriteOldContent: string | null = null
      let preWriteFilePath = ''
      if (tc.function.name === 'write_file') {
        try {
          const args = JSON.parse(tc.function.arguments)
          preWriteFilePath = args.path || ''
          if (preWriteFilePath && window.electronAPI?.readFile) {
            const readResult = await window.electronAPI.readFile(preWriteFilePath)
            if (readResult.success) {
              preWriteOldContent = readResult.content || ''
            }
          }
        } catch { /* 读取失败不影响执行 */ }
      }

      const result = await toolExecutor.execute(tc)

      // Diff 预览：write_file 执行后捕获 diff 数据
      const statusEntry = reactiveSpeech.toolStatuses.find(s => s.toolCallId === tc.id)
      if (statusEntry) {
        statusEntry.status = result.status === 'success' ? 'completed' : 'error'
        statusEntry.summary = typeof result.result === 'string'
          ? result.result.slice(0, 60)
          : result.error || ''

        // 如果是 write_file 且执行成功，附加 diff 数据
        if (tc.function.name === 'write_file' && result.status === 'success') {
          try {
            const args = JSON.parse(tc.function.arguments)
            statusEntry.diffData = {
              filePath: args.path || '',
              oldContent: preWriteOldContent || '',
              newContent: args.content || '',
              isNew: preWriteOldContent === null
            }
          } catch { /* 解析失败不附加 */ }
        }
      }

      messages.push({
        role: 'tool',
        content: typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2),
        tool_call_id: tc.id,
        name: tc.function.name
      })
    }

    // 上下文压缩：工具执行完后检查是否需要压缩
    if (round < MAX_ROUNDS - 1) {
      const threshold = getCompressThreshold()
      const totalChars = countMessageChars(messages as any)
      if (totalChars > threshold) {
        const summaryProvider = getSummaryProvider()
        if (summaryProvider) {
          console.log(`[runMinisterTurn] 上下文超过阈值 (${totalChars} > ${threshold})，开始压缩...`)
          try {
            const compressed = await compressContext(messages as any, summaryProvider, threshold)
            // 替换 messages 数组内容
            messages.splice(0, messages.length, ...compressed as any)
            console.log(`[runMinisterTurn] 压缩完成, 消息数: ${messages.length}, 字符: ${countMessageChars(messages as any)}`)
          } catch (e) {
            console.warn('[runMinisterTurn] 压缩失败，继续执行:', e)
          }
        }
      }
    }

    // 最后一轮仍有工具调用，追加一条提示让模型总结
    if (round === MAX_ROUNDS - 1) {
      console.log('[runMinisterTurn] 达到最大轮次，要求模型总结...')
      messages.push({
        role: 'user',
        content: '请基于你已经收集到的所有信息，直接给出最终分析和回复，不要再调用工具。'
      })
      const finalReply = await provider.chatStreamWithTools(
        messages,
        (text) => { onContent(accumulatedContent ? accumulatedContent + '\n\n' + text : text) },
        () => { /* 忽略最终轮的工具调用 */ },
        { tools: allToolDefs }
      )
      finalContent = accumulatedContent ? accumulatedContent + '\n\n' + finalReply : finalReply
      console.log('[runMinisterTurn] 最终总结完成, 长度:', finalReply.length)
    }
  }
  console.log('[runMinisterTurn] 全部完成, finalContent 长度:', finalContent.length)
}

async function runCourtDebate() {
  if (!session.value) return

  // Agent 模式委托给 runAgentDebate
  if (debateMode.value === 'agent') {
    await runAgentDebate()
    return
  }

  const allMinisters = debateStore.sortedMinisters
  const mentioned = session.value.mentionedMinisters
  const ministers = mentioned && mentioned.length > 0
    ? allMinisters.filter(m => mentioned.includes(m.id))
    : allMinisters

  if (debateMode.value === 'parallel') {
    // 并行模式：所有大臣同时发言
    const speechPairs = ministers.map(minister => {
      const speech: Speech = {
        id: `${minister.id}-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        ministerId: minister.id,
        content: '',
        timestamp: Date.now(),
        status: 'streaming' as const
      }
      debateStore.addSpeech(speech, props.sessionId)
      const reactiveSpeech = session.value!.speeches.find(s => s.id === speech.id)!
      return { minister, reactiveSpeech }
    })

    isNearBottom = true
    await nextTick()
    scrollToBottom()

    const promises = speechPairs.map(async ({ minister, reactiveSpeech }) => {
      try {
        const userMessage = `议题：${session.value!.topic}\n\n请结合你的职责完成你的工作。`
        await runMinisterTurn({
          ministerId: minister.id,
          systemPrompt: minister.systemPrompt,
          userMessage,
          reactiveSpeech,
          onContent: (content) => {
            reactiveSpeech.content = content
            throttledScroll()
          }
        })
        reactiveSpeech.status = 'completed'
      } catch (error) {
        reactiveSpeech.content = `进言失败：${error instanceof Error ? error.message : '未知错误'}`
        reactiveSpeech.status = 'error'
      }
    })

    await Promise.all(promises)
  } else {
    // 串行模式：大臣依次发言
    isNearBottom = true
    for (const minister of ministers) {
      if (!session.value || session.value.status !== 'running') break

      const speech: Speech = {
        id: `${minister.id}-${Date.now()}`,
        ministerId: minister.id,
        content: '',
        timestamp: Date.now(),
        status: 'streaming'
      }

      debateStore.addSpeech(speech, props.sessionId)
      const reactiveSpeech = session.value!.speeches.find(s => s.id === speech.id)!

      try {
        const previousSpeeches = session.value.speeches
          .filter(s => s.status === 'completed' && s.ministerId !== minister.id)
          .map(s => {
            if (s.ministerId === 'emperor') return `圣上：${s.content}`
            const m = debateStore.ministers.find(min => min.id === s.ministerId)
            return `${m?.name}：${s.content}`
          })
          .join('\n\n')

        const userMessage = previousSpeeches
          ? `议题：${session.value.topic}\n\n前序角色的输出：\n${previousSpeeches}\n\n请仔细阅读以上内容，结合你的职责完成你的工作。`
          : `议题：${session.value.topic}\n\n请结合你的职责完成你的工作。`

        await runMinisterTurn({
          ministerId: minister.id,
          systemPrompt: minister.systemPrompt,
          userMessage,
          reactiveSpeech,
          onContent: (content) => {
            reactiveSpeech.content = content
            throttledScroll()
          }
        })
        reactiveSpeech.status = 'completed'
      } catch (error) {
        reactiveSpeech.content = `进言失败：${error instanceof Error ? error.message : '未知错误'}`
        reactiveSpeech.status = 'error'
      }

      await nextTick()
      isNearBottom = true
      scrollToBottom()
    }
  }

  isNearBottom = true
  scrollToBottom()

  if (session.value) {
    debateStore.completeDebate()
  }
}

/**
 * Agent 模式：丞相拆解 → Workers 执行 → 丞相汇总
 */
async function runAgentDebate() {
  if (!session.value) return

  const allMinisters = debateStore.sortedMinisters
  const mentioned = session.value.mentionedMinisters
  const ministers = mentioned && mentioned.length > 0
    ? allMinisters.filter(m => mentioned.includes(m.id))
    : allMinisters

  // 丞相作为 coordinator，其他大臣作为 workers
  const chancellor = ministers.find(m => m.id === 'chancellor')
  if (!chancellor) {
    // 没有丞相，降级为串行模式：直接执行串行逻辑
    isNearBottom = true
    for (const minister of ministers) {
      if (!session.value || session.value.status !== 'running') break
      const speech: Speech = {
        id: `${minister.id}-${Date.now()}`,
        ministerId: minister.id,
        content: '',
        timestamp: Date.now(),
        status: 'streaming'
      }
      debateStore.addSpeech(speech, props.sessionId)
      const reactiveSpeech = session.value!.speeches.find(s => s.id === speech.id)!
      try {
        const userMessage = `议题：${session.value!.topic}\n\n请结合你的职责完成你的工作。`
        await runMinisterTurn({
          ministerId: minister.id,
          systemPrompt: minister.systemPrompt,
          userMessage,
          reactiveSpeech,
          onContent: (content) => {
            reactiveSpeech.content = content
            throttledScroll()
          }
        })
        reactiveSpeech.status = 'completed'
      } catch (error) {
        reactiveSpeech.content = `进言失败：${error instanceof Error ? error.message : '未知错误'}`
        reactiveSpeech.status = 'error'
      }
      await nextTick()
      isNearBottom = true
      scrollToBottom()
    }
    isNearBottom = true
    scrollToBottom()
    if (session.value) debateStore.completeDebate()
    return
  }

  const workers = ministers.filter(m => m.id !== 'chancellor')

  isNearBottom = true
  await nextTick()
  scrollToBottom()

  const agent = new CoordinatorAgent({ planMode: true })

  // Plan Mode 确认回调
  const onPlanReady = async () => {
    try {
      await ElMessageBox.confirm(
        '丞相已拆解完成，是否批准执行？',
        '📋 执行计划确认',
        {
          confirmButtonText: '批准执行',
          cancelButtonText: '取消',
          type: 'info'
        }
      )
      return true
    } catch {
      return false
    }
  }

  // Approval Mode 回调
  const onBeforeToolExecute = async (tc: ToolCall) => {
    if (!isDangerousCommand(tc)) return true
    return confirmDangerousCommand(tc)
  }

  // 监听 Agent 事件，自动滚动
  agent.onEvent((event) => {
    if (['worker-start', 'worker-done', 'synthesizing', 'complete'].includes(event.type)) {
      nextTick(() => {
        isNearBottom = true
        scrollToBottom()
      })
    }
  })

  try {
    await agent.runAgentDebate({
      topic: session.value.topic,
      chancellor,
      workers,
      resolveLLM: resolveLLMConfig,
      addSpeech: (speech) => debateStore.addSpeech(speech, props.sessionId),
      getReactiveSpeech: (speechId) => session.value!.speeches.find(s => s.id === speechId)!,
      shouldContinue: () => !!session.value && session.value.status === 'running',
      workingDirectory: session.value.workingDirectory,
      onPlanReady,
      onBeforeToolExecute
    })
  } catch (error) {
    console.error('[Agent] 协作流程失败:', error)
  }

  isNearBottom = true
  scrollToBottom()

  if (session.value) {
    debateStore.completeDebate()
  }
}

function checkScrollPosition() {
  if (!speechesContainer.value) return
  const el = speechesContainer.value
  isNearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < SCROLL_THRESHOLD
}

function throttledScroll() {
  if (!isNearBottom) return
  const now = Date.now()
  if (now - lastScrollTime > 50) {
    lastScrollTime = now
    scrollToBottom()
  }
}

function scrollToBottom() {
  if (speechesContainer.value) {
    speechesContainer.value.scrollTop = speechesContainer.value.scrollHeight
  }
}

// 单独召见模式 - 发送圣谕
async function sendMessage() {
  if (!userInput.value.trim() || isSending.value || !session.value) return

  const ministerId = session.value.speeches[0]?.ministerId
  if (ministerId === 'emperor') return
  const minister = debateStore.ministers.find(m => m.id === ministerId)
  if (!minister) return

  // 添加皇帝发言
  const emperorSpeech: Speech = {
    id: `emperor-${Date.now()}`,
    ministerId: 'emperor',
    content: userInput.value,
    timestamp: Date.now(),
    status: 'completed'
  }
  debateStore.addSpeech(emperorSpeech, props.sessionId)
  userInput.value = ''
  await nextTick()
  scrollToBottom()

  // 大臣回复
  isSending.value = true
  const replySpeech: Speech = {
    id: `${ministerId}-${Date.now()}`,
    ministerId: ministerId,
    content: '',
    timestamp: Date.now(),
    status: 'streaming'
  }
  debateStore.addSpeech(replySpeech, props.sessionId)
  isNearBottom = true
  await nextTick()
  scrollToBottom()

  // 获取响应式版本的引用
  const reactiveReply = session.value!.speeches.find(s => s.id === replySpeech.id)!

  try {
    const provider = createProvider(resolveLLMConfig(minister.llm))

    const history = session.value.speeches
      .filter(s => s.status === 'completed' && s.id !== replySpeech.id)
      .map(s => {
        if (s.ministerId === 'emperor') {
          return { role: 'user' as const, content: `皇帝说：${s.content}` }
        }
        return { role: 'assistant' as const, content: s.content }
      })

    const messages = [
      { role: 'system' as const, content: minister.systemPrompt },
      ...history
    ]

    await provider.chatStream(messages, (content) => {
      reactiveReply.content = content
      throttledScroll()
    })
    reactiveReply.status = 'completed'
  } catch (error) {
    reactiveReply.content = `回复失败：${error instanceof Error ? error.message : '未知错误'}`
    reactiveReply.status = 'error'
  } finally {
    isSending.value = false
  }

  isNearBottom = true
  await nextTick()
  scrollToBottom()
}

// 朝议模式 - 继续发言（支持@选人 + 串行/并行模式）
async function sendCourtMessage() {
  if (!courtInput.value.trim() || isSending.value || !session.value) return

  // 解析@提及的大臣
  const mentionedIds = parseCourtMentions(courtInput.value)
  const allMinisters = debateStore.sortedMinisters
  // 优先级：@提及 > 会话已选角色 > 全部角色
  const sessionMinisters = session.value.mentionedMinisters
  const ministers = mentionedIds.length > 0
    ? allMinisters.filter(m => mentionedIds.includes(m.id))
    : (sessionMinisters && sessionMinisters.length > 0
      ? allMinisters.filter(m => sessionMinisters.includes(m.id))
      : allMinisters)

  // 添加皇帝发言
  const emperorSpeech: Speech = {
    id: `emperor-${Date.now()}`,
    ministerId: 'emperor',
    content: courtInput.value,
    timestamp: Date.now(),
    status: 'completed'
  }
  debateStore.addSpeech(emperorSpeech, props.sessionId)
  courtInput.value = ''
  showCourtMentionPopup.value = false
  isNearBottom = true
  await nextTick()
  scrollToBottom()

  // 被@的大臣回复
  isSending.value = true
  // 重新打开已完成的朝议
  if (session.value.status === 'completed') {
    session.value.status = 'running'
  }

  if (debateMode.value === 'agent') {
    // Agent 模式：丞相拆解 + Workers 执行 + 丞相汇总
    const chancellor = ministers.find(m => m.id === 'chancellor')
    const workers = ministers.filter(m => m.id !== 'chancellor')

    if (chancellor && workers.length > 0) {
      const agent = new CoordinatorAgent({ planMode: true })

      // Plan Mode 确认回调
      const onPlanReady = async () => {
        try {
          await ElMessageBox.confirm(
            '丞相已拆解完成，是否批准执行？',
            '📋 执行计划确认',
            {
              confirmButtonText: '批准执行',
              cancelButtonText: '取消',
              type: 'info'
            }
          )
          return true
        } catch {
          return false
        }
      }

      // Approval Mode 回调
      const onBeforeToolExecute = async (tc: ToolCall) => {
        if (!isDangerousCommand(tc)) return true
        return confirmDangerousCommand(tc)
      }

      agent.onEvent((event) => {
        if (['worker-start', 'worker-done', 'synthesizing', 'complete'].includes(event.type)) {
          nextTick(() => { isNearBottom = true; scrollToBottom() })
        }
      })

      try {
        await agent.runAgentDebate({
          topic: emperorSpeech.content || session.value!.topic,
          chancellor,
          workers,
          resolveLLM: resolveLLMConfig,
          addSpeech: (speech) => debateStore.addSpeech(speech, props.sessionId),
          getReactiveSpeech: (speechId) => session.value!.speeches.find(s => s.id === speechId)!,
          shouldContinue: () => !!session.value && session.value.status === 'running',
          workingDirectory: session.value!.workingDirectory,
          onPlanReady,
          onBeforeToolExecute
        })
      } catch (error) {
        console.error('[Agent] 协作流程失败:', error)
      }

      isSending.value = false
      if (session.value) debateStore.completeDebate()
      await nextTick()
      scrollToBottom()
      return
    } else {
      // 没有丞相或无 worker，降级为串行（不修改全局偏好）
    }
  }

  if (debateMode.value === 'parallel') {
    // 并行模式：所有大臣同时回复
    const speechPairs = ministers.map(minister => {
      const speech: Speech = {
        id: `${minister.id}-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        ministerId: minister.id,
        content: '',
        timestamp: Date.now(),
        status: 'streaming' as const
      }
      debateStore.addSpeech(speech, props.sessionId)
      const reactiveSpeech = session.value!.speeches.find(s => s.id === speech.id)!
      return { minister, reactiveSpeech }
    })

    isNearBottom = true
    await nextTick()
    scrollToBottom()

    const promises = speechPairs.map(async ({ minister, reactiveSpeech }) => {
      try {
        const history = session.value!.speeches
          .filter(s => s.status === 'completed' && s.ministerId !== minister.id)
          .map(s => {
            if (s.ministerId === 'emperor') return `圣上：${s.content}`
            const m = debateStore.ministers.find(min => min.id === s.ministerId)
            return `${m?.name}：${s.content}`
          })
          .join('\n\n')

        const userMessage = history
          ? `${history}\n\n请你基于以上发言，发表你的意见。`
          : '请你发表你的意见。'

        await runMinisterTurn({
          ministerId: minister.id,
          systemPrompt: minister.systemPrompt,
          userMessage,
          reactiveSpeech,
          onContent: (content) => {
            reactiveSpeech.content = content
            throttledScroll()
          }
        })
        reactiveSpeech.status = 'completed'
      } catch (error) {
        reactiveSpeech.content = `进言失败：${error instanceof Error ? error.message : '未知错误'}`
        reactiveSpeech.status = 'error'
      }
    })

    await Promise.all(promises)
  } else {
    // 串行模式：大臣依次回复
    isNearBottom = true
    for (const minister of ministers) {
      if (!session.value) break

      const speech: Speech = {
        id: `${minister.id}-${Date.now()}`,
        ministerId: minister.id,
        content: '',
        timestamp: Date.now(),
        status: 'streaming'
      }
      debateStore.addSpeech(speech, props.sessionId)
      const reactiveSpeech = session.value!.speeches.find(s => s.id === speech.id)!
      isNearBottom = true

      try {
        const history = session.value.speeches
          .filter(s => s.status === 'completed' && s.ministerId !== minister.id)
          .map(s => {
            if (s.ministerId === 'emperor') return `圣上：${s.content}`
            const m = debateStore.ministers.find(min => min.id === s.ministerId)
            return `${m?.name}：${s.content}`
          })
          .join('\n\n')

        const userMessage = history
          ? `${history}\n\n请你基于以上发言，发表你的意见。`
          : '请你发表你的意见。'

        await runMinisterTurn({
          ministerId: minister.id,
          systemPrompt: minister.systemPrompt,
          userMessage,
          reactiveSpeech,
          onContent: (content) => {
            reactiveSpeech.content = content
            throttledScroll()
          }
        })
        reactiveSpeech.status = 'completed'
      } catch (error) {
        reactiveSpeech.content = `进言失败：${error instanceof Error ? error.message : '未知错误'}`
        reactiveSpeech.status = 'error'
      }

      await nextTick()
      scrollToBottom()
    }
  }

  isSending.value = false

  // 大臣发言完毕，归入历史朝议
  if (session.value) {
    debateStore.completeDebate()
  }

  isNearBottom = true
  await nextTick()
  scrollToBottom()
}

function getMinisterName(ministerId: string): string {
  if (ministerId === 'emperor') return '圣上'
  return debateStore.ministers.find(m => m.id === ministerId)?.name || ''
}

function getMinisterAvatar(ministerId: string): string {
  return debateStore.ministers.find(m => m.id === ministerId)?.avatar || ''
}

function getMinisterTitle(ministerId: string): string {
  return debateStore.ministers.find(m => m.id === ministerId)?.title || ''
}

function getMinisterModel(ministerId: string): string {
  if (ministerId === 'emperor') return ''
  return debateStore.ministers.find(m => m.id === ministerId)?.llm?.model || ''
}

function renderMarkdown(content: string): string {
  return renderSafeMarkdown(content)
}
</script>

<template>
  <div class="session-container" v-if="session">
    <!-- 消息区域 -->
    <main ref="speechesContainer" class="session-messages">
      <div class="messages-inner">
        <div
          v-for="speech in session.speeches"
          :key="speech.id"
          class="message-item"
          :class="{
            streaming: speech.status === 'streaming',
            error: speech.status === 'error',
            'emperor-message': speech.ministerId === 'emperor'
          }"
        >
          <div class="message-avatar" v-if="speech.ministerId !== 'emperor'">
            <div class="avatar-content">{{ getMinisterAvatar(speech.ministerId) }}</div>
          </div>
          <div class="emperor-avatar" v-else>
            <div class="avatar-content emperor-avatar-style">🐲</div>
          </div>

          <div class="message-content" :class="{ 'emperor-content': speech.ministerId === 'emperor' }">
            <div class="message-header">
              <span class="minister-name">{{ getMinisterName(speech.ministerId) }}</span>
              <el-tag v-if="speech.ministerId !== 'emperor'" size="small" effect="plain">
                {{ getMinisterTitle(speech.ministerId) }}
              </el-tag>
              <span v-if="getMinisterModel(speech.ministerId)" class="minister-model">{{ getMinisterModel(speech.ministerId) }}</span>
              <el-tag v-if="speech.ministerId === 'emperor'" type="warning" size="small" effect="dark">圣谕</el-tag>
              <el-tag v-if="speech.status === 'streaming'" type="warning" size="small" effect="plain" class="status-tag">
                <span class="typing-dots"><span></span><span></span><span></span></span>
                进言中
              </el-tag>
              <el-tag v-else-if="speech.status === 'error'" type="danger" size="small" effect="plain" class="status-tag">
                错误
              </el-tag>
              <!-- 分叉按钮：悬停时显示，从这条发言开始新会话 -->
              <span
                v-if="speech.status === 'completed' && session.speeches.indexOf(speech) > 0"
                class="speech-fork-btn"
                title="从此处分叉新会话"
                @click.stop="forkFromSpeech(speech.id)"
              >⑂</span>
            </div>

            <div class="message-body">
              <!-- 工具调用状态展示 -->
              <div v-if="speech.toolStatuses && speech.toolStatuses.length > 0" class="tool-calls-section">
                <div
                  v-for="tc in isToolCallsExpanded(speech.id, speech.toolStatuses.length) ? speech.toolStatuses : speech.toolStatuses.slice(0, TOOL_CALL_VISIBLE_COUNT)"
                  :key="tc.toolCallId"
                  class="tool-call-item"
                  :class="`tool-call-${tc.status}`"
                >
                  <span class="tool-call-icon">
                    <span v-if="tc.status === 'calling' || tc.status === 'executing'" class="typing-dots"><span></span><span></span><span></span></span>
                    <span v-else-if="tc.status === 'completed'">✅</span>
                    <span v-else>❌</span>
                  </span>
                  <span class="tool-call-name">{{ tc.displayName }}</span>
                  <span v-if="tc.summary" class="tool-call-summary">{{ tc.summary }}</span>
                  <!-- Diff 预览入口 -->
                  <span
                    v-if="tc.diffData"
                    class="tool-diff-toggle"
                    @click.stop="toggleDiffExpand(tc.toolCallId)"
                  >
                    <span v-if="tc.diffData.isNew" class="diff-badge diff-new">+新文件</span>
                    <span v-else class="diff-badge diff-modified">
                      <span class="diff-added">+{{ getDiffStats(tc.diffData.oldContent, tc.diffData.newContent).added }}</span>
                      <span class="diff-removed">-{{ getDiffStats(tc.diffData.oldContent, tc.diffData.newContent).removed }}</span>
                    </span>
                  </span>
                  <!-- Diff 展开内容 -->
                  <div v-if="tc.diffData && expandedDiffs.has(tc.toolCallId)" class="tool-diff-panel" @click.stop>
                    <div class="diff-file-path">{{ tc.diffData.filePath }}</div>
                    <div v-if="tc.diffData.isNew" class="diff-new-file">
                      <pre class="diff-content diff-all-added">{{ tc.diffData.newContent }}</pre>
                    </div>
                    <div v-else class="diff-changes">
                      <div
                        v-for="(line, idx) in computeSimpleDiff(tc.diffData.oldContent, tc.diffData.newContent)"
                        :key="idx"
                        class="diff-line"
                        :class="`diff-line-${line.type}`"
                      >
                        <span class="diff-line-marker">{{ line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ' }}</span>
                        <span class="diff-line-num" v-if="line.lineNum">{{ line.lineNum }}</span>
                        <span class="diff-line-text">{{ line.line }}</span>
                      </div>
                    </div>
                  </div>
                </div>
                <div
                  v-if="speech.toolStatuses.length > TOOL_CALL_VISIBLE_COUNT"
                  class="tool-calls-toggle"
                  @click="toggleToolCallsExpand(speech.id)"
                >
                  {{ isToolCallsExpanded(speech.id, speech.toolStatuses.length) ? `收起（${speech.toolStatuses.length} 项）` : `展开其余 ${speech.toolStatuses.length - TOOL_CALL_VISIBLE_COUNT} 项` }}
                </div>
              </div>

              <div class="message-text markdown-body" v-html="renderMarkdown(speech.content)"></div>
            </div>
          </div>
        </div>

        <!-- 朝议进度条 -->
        <el-skeleton v-if="isDebating && session.speeches.filter(s => s.ministerId !== 'emperor').length === 0" animated class="loading-skeleton">
          <template #template>
            <el-skeleton-item variant="text" style="width: 60%; height: 20px; margin-bottom: 12px" />
            <el-skeleton-item variant="text" style="width: 100%; height: 14px; margin-bottom: 8px" />
            <el-skeleton-item variant="text" style="width: 80%; height: 14px" />
          </template>
        </el-skeleton>
      </div>
    </main>

    <!-- 进度条 -->
    <div v-if="isDebating && !isPrivate" class="session-progress">
      <el-progress :percentage="progress" :show-text="false" :stroke-width="3" color="#d4af37" />
    </div>

    <!-- 底部 -->
    <footer class="session-footer">
      <!-- 召见模式 - 聊天输入 -->
      <div v-if="isPrivate" class="chat-input">
        <div class="chat-input-container">
          <el-input
            v-model="userInput"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 4 }"
            placeholder="陛下有何圣谕..."
            @keydown.enter.exact.prevent="sendMessage"
            resize="none"
            :disabled="isSending"
          />
          <el-button
            type="primary"
            :icon="Promotion"
            circle
            size="small"
            :disabled="!userInput.trim() || isSending"
            :loading="isSending"
            @click="sendMessage"
          />
        </div>
        <div class="input-toolbar">
          <div class="toolbar-left">
            <!-- 预留按钮区域 -->
          </div>
          <div class="toolbar-right">
            <!-- 工作目录（只读展示） -->
            <el-tooltip
              v-if="session?.workingDirectory"
              :content="session.workingDirectory"
              placement="top"
            >
              <el-button size="small" :icon="FolderOpened" type="warning">
                {{ sessionDirName }}
              </el-button>
            </el-tooltip>
            <span class="input-hint-text">Enter 发送 · Shift+Enter 换行</span>
          </div>
        </div>
      </div>

      <!-- 朝议模式 - 继续发言输入 -->
      <div v-else class="chat-input">
        <div class="chat-input-container" style="position: relative;">
          <!-- @ 选人弹出层 -->
          <div v-if="showCourtMentionPopup" class="court-mention-popup">
            <div class="mention-title">选择大臣</div>
            <div
              v-for="minister in courtFilteredMinisters"
              :key="minister.id"
              class="mention-item"
              @mousedown.prevent="selectCourtMention(minister.id)"
            >
              <span class="mention-avatar">{{ minister.avatar }}</span>
              <span class="mention-name">{{ minister.name }}</span>
              <span class="mention-title-text">{{ minister.title }}</span>
            </div>
            <div v-if="courtFilteredMinisters.length === 0" class="mention-empty">无匹配大臣</div>
          </div>
          <el-input
            v-model="courtInput"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 4 }"
            placeholder="圣上有何补充...（输入@可指定大臣）"
            @keydown.enter.exact.prevent="sendCourtMessage"
            resize="none"
            :disabled="isSending"
          />
          <el-button
            type="primary"
            :icon="Promotion"
            circle
            size="small"
            :disabled="!courtInput.trim() || isSending"
            :loading="isSending"
            @click="sendCourtMessage"
          />
        </div>
        <div class="input-toolbar">
          <div class="toolbar-left">
            <el-radio-group v-model="debateStore.debateMode" size="small">
              <el-radio-button value="serial">串行</el-radio-button>
              <el-radio-button value="parallel">并行</el-radio-button>
              <el-radio-button value="agent">Agent</el-radio-button>
            </el-radio-group>
          </div>
          <div class="toolbar-right">
            <!-- 角色管理 -->
            <el-popover trigger="click" placement="top" :width="300" :disabled="session?.status === 'running'">
              <template #reference>
                <el-button size="small" :icon="User" :disabled="session?.status === 'running'">
                  角色 ({{ activeMinisterIds.length }})
                </el-button>
              </template>
              <div class="role-manager-list">
                <div class="role-manager-title">选择参与会话的角色</div>
                <div
                  v-for="minister in debateStore.sortedMinisters"
                  :key="minister.id"
                  class="role-manager-item"
                  @click="toggleMinisterInSession(minister.id)"
                >
                  <el-checkbox :model-value="isMinisterActive(minister.id)" @click.stop @change="toggleMinisterInSession(minister.id)" />
                  <span class="role-manager-avatar">{{ minister.avatar }}</span>
                  <span class="role-manager-name">{{ minister.name }}</span>
                  <span class="role-manager-title-text">{{ minister.title }}</span>
                </div>
              </div>
            </el-popover>

            <!-- 工作目录（只读展示） -->
            <el-tooltip
              v-if="session?.workingDirectory"
              :content="session.workingDirectory"
              placement="top"
            >
              <el-button size="small" :icon="FolderOpened" type="warning">
                {{ sessionDirName }}
              </el-button>
            </el-tooltip>

            <span class="input-hint-text">Enter 发送 · Shift+Enter 换行 · @ 指定大臣</span>
          </div>
        </div>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.session-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.session-messages {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.messages-inner {
  max-width: 900px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.message-item {
  display: flex;
  gap: 16px;
  animation: slideIn 0.3s ease;
}

@keyframes slideIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

.message-avatar { flex-shrink: 0; }

.avatar-content {
  width: 48px;
  height: 48px;
  background: linear-gradient(135deg, var(--ct-bg-tertiary), var(--ct-bg-secondary));
  border: 2px solid var(--ct-accent);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
}

.message-content {
  max-width: 80%;
  background: var(--ct-bg-secondary);
  border: 1px solid var(--ct-border);
  border-radius: 12px;
  padding: 16px;
  transition: all 0.2s;
  min-width: 0;
}

.message-item.streaming .message-content {
  border-color: var(--ct-accent);
  box-shadow: 0 0 20px rgba(212, 175, 55, 0.1);
}

.message-item.error .message-content {
  border-color: #ef4444;
  background: rgba(239, 68, 68, 0.05);
}

.message-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--ct-border);
}

.minister-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--ct-text-primary);
}

.minister-model {
  font-size: 12px;
  color: var(--ct-text-secondary);
  opacity: 0.7;
}

.status-tag { margin-left: auto; }

.speech-fork-btn {
  display: none;
  cursor: pointer;
  font-size: 14px;
  color: var(--ct-text-muted);
  padding: 2px 6px;
  border-radius: 4px;
  transition: all 0.15s;
  margin-left: auto;
  flex-shrink: 0;
}

.speech-fork-btn:hover {
  color: var(--ct-accent);
  background: var(--ct-bg-tertiary);
}

.message-item:hover .speech-fork-btn {
  display: inline-block;
}

.typing-dots {
  display: flex;
  gap: 3px;
  margin-right: 4px;
}

.typing-dots span {
  width: 4px;
  height: 4px;
  background: var(--ct-accent);
  border-radius: 50%;
  animation: typing 1.4s infinite;
}

.typing-dots span:nth-child(2) { animation-delay: 0.2s; }
.typing-dots span:nth-child(3) { animation-delay: 0.4s; }

@keyframes typing {
  0%, 60%, 100% { transform: translateY(0); }
  30% { transform: translateY(-8px); }
}

.message-body {
  color: var(--ct-text-primary);
  line-height: 1.7;
}

/* Markdown 样式 */
.markdown-body :deep(p) {
  margin: 0 0 12px;
}

.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4),
.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  margin: 16px 0 8px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--ct-text-primary);
}

.markdown-body :deep(h1) { font-size: 1.4em; }
.markdown-body :deep(h2) { font-size: 1.25em; }
.markdown-body :deep(h3) { font-size: 1.1em; }

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 8px 0;
  padding-left: 24px;
}

.markdown-body :deep(li) {
  margin: 4px 0;
}

.markdown-body :deep(code) {
  background: var(--ct-bg-tertiary);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 0.9em;
  font-family: 'Consolas', 'Monaco', monospace;
  color: var(--ct-accent);
}

.markdown-body :deep(pre) {
  background: var(--ct-bg-tertiary);
  border: 1px solid var(--ct-border);
  border-radius: 8px;
  padding: 12px 16px;
  margin: 12px 0;
  overflow-x: auto;
}

.markdown-body :deep(pre code) {
  background: none;
  padding: 0;
  color: var(--ct-text-primary);
}

.markdown-body :deep(blockquote) {
  border-left: 3px solid var(--ct-accent);
  margin: 12px 0;
  padding: 8px 16px;
  color: var(--ct-text-secondary);
  background: var(--ct-bg-tertiary);
  border-radius: 0 8px 8px 0;
}

.markdown-body :deep(blockquote p) {
  margin: 0;
}

.markdown-body :deep(strong) {
  font-weight: 600;
  color: var(--ct-text-primary);
}

.markdown-body :deep(em) {
  font-style: italic;
}

.markdown-body :deep(a) {
  color: var(--ct-accent);
  text-decoration: none;
}

.markdown-body :deep(a:hover) {
  text-decoration: underline;
}

.markdown-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--ct-border);
  margin: 16px 0;
}

.markdown-body :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 12px 0;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--ct-border);
  padding: 8px 12px;
  text-align: left;
}

.markdown-body :deep(th) {
  background: var(--ct-bg-tertiary);
  font-weight: 600;
}

.message-text {
  word-wrap: break-word;
  overflow-wrap: break-word;
}

/* Tool Calls Section */
.tool-calls-section {
  margin-bottom: 12px;
  padding: 8px 12px;
  background: var(--ct-bg-tertiary);
  border: 1px solid var(--ct-border);
  border-radius: 8px;
}

.tool-call-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
  line-height: 1.5;
}

.tool-call-item + .tool-call-item {
  border-top: 1px solid rgba(255, 255, 255, 0.05);
}

.tool-call-icon {
  flex-shrink: 0;
  width: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}

.tool-call-icon .typing-dots span {
  width: 3px;
  height: 3px;
}

.tool-call-name {
  color: var(--ct-accent);
  font-weight: 500;
  white-space: nowrap;
}

.tool-call-summary {
  color: var(--ct-text-secondary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-call-calling .tool-call-name,
.tool-call-executing .tool-call-name {
  color: var(--ct-accent);
  opacity: 0.8;
}

.tool-call-completed .tool-call-name {
  color: var(--ct-text-primary);
}

.tool-call-error .tool-call-name,
.tool-call-timeout .tool-call-name {
  color: #ef4444;
}

.tool-calls-toggle {
  font-size: 12px;
  color: var(--ct-accent);
  cursor: pointer;
  padding: 4px 0 0 20px;
  user-select: none;
  opacity: 0.8;
}

.tool-calls-toggle:hover {
  opacity: 1;
  text-decoration: underline;
}

.loading-skeleton { padding: 40px 20px; }

.session-progress {
  padding: 0 24px;
}

.session-footer {
  background: var(--ct-bg-secondary);
  border-top: 1px solid var(--ct-border);
  padding: 8px 24px;
}

.chat-input { max-width: 900px; margin: 0 auto; }

.chat-input-container {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  background: var(--ct-bg);
  border: 1px solid var(--ct-border);
  border-radius: 12px;
  padding: 8px;
  transition: border-color 0.2s;
}

.chat-input-container:focus-within { border-color: var(--ct-accent); }

.chat-input-container :deep(.el-textarea__inner) {
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0;
  color: var(--ct-text-primary);
  font-size: 15px;
}

.chat-input-container :deep(.el-textarea__inner::placeholder) {
  color: var(--ct-text-muted);
}

.input-hint-text {
  font-size: 12px;
  color: var(--ct-text-muted);
}

.footer-content {
  max-width: 900px;
  margin: 0 auto;
  text-align: center;
}

.footer-hint {
  color: var(--ct-text-secondary);
  font-size: 14px;
}

/* Emperor Messages */
.message-item.emperor-message {
  flex-direction: row-reverse;
}

.emperor-avatar { flex-shrink: 0; }

.message-item.emperor-message .message-content {
  align-self: flex-end;
}

.emperor-avatar-style {
  background: linear-gradient(135deg, #d4af37, #b8971f) !important;
  border-color: #d4af37 !important;
}

.emperor-content {
  background: rgba(212, 175, 55, 0.1) !important;
  border-color: rgba(212, 175, 55, 0.3) !important;
}

/* Court @ Mention Popup */
.court-mention-popup {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  background: var(--ct-bg-secondary);
  border: 1px solid var(--ct-border);
  border-radius: 8px;
  margin-bottom: 8px;
  max-height: 200px;
  overflow-y: auto;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.15);
  z-index: 100;
}

.mention-title {
  font-size: 12px;
  color: var(--ct-text-muted);
  padding: 8px 12px 4px;
  border-bottom: 1px solid var(--ct-border);
}

.mention-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.mention-item:hover {
  background: var(--ct-bg-tertiary);
}

.mention-avatar {
  font-size: 20px;
}

.mention-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--ct-text-primary);
}

.mention-title-text {
  font-size: 12px;
  color: var(--ct-text-muted);
}

.mention-empty {
  padding: 12px;
  text-align: center;
  color: var(--ct-text-muted);
  font-size: 13px;
}

.input-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 2px;
  min-height: auto;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 2px;
}

.toolbar-left :deep(.el-radio-button__inner) {
  font-size: 12px;
  padding: 2px 10px;
}

/* 角色管理弹出层 */
.role-manager-list {
  padding: 4px 0;
}

.role-manager-title {
  font-size: 12px;
  color: var(--ct-text-muted);
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--ct-border);
}

.role-manager-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
}

.role-manager-item:hover {
  background: var(--ct-bg-tertiary);
}

.role-manager-avatar {
  font-size: 18px;
}

.role-manager-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ct-text-primary);
}

.role-manager-title-text {
  font-size: 12px;
  color: var(--ct-text-muted);
  margin-left: auto;
}

@media (max-width: 768px) {
  .message-item { gap: 12px; }
  .avatar-content { width: 40px; height: 40px; font-size: 24px; }
  .message-content { max-width: 85%; }
}

/* Diff 预览样式 */
.tool-diff-toggle {
  cursor: pointer;
  margin-left: 8px;
}

.diff-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 600;
}

.diff-new {
  background: rgba(46, 160, 67, 0.15);
  color: #2ea043;
  border: 1px solid rgba(46, 160, 67, 0.3);
}

.diff-modified {
  background: rgba(210, 153, 34, 0.1);
  border: 1px solid rgba(210, 153, 34, 0.3);
  display: inline-flex;
  gap: 4px;
}

.diff-added { color: #2ea043; }
.diff-removed { color: #cf222e; }

.tool-diff-panel {
  margin-top: 6px;
  border: 1px solid var(--ct-border);
  border-radius: 6px;
  overflow: hidden;
  background: var(--ct-bg-secondary);
  max-height: 400px;
  overflow-y: auto;
}

.diff-file-path {
  padding: 4px 10px;
  font-size: 11px;
  color: var(--ct-text-muted);
  background: var(--ct-bg-tertiary);
  border-bottom: 1px solid var(--ct-border);
  font-family: 'Cascadia Code', 'Fira Code', monospace;
}

.diff-new-file .diff-content {
  padding: 8px 10px;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 300px;
  overflow-y: auto;
}

.diff-all-added {
  background: rgba(46, 160, 67, 0.08);
  color: var(--ct-text-primary);
}

.diff-changes {
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 12px;
  line-height: 1.5;
}

.diff-line {
  display: flex;
  padding: 0 8px;
  min-height: 18px;
}

.diff-line-added {
  background: rgba(46, 160, 67, 0.12);
}

.diff-line-removed {
  background: rgba(207, 34, 46, 0.1);
}

.diff-line-unchanged {
  opacity: 0.6;
}

.diff-line-marker {
  width: 14px;
  flex-shrink: 0;
  font-weight: 700;
  color: var(--ct-text-muted);
}

.diff-line-added .diff-line-marker { color: #2ea043; }
.diff-line-removed .diff-line-marker { color: #cf222e; }

.diff-line-num {
  width: 32px;
  flex-shrink: 0;
  text-align: right;
  color: var(--ct-text-muted);
  opacity: 0.5;
  margin-right: 8px;
  user-select: none;
}

.diff-line-text {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
