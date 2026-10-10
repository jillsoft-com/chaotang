<script setup lang="ts">
import { ref, nextTick, computed, onMounted, onUnmounted, watch } from 'vue'
import { useDebateStore } from '@/stores/debate'
import { createProvider } from '@/services/llm'
import { llmService } from '@/services/llm-config'
import { Promotion, User, FolderOpened, Loading, CircleCloseFilled, Stamp, Download } from '@element-plus/icons-vue'
import { ElMessageBox, ElMessage } from 'element-plus'
import { renderSafeMarkdown } from '@/utils/sanitize-markdown'
import { estimateTokens } from '@/utils/token-utils'
import { exportDebateToMarkdown } from '@/utils/export-markdown'
import type { Speech, LLMConfig, ToolCall, Attachment } from '@/types'
import { CoordinatorAgent } from '@/services/agent'
import { compressContext, getCompressThreshold, countMessageChars } from '@/services/agent/context-compressor'
import { memoryStore } from '@/services/memory'
import { skillRegistry } from '@/services/skills'
import { toolExecutor } from '@/services/tools/executor'
import { getProjectIndex, generateContextHint } from '@/services/agent/repository-context'
import { mcpService } from '@/services/mcp'

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

const emit = defineEmits<{
  (e: 'open-task-panel'): void
  (e: 'open-attachment-panel'): void
}>()

const debateStore = useDebateStore()
const speechesContainer = ref<HTMLElement | null>(null)
const isDebating = ref(false)
const userInput = ref('')
const courtInput = ref('')
const isSending = ref(false)
const hasStartedCourt = ref(false)

// 消息字体大小（从 localStorage 读取，在设置页面中调节）
const messageFontSize = ref(parseInt(localStorage.getItem('message_font_size') || '15', 10))

// ============ Token 跟踪 ============

/** 记录发言的 token 使用统计、模型和耗时 */
function finalizeSpeechUsage(speech: Speech, model: string, startTime: number, promptText?: string) {
  speech.durationMs = Date.now() - startTime
  speech.model = model
  const completionTokens = estimateTokens(speech.content)
  const promptTokens = estimateTokens(promptText || '')
  speech.tokenUsage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens
  }
}

// ============ 拍板 / 圣旨 / 退朝 ============
const awaitingDecree = ref(false)  // 大臣发言完毕，等待圣上拍板
const showDecreeDialog = ref(false)
const decreeInput = ref('')

/** 拍板：打开圣旨输入对话框 */
function handleGavel() {
  decreeInput.value = ''
  showDecreeDialog.value = true
}

/** 确认圣旨：带圣旨完成朝议 */
function handleDecreeConfirm() {
  const decree = decreeInput.value.trim()
  showDecreeDialog.value = false
  awaitingDecree.value = false
  debateStore.completeDebate(decree || undefined, true)
  isNearBottom = true
  nextTick(() => scrollToBottom())
}

/** 退朝：不带圣旨直接结束 */
function handleDismiss() {
  awaitingDecree.value = false
  debateStore.completeDebate(undefined, true)
  isNearBottom = true
  nextTick(() => scrollToBottom())
}

/** 停止朝议（中途终止，然后进入拍板流程） */
function handleStopDebate() {
  if (session.value) {
    session.value.status = 'running' // 确保 shouldContinue 返回 false
    // 将还在 streaming 的发言标记为 completed
    for (const s of session.value.speeches) {
      if (s.status === 'streaming') s.status = 'completed'
    }
  }
  isDebating.value = false
  // 如果有大臣已完成发言，进入拍板等待
  const hasAnyCompleted = session.value?.speeches.some(
    s => s.ministerId !== 'emperor' && s.status === 'completed'
  )
  if (hasAnyCompleted) {
    awaitingDecree.value = true
  } else {
    // 没有大臣发言，直接强制退朝
    debateStore.completeDebate(undefined, true)
  }
}

// ============ 导出 Markdown ============

/** 将当前会话导出为 Markdown 文件 */
async function exportToMarkdown() {
  if (!session.value) return
  const md = exportDebateToMarkdown(session.value, debateStore.ministers)
  const fileName = `${(session.value.topic || '未命名朝议').replace(/[<>:"/\\|?*]/g, '_')}.md`

  // Electron 环境：保存文件对话框
  if (window.electronAPI?.showSaveDialog) {
    try {
      const result = await window.electronAPI.showSaveDialog({
        title: '导出朝议记录',
        defaultPath: fileName,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (!result.canceled && result.filePath) {
        const writeResult = await window.electronAPI.writeFile(result.filePath, md)
        if (writeResult?.success) {
          ElMessage.success('导出成功')
        } else {
          ElMessage.error('导出失败：' + (writeResult?.error || '未知错误'))
        }
      }
    } catch (err) {
      ElMessage.error('导出失败')
    }
  } else {
    // 浏览器环境：下载
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()
    URL.revokeObjectURL(url)
    ElMessage.success('已下载')
  }
}

// ============ 图片粘贴（截图） ============

/** 处理粘贴事件：截图或图片粘贴为附件 */
function handlePaste(e: ClipboardEvent) {
  if (!session.value) return
  const items = e.clipboardData?.items
  if (!items) return
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.type.startsWith('image/')) {
      e.preventDefault()
      const blob = item.getAsFile()
      if (!blob) return
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        if (!session.value) return
        if (!session.value.attachments) session.value.attachments = []
        const att: Attachment = {
          id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          fileName: `截图_${new Date().toLocaleTimeString('zh-CN').replace(/:/g, '')}`,
          filePath: '',
          fileSize: blob.size,
          fileType: item.type.split('/')[1] || 'png',
          content: dataUrl,
          addedAt: Date.now()
        }
        session.value.attachments.push(att)
        ElMessage.success('图片已粘贴为附件')
      }
      reader.readAsDataURL(blob)
      return
    }
  }
}

// ============ 附件上下文注入 ============

/** 将会话附件内容构建为可注入大臣提示词的文本块 */
function getAttachmentContext(): string {
  const attachments = session.value?.attachments
  if (!attachments || attachments.length === 0) return ''

  const parts: string[] = []
  let imageCount = 0
  for (const att of attachments) {
    // 图片附件（data URL）不注入文本，仅标注
    if (att.content && att.content.startsWith('data:image')) {
      imageCount++
      parts.push(`[图片附件: ${att.fileName}]`)
      continue
    }
    if (att.content) {
      parts.push(`--- 附件: ${att.fileName} (${att.fileType}, ${att.fileSize} 字节) ---\n${att.content}\n--- 附件结束 ---`)
    }
  }
  if (parts.length === 0) return ''

  let hint = `\n\n=== 附件材料（请仔细阅读以下文件内容） ===\n${parts.join('\n\n')}\n=== 附件材料结束 ===\n请基于以上附件材料内容，结合你的职责发表意见。`
  if (imageCount > 0) {
    hint += `\n（另有 ${imageCount} 张图片附件，如你的模型支持多模态视觉分析，请参考图片内容。）`
  }
  return hint
}

function formatAttSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

// ============ 会话内附件操作 ============

const isDraggingFiles = ref(false)
const attachingSessionFile = ref(false)

async function addSessionAttachment() {
  if (!window.electronAPI?.showOpenDialog || !window.electronAPI?.readAttachment || !session.value) {
    ElMessageBox.alert('附件功能需要 Electron 桌面版支持', '提示', { type: 'info' })
    return
  }
  attachingSessionFile.value = true
  try {
    const result = await window.electronAPI.showOpenDialog({
      title: '添加附件到当前会话',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '文档', extensions: ['pdf', 'doc', 'docx', 'txt', 'md', 'csv', 'xlsx', 'xls', 'pptx'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return
    await loadSessionAttachments(result.filePaths)
  } catch (error) {
    console.error('[addSessionAttachment] 失败:', error)
  } finally {
    attachingSessionFile.value = false
  }
}

async function loadSessionAttachments(filePaths: string[]) {
  if (!window.electronAPI?.readAttachment || !session.value) return
  if (!session.value.attachments) session.value.attachments = []
  for (const filePath of filePaths) {
    const readResult = await window.electronAPI.readAttachment(filePath)
    if (readResult.success && readResult.content) {
      const att: Attachment = {
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        fileName: readResult.fileName || filePath.split(/[\\/]/).pop() || '附件',
        filePath,
        fileSize: readResult.fileSize || 0,
        fileType: readResult.fileType || 'unknown',
        content: readResult.content,
        addedAt: Date.now()
      }
      session.value.attachments.push(att)
    } else {
      ElMessageBox.alert(`文件读取失败：${readResult.error || '未知错误'}\n${filePath}`, '附件导入失败', { type: 'error' })
    }
  }
}

function removeSessionAttachment(id: string) {
  if (!session.value?.attachments) return
  session.value.attachments = session.value.attachments.filter(a => a.id !== id)
}

function onSessionDragOver(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer?.types.includes('Files')) {
    isDraggingFiles.value = true
  }
}

function onSessionDragLeave(e: DragEvent) {
  e.preventDefault()
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const { clientX, clientY } = e
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    isDraggingFiles.value = false
  }
}

async function onSessionDropFiles(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  isDraggingFiles.value = false
  const files = e.dataTransfer?.files
  if (!files || files.length === 0 || !session.value) return
  const paths: string[] = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i] as any
    if (f.path) paths.push(f.path)
  }
  if (paths.length > 0) {
    await loadSessionAttachments(paths)
  } else {
    ElMessageBox.alert('无法获取文件路径，请通过按钮选择文件', '拖拽导入失败', { type: 'warning' })
  }
}

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

// ============ 轮次索引（以圣上发言为准） ============

const currentRoundIndex = ref(-1)
let speechObserver: IntersectionObserver | null = null
const showRoundIndex = ref(true)

/** 只取圣上的发言作为轮次 */
const roundEntries = computed(() => {
  if (!session.value) return []
  const entries: { id: string; roundNum: number; preview: string }[] = []
  let num = 0
  for (const s of session.value.speeches) {
    if (s.ministerId === 'emperor') {
      num++
      const text = (s.content || '').replace(/\n/g, ' ').trim()
      const preview = text.length > 10 ? text.slice(0, 10) + '…' : text
      entries.push({ id: s.id, roundNum: num, preview })
    }
  }
  return entries
})

function scrollToSpeech(speechId: string) {
  const el = document.getElementById(`speech-${speechId}`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

function initSpeechObserver() {
  speechObserver?.disconnect()
  const container = speechesContainer.value
  if (!container) return

  speechObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const id = (entry.target as HTMLElement).dataset.speechId
          if (id) {
            const rIdx = roundEntries.value.findIndex(r => r.id === id)
            if (rIdx >= 0) {
              currentRoundIndex.value = rIdx
            }
          }
        }
      }
    },
    { root: container, threshold: 0.5 }
  )

  // 只观察圣上的发言
  for (const r of roundEntries.value) {
    const el = document.getElementById(`speech-${r.id}`)
    if (el) speechObserver.observe(el)
  }
}

// ============ 会话内搜索 ============

const showSearch = ref(false)
const searchQuery = ref('')
const searchMatchIds = ref<string[]>([])
const searchCurrentIdx = ref(-1)
const searchInputRef = ref<HTMLInputElement | null>(null)

function toggleSearch() {
  showSearch.value = !showSearch.value
  if (showSearch.value) {
    nextTick(() => searchInputRef.value?.focus())
  } else {
    searchQuery.value = ''
    searchMatchIds.value = []
    searchCurrentIdx.value = -1
    clearSearchHighlights()
  }
}

function doSearch() {
  const q = searchQuery.value.trim()
  if (!q || !session.value) {
    searchMatchIds.value = []
    searchCurrentIdx.value = -1
    clearSearchHighlights()
    return
  }
  const lower = q.toLowerCase()
  const ids: string[] = []
  for (const s of session.value.speeches) {
    if (s.content && s.content.toLowerCase().includes(lower)) {
      ids.push(s.id)
    }
  }
  searchMatchIds.value = ids
  searchCurrentIdx.value = ids.length > 0 ? 0 : -1
  highlightMatches()
  if (ids.length > 0) scrollToSearchMatch()
}

function goToSearchMatch(dir: 1 | -1) {
  if (searchMatchIds.value.length === 0) return
  const len = searchMatchIds.value.length
  searchCurrentIdx.value = (searchCurrentIdx.value + dir + len) % len
  highlightMatches()
  scrollToSearchMatch()
}

function scrollToSearchMatch() {
  const id = searchMatchIds.value[searchCurrentIdx.value]
  if (!id) return
  const el = document.getElementById(`speech-${id}`)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function highlightMatches() {
  clearSearchHighlights()
  for (const id of searchMatchIds.value) {
    const el = document.getElementById(`speech-${id}`)
    if (el) el.classList.add('search-match')
  }
  const currentId = searchMatchIds.value[searchCurrentIdx.value]
  if (currentId) {
    const el = document.getElementById(`speech-${currentId}`)
    if (el) el.classList.add('search-match-current')
  }
}

function clearSearchHighlights() {
  document.querySelectorAll('.search-match').forEach(el => {
    el.classList.remove('search-match', 'search-match-current')
  })
}

function onSearchKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    goToSearchMatch(e.shiftKey ? -1 : 1)
  } else if (e.key === 'Escape') {
    toggleSearch()
  }
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

// ============ 消息操作（复制/重试） ============

/** 复制发言内容到剪贴板 */
async function copySpeechContent(content: string) {
  try {
    await navigator.clipboard.writeText(content)
    ElMessageBox.alert('已复制到剪贴板', '', {
      showClose: false,
      showConfirmButton: false,
      type: 'success',
      callback: () => {}
    })
    // 自动关闭提示
    setTimeout(() => {
      const overlay = document.querySelector('.el-overlay')
      if (overlay) (overlay as HTMLElement).click()
    }, 800)
  } catch {
    ElMessageBox.alert('复制失败，请手动选择复制', '提示', { type: 'warning' })
  }
}

/** 判断是否是最后一条大臣发言（用于显示重试按钮） */
function isLastMinisterSpeech(speech: Speech): boolean {
  if (!session.value) return false
  const ministerSpeeches = session.value.speeches.filter(s => s.ministerId !== 'emperor')
  return ministerSpeeches.length > 0 && ministerSpeeches[ministerSpeeches.length - 1].id === speech.id
}

/** 重新生成最后一条大臣发言 */
async function retrySpeech(speech: Speech) {
  if (!session.value || isSending.value) return
  // 清空该发言内容，重新生成
  speech.content = ''
  speech.status = 'streaming'
  speech.toolStatuses = []
  isSending.value = true
  try {
    const minister = debateStore.ministers.find(m => m.id === speech.ministerId)
    if (!minister) return
    const topic = session.value.topic || ''
    const systemPrompt = minister.systemPrompt || `你是${minister.name}，${minister.title}。`
    const userMessage = topic
    await runMinisterTurn({
      ministerId: speech.ministerId,
      systemPrompt,
      userMessage,
      reactiveSpeech: speech,
      onContent: (content) => { speech.content = content }
    })
    speech.status = 'completed'
  } catch (err) {
    speech.status = 'error'
    speech.content += `\n\n❌ 重新生成失败: ${err}`
  } finally {
    isSending.value = false
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

watch(() => roundEntries.value.length, () => {
  nextTick(() => initSpeechObserver())
})

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
  // Ctrl+F 打开搜索
  window.addEventListener('keydown', handleGlobalKeydown)
  // 粘贴图片
  window.addEventListener('paste', handlePaste)
})

function handleGlobalKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault()
    if (!showSearch.value) {
      showSearch.value = true
      nextTick(() => searchInputRef.value?.focus())
    }
  }
  // Ctrl+E 导出
  if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
    e.preventDefault()
    exportToMarkdown()
  }
}

onUnmounted(() => {
  speechesContainer.value?.removeEventListener('scroll', checkScrollPosition)
  speechObserver?.disconnect()
  window.removeEventListener('keydown', handleGlobalKeydown)
  window.removeEventListener('paste', handlePaste)
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

  // Sprint B - #8：仓库级自动上下文注入
  let repoContextHint = ''
  try {
    const index = await getProjectIndex(workingDir)
    if (index.chunks.length > 0) {
      const ctx = generateContextHint(index, topic, 3000)
      if (ctx) {
        repoContextHint = `\n\n=== 仓库上下文（自动索引） ===\n${ctx}\n=== 上下文结束 ===`
      }
    }
  } catch (err) {
    console.warn('[runMinisterTurn] 仓库索引构建失败:', err)
  }

  const toolDefs = skillRegistry.getToolDefinitionsForMinister(ministerId)
  // Sprint B - #5：追加 MCP 工具定义 + 注册处理器
  const mcpDefs = mcpService.getAllToolDefinitions()
  const mcpHandlers = mcpService.getAllHandlers()
  const mcpToolNames: string[] = []
  for (const [fnName, handler] of Object.entries(mcpHandlers)) {
    const def = mcpDefs.find(d => d.function.name === fnName)
    if (def && !toolExecutor.hasTool(fnName)) {
      toolExecutor.register(def, handler, { displayName: `🔌 MCP - ${def.function.description}` })
      mcpToolNames.push(fnName)
    }
  }
  const combinedDefs = [...toolDefs, ...mcpDefs]
  // 确保至少有基础文件工具
  const allToolDefs = combinedDefs.length > 0 ? combinedDefs : skillRegistry.getToolDefinitionsForMinister('chancellor')

  const messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: any; tool_call_id?: string; name?: string }> = [
    { role: 'system', content: systemPrompt + dirHint + agentsMdHint + memoryHint + repoContextHint },
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

      // lint_check / type_check / refactor_rename: 自动注入 cwd
      if ((tc.function.name === 'lint_check' || tc.function.name === 'type_check' || tc.function.name === 'refactor_rename') && workingDir) {
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

  // 清理本次注册的 MCP 工具处理器
  for (const name of mcpToolNames) {
    toolExecutor.unregister(name)
  }
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
        const attachCtx = getAttachmentContext()
        const userMessage = `议题：${session.value!.topic}${attachCtx}\n\n请结合你的职责完成你的工作。`
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

        const attachCtx = getAttachmentContext()
        const userMessage = previousSpeeches
          ? `议题：${session.value.topic}${attachCtx}\n\n前序角色的输出：\n${previousSpeeches}\n\n请仔细阅读以上内容，结合你的职责完成你的工作。`
          : `议题：${session.value.topic}${attachCtx}\n\n请结合你的职责完成你的工作。`

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

  // 大臣发言完毕 → 进入拍板等待状态（不自动 complete）
  awaitingDecree.value = true
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
        const attachCtx = getAttachmentContext()
        const userMessage = `议题：${session.value!.topic}${attachCtx}\n\n请结合你的职责完成你的工作。`
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
      topic: session.value.topic + getAttachmentContext(),
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

    const startTime = Date.now()
    const promptText = messages.map(m => m.content).join('\n')
    await provider.chatStream(messages, (content) => {
      reactiveReply.content = content
      throttledScroll()
    })
    reactiveReply.status = 'completed'
    finalizeSpeechUsage(reactiveReply, minister.llm.model, startTime, promptText)
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
          topic: (emperorSpeech.content || session.value!.topic) + getAttachmentContext(),
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
      // Agent 追问完成后也进入拍板等待
      awaitingDecree.value = true
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

        const attachCtx = getAttachmentContext()
        const userMessage = history
          ? `${history}${attachCtx}\n\n请你基于以上发言，发表你的意见。`
          : `请发表你的意见。${attachCtx}`

        const startTime = Date.now()
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
        finalizeSpeechUsage(reactiveSpeech, minister.llm.model, startTime, minister.systemPrompt + userMessage)
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

        const attachCtx = getAttachmentContext()
        const userMessage = history
          ? `${history}${attachCtx}\n\n请你基于以上发言，发表你的意见。`
          : `请发表你的意见。${attachCtx}`

        const startTime = Date.now()
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
        finalizeSpeechUsage(reactiveSpeech, minister.llm.model, startTime, minister.systemPrompt + userMessage)
      } catch (error) {
        reactiveSpeech.content = `进言失败：${error instanceof Error ? error.message : '未知错误'}`
        reactiveSpeech.status = 'error'
      }

      await nextTick()
      scrollToBottom()
    }
  }

  isSending.value = false

  // 追问完成后也进入拍板等待
  awaitingDecree.value = true

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

function isImageAvatar(avatar: string): boolean {
  return avatar.startsWith('http') || avatar.startsWith('data:')
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
    <!-- 轮次索引 -->
    <div v-if="roundEntries.length > 1 && showRoundIndex" class="round-index">
      <div class="round-index-list">
        <div
          v-for="(entry, idx) in roundEntries"
          :key="entry.id"
          class="round-index-item"
          :class="{ active: currentRoundIndex === idx }"
          :title="entry.preview"
          @click="scrollToSpeech(entry.id)"
        >
          <span class="round-index-line"></span>
        </div>
      </div>
      <div class="round-index-footer" @click="showRoundIndex = false" title="收起">
        <span>◀</span>
      </div>
    </div>
    <div v-if="roundEntries.length > 1 && !showRoundIndex" class="round-index-collapsed" @click="showRoundIndex = true" title="展开轮次索引">
      <span>▶</span>
    </div>
    <!-- 搜索条 -->
    <div v-if="showSearch" class="search-bar">
      <div class="search-bar-inner">
        <input
          ref="searchInputRef"
          v-model="searchQuery"
          class="search-input"
          placeholder="搜索会话内容…"
          @input="doSearch"
          @keydown="onSearchKeydown"
        />
        <span v-if="searchMatchIds.length > 0" class="search-count">
          {{ searchCurrentIdx + 1 }} / {{ searchMatchIds.length }}
        </span>
        <span v-else-if="searchQuery.trim()" class="search-count search-no-match">无匹配</span>
        <button class="search-nav-btn" @click="goToSearchMatch(-1)" :disabled="searchMatchIds.length === 0" title="上一个 (Shift+Enter)">▲</button>
        <button class="search-nav-btn" @click="goToSearchMatch(1)" :disabled="searchMatchIds.length === 0" title="下一个 (Enter)">▼</button>
        <button class="search-close-btn" @click="toggleSearch" title="关闭 (Esc)">×</button>
      </div>
    </div>
    <!-- 消息区域 -->
    <main ref="speechesContainer" class="session-messages">
      <div class="messages-inner">
        <div
          v-for="speech in session.speeches"
          :key="speech.id"
          :id="`speech-${speech.id}`"
          :data-speech-id="speech.id"
          class="message-item"
          :class="{
            streaming: speech.status === 'streaming',
            error: speech.status === 'error',
            'emperor-message': speech.ministerId === 'emperor'
          }"
        >
          <div class="message-avatar" v-if="speech.ministerId !== 'emperor'">
            <div class="avatar-content">
              <img v-if="isImageAvatar(getMinisterAvatar(speech.ministerId))" :src="getMinisterAvatar(speech.ministerId)" class="avatar-img" />
              <span v-else>{{ getMinisterAvatar(speech.ministerId) }}</span>
            </div>
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
            </div>

            <div class="message-body" :style="{ fontSize: messageFontSize + 'px' }">
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

            <!-- 消息操作栏（底部） -->
            <div v-if="speech.status === 'completed'" class="message-actions">
              <span
                v-if="session.speeches.indexOf(speech) > 0"
                class="speech-fork-btn"
                title="从此处分叉新会话"
                @click.stop="forkFromSpeech(speech.id)"
              >⑂ 分叉</span>
              <span
                v-if="speech.content"
                class="speech-action-btn"
                title="复制内容"
                @click.stop="copySpeechContent(speech.content)"
              >📋 复制</span>
              <span
                v-if="speech.ministerId !== 'emperor' && isLastMinisterSpeech(speech)"
                class="speech-action-btn speech-retry-btn"
                title="重新生成"
                @click.stop="retrySpeech(speech)"
              >🔄 重试</span>
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

    <!-- 拍板 / 退朝 操作栏（大臣发言完毕后显示） -->
    <div v-if="awaitingDecree && session.mode === 'court' && session.status === 'running'" class="decree-action-bar">
      <div class="decree-action-inner">
        <span class="decree-action-hint">⚖️ 众大臣已进言完毕，请圣上定夺</span>
        <div class="decree-action-buttons">
          <el-button type="warning" :icon="Stamp" @click="handleGavel" size="default">
            拍板
          </el-button>
          <el-button type="info" plain :icon="CircleCloseFilled" @click="handleDismiss" size="default">
            退朝
          </el-button>
        </div>
      </div>
    </div>

    <!-- 圣旨输入对话框 -->
    <el-dialog
      v-model="showDecreeDialog"
      title="📜 圣旨"
      width="560px"
      :close-on-click-modal="false"
      align-center
    >
      <div class="decree-dialog-body">
        <p class="decree-dialog-hint">请圣上颁布圣旨，总结本次朝议的最终决策：</p>
        <el-input
          v-model="decreeInput"
          type="textarea"
          :autosize="{ minRows: 4, maxRows: 10 }"
          placeholder="例如：采纳丞相方案，先做 MVP 验证，预算控制在 50 万以内…"
          resize="vertical"
          @keydown.ctrl.enter.prevent="handleDecreeConfirm"
        />
        <p class="decree-dialog-tip">Ctrl + Enter 快速颁布</p>
      </div>
      <template #footer>
        <el-button @click="showDecreeDialog = false">取消</el-button>
        <el-button type="warning" :icon="Stamp" @click="handleDecreeConfirm">
          颁布圣旨
        </el-button>
      </template>
    </el-dialog>

    <!-- Sprint A - #1：决策质量报告（四象限） -->
    <div
      v-if="session.mode === 'court' && session.status === 'completed'"
      class="decision-report-wrapper"
    >
      <div v-if="!session.decisionReport" class="decision-report-loading">
        <el-icon class="is-loading"><Loading /></el-icon>
        <span>丞相正在整理决策报告（共识 / 分歧 / 风险 / 假设）…</span>
      </div>
      <div v-else class="decision-report">
        <header class="decision-report-header">
          <h3 class="decision-report-title">📜 决策报告</h3>
          <span class="decision-report-time">
            {{ new Date(session.decisionReport.generatedAt).toLocaleTimeString('zh-CN') }}
          </span>
        </header>
        <p v-if="session.decisionReport.verdict" class="decision-report-verdict">
          <strong>🎯 决策结论：</strong>{{ session.decisionReport.verdict }}
        </p>
        <div class="decision-report-grid">
          <section class="quadrant quadrant-consensus">
            <h4>✅ 共识点 ({{ session.decisionReport.consensus.length }})</h4>
            <ul v-if="session.decisionReport.consensus.length > 0">
              <li v-for="item in session.decisionReport.consensus" :key="item.id">
                <strong>{{ item.title }}</strong>
                <p>{{ item.detail }}</p>
                <span class="quadrant-sources" v-if="item.sources && item.sources.length > 0">
                  来源：{{ item.sources.map(id => getMinisterName(id)).join('、') }}
                </span>
              </li>
            </ul>
            <p v-else class="quadrant-empty">— 无 —</p>
          </section>
          <section class="quadrant quadrant-disagreements">
            <h4>⚔️ 分歧点 ({{ session.decisionReport.disagreements.length }})</h4>
            <ul v-if="session.decisionReport.disagreements.length > 0">
              <li v-for="item in session.decisionReport.disagreements" :key="item.id">
                <strong>{{ item.title }}</strong>
                <p>{{ item.detail }}</p>
                <span class="quadrant-sources" v-if="item.sources && item.sources.length > 0">
                  相关方：{{ item.sources.map(id => getMinisterName(id)).join('、') }}
                </span>
              </li>
            </ul>
            <p v-else class="quadrant-empty">— 无 —</p>
          </section>
          <section class="quadrant quadrant-risks">
            <h4>⚠️ 风险清单 ({{ session.decisionReport.risks.length }})</h4>
            <ul v-if="session.decisionReport.risks.length > 0">
              <li v-for="item in session.decisionReport.risks" :key="item.id">
                <strong>{{ item.title }}</strong>
                <p>{{ item.detail }}</p>
              </li>
            </ul>
            <p v-else class="quadrant-empty">— 无 —</p>
          </section>
          <section class="quadrant quadrant-assumptions">
            <h4>🔍 待验证假设 ({{ session.decisionReport.assumptions.length }})</h4>
            <ul v-if="session.decisionReport.assumptions.length > 0">
              <li v-for="item in session.decisionReport.assumptions" :key="item.id">
                <strong>{{ item.title }}</strong>
                <p>{{ item.detail }}</p>
              </li>
            </ul>
            <p v-else class="quadrant-empty">— 无 —</p>
          </section>
        </div>
        <section v-if="session.decisionReport.nextSteps && session.decisionReport.nextSteps.length > 0" class="decision-report-nextsteps">
          <h4>🚀 下一步行动</h4>
          <ol>
            <li v-for="(step, i) in session.decisionReport.nextSteps" :key="i">{{ step }}</li>
          </ol>
        </section>
      </div>
    </div>

    <!-- 底部 -->
    <footer class="session-footer">
      <!-- 召见模式 - 聊天输入 -->
      <div v-if="isPrivate" class="chat-input">
        <div
          class="chat-input-container"
          style="position: relative;"
          :class="{ 'drag-over': isDraggingFiles }"
          @dragover="onSessionDragOver"
          @dragleave="onSessionDragLeave"
          @drop="onSessionDropFiles"
        >
          <div v-if="isDraggingFiles" class="drop-overlay">
            <div class="drop-overlay-content">📎 释放文件以添加附件</div>
          </div>
          <el-input
            v-model="userInput"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 4 }"
            placeholder="陛下有何圣谕..."
            @keydown.enter.exact.prevent="sendMessage"
            resize="none"
            :disabled="isSending"
          />
          <el-tooltip content="Enter 发送 · Shift+Enter 换行" placement="top">
            <el-button
              type="primary"
              :icon="Promotion"
              circle
              size="small"
              :disabled="!userInput.trim() || isSending"
              :loading="isSending"
              @click="sendMessage"
            />
          </el-tooltip>
        </div>
        <!-- 会话附件列表 -->
        <div v-if="session?.attachments && session.attachments.length > 0" class="session-attachment-chips">
          <div v-for="att in session.attachments" :key="att.id" class="session-att-chip">
            <img v-if="att.content && att.content.startsWith('data:image')" :src="att.content" class="session-att-chip-thumb" />
            <span v-else class="session-att-chip-icon">📎</span>
            <span class="session-att-chip-name" :title="att.filePath || att.fileName">{{ att.fileName }}</span>
            <span class="session-att-chip-size">{{ formatAttSize(att.fileSize) }}</span>
            <button class="session-att-chip-remove" @click="removeSessionAttachment(att.id)">&times;</button>
          </div>
        </div>
        <div class="input-toolbar">
          <div class="toolbar-left">
            <el-tooltip content="添加附件" placement="top">
              <el-button size="small" circle :loading="attachingSessionFile" @click="addSessionAttachment" class="toolbar-icon-btn">
                <template v-if="!attachingSessionFile">📎</template>
              </el-button>
            </el-tooltip>
            <el-badge :value="session?.attachments?.length || 0" :hidden="!session?.attachments?.length" type="primary">
              <el-tooltip content="附件列表" placement="top">
                <el-button size="small" circle @click="emit('open-attachment-panel')" class="toolbar-icon-btn">📂</el-button>
              </el-tooltip>
            </el-badge>
            <el-tooltip content="关联任务" placement="top">
              <el-button size="small" circle @click="emit('open-task-panel')" class="toolbar-icon-btn">📋</el-button>
            </el-tooltip>
            <el-tooltip content="搜索 (Ctrl+F)" placement="top">
              <el-button size="small" circle @click="toggleSearch" class="toolbar-icon-btn" :class="{ 'search-active': showSearch }">🔍</el-button>
            </el-tooltip>
            <el-tooltip content="导出 Markdown (Ctrl+E)" placement="top">
              <el-button size="small" circle @click="exportToMarkdown" class="toolbar-icon-btn">
                <el-icon><Download /></el-icon>
              </el-button>
            </el-tooltip>
          </div>
          <div class="toolbar-right">
            <!-- 工作目录（只读展示） -->
            <el-tooltip v-if="session?.workingDirectory" :content="session.workingDirectory" placement="top">
              <el-button size="small" :icon="FolderOpened" type="warning">
                {{ sessionDirName }}
              </el-button>
            </el-tooltip>
          </div>
        </div>
      </div>

      <!-- 朝议模式 - 继续发言输入 -->
      <div v-else class="chat-input">
        <div
          class="chat-input-container"
          style="position: relative;"
          :class="{ 'drag-over': isDraggingFiles }"
          @dragover="onSessionDragOver"
          @dragleave="onSessionDragLeave"
          @drop="onSessionDropFiles"
        >
          <div v-if="isDraggingFiles" class="drop-overlay">
            <div class="drop-overlay-content">📎 释放文件以添加附件</div>
          </div>
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
          <el-tooltip content="Enter 发送 · Shift+Enter 换行 · @ 指定大臣" placement="top">
            <el-button
              type="primary"
              :icon="Promotion"
              circle
              size="small"
              :disabled="!courtInput.trim() || isSending"
              :loading="isSending"
              @click="sendCourtMessage"
            />
          </el-tooltip>
        </div>
        <!-- 会话附件列表 -->
        <div v-if="session?.attachments && session.attachments.length > 0" class="session-attachment-chips">
          <div v-for="att in session.attachments" :key="att.id" class="session-att-chip">
            <img v-if="att.content && att.content.startsWith('data:image')" :src="att.content" class="session-att-chip-thumb" />
            <span v-else class="session-att-chip-icon">📎</span>
            <span class="session-att-chip-name" :title="att.filePath || att.fileName">{{ att.fileName }}</span>
            <span class="session-att-chip-size">{{ formatAttSize(att.fileSize) }}</span>
            <button class="session-att-chip-remove" @click="removeSessionAttachment(att.id)">&times;</button>
          </div>
        </div>
        <div class="input-toolbar">
          <div class="toolbar-left">
            <el-radio-group v-model="debateStore.debateMode" size="small">
              <el-radio-button value="serial">串行</el-radio-button>
              <el-radio-button value="parallel">并行</el-radio-button>
              <el-radio-button value="agent">Agent</el-radio-button>
            </el-radio-group>
            <el-tooltip content="添加附件" placement="top">
              <el-button size="small" circle :loading="attachingSessionFile" @click="addSessionAttachment" class="toolbar-icon-btn">
                <template v-if="!attachingSessionFile">📎</template>
              </el-button>
            </el-tooltip>
            <el-badge :value="session?.attachments?.length || 0" :hidden="!session?.attachments?.length" type="primary">
              <el-tooltip content="附件列表" placement="top">
                <el-button size="small" circle @click="emit('open-attachment-panel')" class="toolbar-icon-btn">📂</el-button>
              </el-tooltip>
            </el-badge>
            <el-tooltip content="关联任务" placement="top">
              <el-button size="small" circle @click="emit('open-task-panel')" class="toolbar-icon-btn">📋</el-button>
            </el-tooltip>
            <el-tooltip content="搜索 (Ctrl+F)" placement="top">
              <el-button size="small" circle @click="toggleSearch" class="toolbar-icon-btn" :class="{ 'search-active': showSearch }">🔍</el-button>
            </el-tooltip>
            <el-tooltip content="导出 Markdown (Ctrl+E)" placement="top">
              <el-button size="small" circle @click="exportToMarkdown" class="toolbar-icon-btn">
                <el-icon><Download /></el-icon>
              </el-button>
            </el-tooltip>
          </div>
          <div class="toolbar-right">
            <!-- 角色管理 -->
            <el-popover trigger="click" placement="top" :width="300">
              <template #reference>
                <el-button size="small" circle :icon="User" class="toolbar-icon-btn" title="参与讨论的角色" />
              </template>
              <div class="role-manager-list">
                <div class="role-manager-title">选择参与讨论的角色</div>
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
            <el-tooltip v-if="session?.workingDirectory" :content="session.workingDirectory" placement="top">
              <el-button size="small" :icon="FolderOpened" type="warning">
                {{ sessionDirName }}
              </el-button>
            </el-tooltip>
          </div>
        </div>

        <!-- 朝议进行中：停止按钮 -->
        <div v-if="isDebating && !isPrivate" class="debate-stop-bar">
          <el-button type="danger" plain size="small" @click="handleStopDebate">
            ⏹ 停止朝议
          </el-button>
          <span class="debate-stop-hint">可随时拍板结束，已完成的发言将被保留</span>
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
  position: relative;
}

/* 轮次索引 */
.round-index {
  position: absolute;
  left: 6px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: center;
  background: var(--ct-bg-secondary);
  border: 1px solid var(--ct-border);
  border-radius: 8px;
  padding: 4px 2px;
  opacity: 0.5;
  transition: opacity 0.2s;
  max-height: 70vh;
}

.round-index:hover {
  opacity: 1;
}

.round-index-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  scrollbar-width: thin;
}

.round-index-item {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px 6px;
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.15s;
}

.round-index-item:hover {
  background: var(--ct-bg-tertiary);
}

.round-index-item.active .round-index-line {
  background: var(--ct-accent);
}

.round-index-line {
  display: block;
  width: 18px;
  height: 3px;
  background: var(--ct-text-muted);
  border-radius: 1.5px;
  opacity: 0.5;
}

.round-index-item:hover .round-index-line {
  opacity: 0.8;
}

.round-index-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px 4px;
  margin-top: 4px;
  border-top: 1px solid var(--ct-border);
  cursor: pointer;
  color: var(--ct-text-muted);
  font-size: 9px;
}

.round-index-footer:hover {
  color: var(--ct-text-primary);
}

.round-index-collapsed {
  position: absolute;
  left: 6px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 10;
  width: 18px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ct-bg-secondary);
  border: 1px solid var(--ct-border);
  border-radius: 6px;
  cursor: pointer;
  color: var(--ct-text-muted);
  font-size: 9px;
  opacity: 0.4;
  transition: opacity 0.2s;
}

.round-index-collapsed:hover {
  opacity: 1;
  color: var(--ct-accent);
}

/* 搜索条 */
.search-bar {
  position: absolute;
  top: 8px;
  right: 32px;
  z-index: 20;
  animation: slideDown 0.2s ease;
}

@keyframes slideDown {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}

.search-bar-inner {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--ct-bg-secondary);
  border: 1px solid var(--ct-border);
  border-radius: 8px;
  padding: 4px 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.search-input {
  width: 200px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--ct-text-primary);
  font-size: 13px;
  padding: 4px 0;
}

.search-input::placeholder {
  color: var(--ct-text-muted);
}

.search-count {
  font-size: 11px;
  color: var(--ct-text-secondary);
  white-space: nowrap;
  min-width: 40px;
  text-align: center;
}

.search-no-match {
  color: #ef4444;
  font-size: 11px;
}

.search-nav-btn,
.search-close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--ct-text-secondary);
  cursor: pointer;
  font-size: 11px;
  transition: all 0.15s;
}

.search-nav-btn:hover:not(:disabled),
.search-close-btn:hover {
  background: var(--ct-bg-tertiary);
  color: var(--ct-text-primary);
}

.search-nav-btn:disabled {
  opacity: 0.3;
  cursor: default;
}

.search-close-btn {
  font-size: 16px;
  font-weight: bold;
}

.search-close-btn:hover {
  color: #ef4444;
}

.toolbar-icon-btn.search-active {
  background: rgba(212, 175, 55, 0.15) !important;
  border-color: var(--ct-accent) !important;
}

/* 搜索匹配高亮 */
.message-item.search-match > .message-content {
  border-left: 3px solid rgba(212, 175, 55, 0.4);
}

.message-item.search-match-current > .message-content {
  border-left: 3px solid var(--ct-accent);
  box-shadow: 0 0 0 2px rgba(212, 175, 55, 0.1);
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
  overflow: hidden;
}

.avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 10px;
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
  font-size: 12px;
  color: var(--ct-text-muted);
  padding: 2px 8px;
  border-radius: 4px;
  transition: all 0.15s;
  flex-shrink: 0;
}

.speech-fork-btn:hover {
  color: var(--ct-accent);
  background: var(--ct-bg-tertiary);
}

.message-item:hover .speech-fork-btn {
  display: inline-block;
}

/* 消息操作栏（底部） */
.message-actions {
  display: flex;
  gap: 4px;
  padding-top: 8px;
  margin-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  opacity: 0;
  transition: opacity 0.15s;
}

.message-item:hover .message-actions {
  opacity: 1;
}

.speech-action-btn {
  cursor: pointer;
  font-size: 12px;
  color: var(--ct-text-muted);
  padding: 2px 8px;
  border-radius: 4px;
  transition: all 0.15s;
  flex-shrink: 0;
}

.speech-action-btn:hover {
  color: var(--ct-accent);
  background: var(--ct-bg-tertiary);
}

.speech-retry-btn:hover {
  color: #f59e0b;
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

/* 拍板/退朝 操作栏 */
.decree-action-bar {
  background: linear-gradient(180deg, transparent, rgba(212, 175, 55, 0.06));
  border-top: 1px solid rgba(212, 175, 55, 0.2);
  padding: 12px 24px;
}

.decree-action-inner {
  max-width: 900px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.decree-action-hint {
  font-size: 14px;
  color: var(--ct-text-secondary);
  font-weight: 500;
}

.decree-action-buttons {
  display: flex;
  gap: 10px;
}

/* 圣旨对话框 */
.decree-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.decree-dialog-hint {
  font-size: 14px;
  color: var(--ct-text-secondary);
  margin: 0;
}

.decree-dialog-tip {
  font-size: 12px;
  color: var(--ct-text-muted);
  margin: 0;
  text-align: right;
}

/* 停止朝议按钮 */
.debate-stop-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
  padding-top: 4px;
}

.debate-stop-hint {
  font-size: 12px;
  color: var(--ct-text-muted);
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
  margin-top: 4px;
  gap: 6px;
  flex-wrap: wrap;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 4px;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 4px;
}

.toolbar-icon-btn {
  width: 28px !important;
  height: 28px !important;
  padding: 0 !important;
  font-size: 14px !important;
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

/* Sprint A - #1：决策报告（四象限） */
.decision-report-wrapper {
  padding: 0 24px 12px;
  max-width: 1100px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}

.decision-report-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px;
  border: 1px dashed var(--ct-border);
  border-radius: 10px;
  color: var(--ct-text-secondary);
  background: var(--ct-bg-secondary);
  font-size: 13px;
}

.decision-report {
  border: 1px solid var(--ct-border);
  border-radius: 12px;
  padding: 18px;
  background: var(--ct-bg-secondary);
}

.decision-report-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--ct-border);
  padding-bottom: 10px;
  margin-bottom: 12px;
}

.decision-report-title {
  margin: 0;
  font-size: 18px;
  color: var(--ct-accent);
}

.decision-report-time {
  font-size: 12px;
  color: var(--ct-text-muted);
}

.decision-report-verdict {
  margin: 4px 0 14px;
  padding: 10px 12px;
  background: rgba(212, 175, 55, 0.08);
  border-left: 3px solid var(--ct-accent);
  border-radius: 4px;
  color: var(--ct-text-primary);
  font-size: 14px;
}

.decision-report-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

@media (max-width: 768px) {
  .decision-report-grid { grid-template-columns: 1fr; }
}

.quadrant {
  padding: 12px;
  border-radius: 8px;
  background: var(--ct-bg);
  border: 1px solid var(--ct-border);
}

.quadrant h4 {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--ct-text-primary);
}

.quadrant ul {
  margin: 0;
  padding-left: 18px;
}

.quadrant li {
  margin-bottom: 8px;
}

.quadrant li strong {
  color: var(--ct-text-primary);
  font-size: 13px;
}

.quadrant li p {
  margin: 2px 0 4px;
  font-size: 13px;
  color: var(--ct-text-secondary);
  line-height: 1.5;
}

.quadrant-sources {
  display: inline-block;
  font-size: 11px;
  color: var(--ct-text-muted);
  padding: 1px 6px;
  background: var(--ct-bg-secondary);
  border-radius: 4px;
}

.quadrant-empty {
  color: var(--ct-text-muted);
  font-size: 13px;
  text-align: center;
  margin: 8px 0 0;
}

.quadrant-consensus { border-left: 3px solid #10b981; }
.quadrant-disagreements { border-left: 3px solid #f59e0b; }
.quadrant-risks { border-left: 3px solid #ef4444; }
.quadrant-assumptions { border-left: 3px solid #3b82f6; }

.decision-report-nextsteps {
  margin-top: 14px;
  padding: 10px 14px;
  background: var(--ct-bg);
  border-radius: 8px;
  border: 1px solid var(--ct-border);
}

.decision-report-nextsteps h4 {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--ct-accent);
}

.decision-report-nextsteps ol {
  margin: 0;
  padding-left: 22px;
}

.decision-report-nextsteps li {
  margin-bottom: 4px;
  font-size: 13px;
  color: var(--ct-text-primary);
  line-height: 1.5;
}

/* ============ 会话内附件 ============ */

.session-attachment-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 0 2px;
}

.session-att-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 14px;
  background: var(--ct-bg-tertiary, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--ct-border, rgba(255, 255, 255, 0.08));
  font-size: 12px;
  color: var(--ct-text-secondary, #9ca3af);
  max-width: 220px;
}

.session-att-chip-icon {
  font-size: 13px;
  flex-shrink: 0;
}

.session-att-chip-thumb {
  width: 20px;
  height: 20px;
  object-fit: cover;
  border-radius: 3px;
  flex-shrink: 0;
  border: 1px solid var(--ct-border, #374151);
}

.session-att-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 140px;
  color: var(--ct-text-primary, #e5e7eb);
}

.session-att-chip-size {
  font-size: 11px;
  color: var(--ct-text-muted, #6b7280);
  flex-shrink: 0;
}

.session-att-chip-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border: none;
  background: transparent;
  color: var(--ct-text-muted, #6b7280);
  cursor: pointer;
  border-radius: 50%;
  font-size: 13px;
  line-height: 1;
  padding: 0;
  flex-shrink: 0;
  transition: all 0.15s;
}

.session-att-chip-remove:hover {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
}

/* 拖拽状态 */
.chat-input-container.drag-over {
  border-color: var(--ct-accent) !important;
  box-shadow: 0 0 0 2px rgba(212, 175, 55, 0.25);
}

.drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  border-radius: 8px;
  backdrop-filter: blur(2px);
  pointer-events: none;
  animation: fadeIn 0.15s ease;
}

.drop-overlay-content {
  font-size: 14px;
  font-weight: 600;
  color: var(--ct-accent);
  padding: 8px 20px;
  border: 2px dashed var(--ct-accent);
  border-radius: 10px;
  background: rgba(212, 175, 55, 0.08);
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
