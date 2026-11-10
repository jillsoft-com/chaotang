<script setup lang="ts">
import { appStorage } from '@/services/storage'
import { ref, nextTick, computed, onMounted, onUnmounted, watch } from 'vue'
import type { Directive } from 'vue'
import { useDebateStore } from '@/stores/debate'
import { createProvider } from '@/services/llm'
import { llmService } from '@/services/llm-config'
import { Promotion, User, FolderOpened, Loading, CircleCloseFilled, Stamp, Download, CircleCheck, CircleClose, ArrowDown } from '@element-plus/icons-vue'
import { ElMessageBox, ElMessage } from 'element-plus'
import { renderSafeMarkdown } from '@/utils/sanitize-markdown'
import { estimateTokens } from '@/utils/token-utils'
import { exportDebateToMarkdown } from '@/utils/export-markdown'
import type { Speech, LLMConfig, ToolCall, Attachment, ExecSegment } from '@/types'
import { CoordinatorAgent } from '@/services/agent'
import { taskScheduler } from '@/services/agent'
import { compressContext, getCompressThreshold, countMessageChars } from '@/services/agent/context-compressor'
import { memoryStore } from '@/services/memory'
import { skillRegistry, selectToolsForTopic, estimateToolTokens } from '@/services/skills'
import { toolExecutor } from '@/services/tools/executor'
import { getProjectIndex, generateContextHint } from '@/services/agent/repository-context'
import { mcpService } from '@/services/mcp'
import { runAcceptance, collectChangedFiles } from '@/services/agent/acceptance-gate'
import type { CommandExecutor } from '@/services/agent/acceptance-gate'
import { buildDeliveryReport } from '@/services/agent/delivery-report'
import type { DeliveryReport, FileChange } from '@/services/agent/delivery-report'
import { writeTaskDoc } from '@/services/agent/task-doc'
import { getMaxToolRounds } from '@/services/agent/round-budget'
import DeliveryPanel from '@/components/DeliveryPanel.vue'

// ============ 命令免确认策略 ============
// 产品决策：工具调用与本地命令执行不再弹出任何人工确认对话框。
// 安全边界仍由主进程 resolveAuthorizedPath 约束（命令与文件操作限定在已授权工作目录内）。
// 如需恢复人工确认：恢复 electron/main.cjs 中 approveCommand 的 dialog.showMessageBox 分支，
// 并在下方 onBeforeToolExecute 处恢复 ElMessageBox 确认逻辑。

const props = defineProps<{ sessionId: string }>()

const emit = defineEmits<{
  (e: 'open-task-tree-panel'): void
}>()

const debateStore = useDebateStore()
const speechesContainer = ref<HTMLElement | null>(null)
const isDebating = ref(false)
const userInput = ref('')
const courtInput = ref('')
const isSending = ref(false)
const hasStartedCourt = ref(false)

// P1-B: 交付审阅面板的展开状态（报告本体见下方 deliveryReport，随会话持久化）
const deliveryReportVisible = ref(false)

// 决策报告折叠状态（默认折叠，避免充满会话区遮挡输入）
const decisionReportExpanded = ref(false)

// 决策报告暂时停用（当前价值不大）。如需恢复：置为 true，并在 debate store 的 completeDebate 里重新开启自动生成
const enableDecisionReport = false

// 任务树刷新计数器已上提至 debate store（taskTreeTick），供右侧面板共享

// Phase 1: Plan Mode 审阅面板
const planReviewData = ref<{ plan: { plan: string; tasks: any[] }; workers: any[]; resolve: (result: any) => void } | null>(null)

/** Phase 1: 创建 Plan Mode 回调 — 弹出可视化编辑面板，返回用户修改后的计划或 null */
function createPlanReviewCallback(workers: any[]) {
  return async (plan: any): Promise<any> => {
    return new Promise((resolve) => {
      // 持久化待批准计划：离开/重进会话后可恢复审阅面板，避免卡在 PM 拆解后无后续
      if (session.value) session.value.pendingPlan = plan
      planReviewData.value = { plan, workers, resolve }
    })
  }
}

/** Phase 1: 用户批准计划 */
function handlePlanApprove(editedPlan: any) {
  if (planReviewData.value) {
    const resolve = planReviewData.value.resolve
    planReviewData.value = null
    if (session.value) session.value.pendingPlan = undefined
    resolve(editedPlan)
  }
}

/** Phase 1: 用户取消计划 */
function handlePlanCancel() {
  if (planReviewData.value) {
    const resolve = planReviewData.value.resolve
    planReviewData.value = null
    if (session.value) session.value.pendingPlan = undefined
    resolve(null)
  }
}

// 判断当前发言是否为“待批准的丞相拆解发言”：确认/取消条内联在该气泡底部
function isPendingPlanSpeech(speech: Speech): boolean {
  if (!planReviewData.value || !session.value) return false
  if (speech.ministerId !== 'chancellor' || !speech.id.startsWith('chancellor-plan-')) return false
  const s = session.value.speeches
  return s.length > 0 && s[s.length - 1].id === speech.id
}

/** Phase 1: 直接采用丞相已拆解的原计划批准执行（不做编辑） */
function approveCurrentPlan() {
  if (planReviewData.value) handlePlanApprove(planReviewData.value.plan)
}

/** Agent 模式：计算与 runAgentDebate 一致的 workers 列表（丞相以外的执行者，无则丞相兼任） */
function resolveAgentWorkers(): any[] | null {
  const s = session.value
  if (!s) return null
  const allMinisters = debateStore.sortedMinisters
  const mentioned = s.mentionedMinisters
  const ministers = mentioned && mentioned.length > 0
    ? allMinisters.filter(m => mentioned.includes(m.id))
    : allMinisters
  const chancellor = ministers.find(m => m.id === 'chancellor')
  if (!chancellor) return null
  const execMinisters = ministers.filter(m => m.id !== 'chancellor')
  return execMinisters.length > 0 ? execMinisters : [chancellor]
}

/**
 * 恢复场景：进入会话时，若存在 PM 已拆解但未批准的计划（pendingPlan）且尚未建树，
 * 则重建「执行计划审阅」面板。批准后复用已存计划直接建树执行（不重复调 LLM）。
 */
function tryResumePendingPlan() {
  if (planReviewData.value) return
  const s = session.value
  if (!s || s.mode !== 'court' || s.status !== 'running') return
  if (!s.pendingPlan || s.taskTreeSnapshot) return
  const workers = resolveAgentWorkers()
  if (!workers) return
  planReviewData.value = {
    plan: s.pendingPlan,
    workers,
    resolve: (editedPlan: any) => {
      // handlePlanApprove/Cancel 已清理 pendingPlan；此处仅触发后续动作
      if (!editedPlan) {
        debateStore.completeDebate(undefined, true)
        return
      }
      void runAgentDebate({ approvedPlan: editedPlan })
    }
  }
}

/**
 * 进入会话时的统一恢复入口：
 * 1) 若持久化了 pendingPlan → 直接用已存计划重建审阅面板（不重新拆解）；
 * 2) 否则识别“卡在丞相拆解发言、既未建树也未开始执行”的 Agent 会话（典型为持久化机制上线前的旧会话），
 *    自动重新触发一次拆解，把审阅面板恢复回来（会多一次 LLM 拆解，但可解锁流程）。
 */
function resumeStuckAgentPlan() {
  if (planReviewData.value) return
  const s = session.value
  if (!s || s.mode !== 'court' || s.status !== 'running') return
  // 已在执行/已建树的交给中断任务树恢复机制处理
  if (s.taskTreeSnapshot) return
  // 优先用持久化计划恢复
  if (s.pendingPlan) {
    tryResumePendingPlan()
    return
  }
  // 特征：最后一条发言是丞相已完成的拆解发言（chancellor-plan-*），之后无任何执行发言
  const last = s.speeches[s.speeches.length - 1]
  const pausedAtPlan = !!last && last.ministerId === 'chancellor' && last.id.startsWith('chancellor-plan-') && last.status === 'completed'
  if (!pausedAtPlan) return
  if (!resolveAgentWorkers()) return
  // 移除旧的卡住拆解发言，避免重跑后重复
  while (s.speeches.length && s.speeches[s.speeches.length - 1].id.startsWith('chancellor-plan-')) {
    s.speeches.pop()
  }
  hasStartedCourt.value = true
  isDebating.value = true
  runAgentDebate().finally(() => { isDebating.value = false })
}

/** P1-B: 撤销交付 — 尝试恢复文件到修改前状态 */
async function handleDeliveryRevert() {
  if (!deliveryReport.value) return
  const report = deliveryReport.value
  let reverted = 0
  let failed = 0
  let conflicts = 0
  let skipped = 0
  for (const file of report.changedFiles) {
    // P0-fix: 缺失原始内容的文件无法安全撤销
    if (file.revertDisabled) {
      skipped++
      continue
    }
    if (!window.electronAPI?.readFile || !window.electronAPI?.revertFile) {
      failed++
      continue
    }
    try {
      // P0-fix: 先读取当前文件内容与哈希，校验是否与交付时一致
      const currentRead = await window.electronAPI.readFile(file.path)
      if (!currentRead.success) {
        // 文件不存在：如果是新建的文件，无需撤销
        if (file.status === 'created') {
          reverted++
          continue
        }
        failed++
        continue
      }

      // P1-fix: 使用原子撤销 API（带版本校验，防止覆盖窗口）
      // 先检查当前内容是否与交付时的 newContent 一致
      const currentContent = currentRead.content || ''
      const expectedNewContent = file.newContent || ''
      if (currentContent !== expectedNewContent) {
        // 文件已被外部修改，撤销会覆盖用户后续修改
        conflicts++
        continue
      }

      // 新建文件无法撤销（没有 deleteFile API）
      if (file.status === 'created') {
        conflicts++ // 计入冲突，提示用户手动处理
        continue
      }

      // P1-fix: 使用原子撤销 API，传入当前文件的 SHA-256 作为版本校验
      if (file.oldContent !== undefined && currentRead.sha256) {
        const result = await window.electronAPI.revertFile(file.path, file.oldContent, currentRead.sha256)
        if (result?.success) {
          reverted++
        } else if (result?.errorCode === 'VERSION_MISMATCH' || result?.errorCode === 'VERSION_MISMATCH_AFTER_APPROVAL') {
          // 审批期间文件被修改，算作冲突
          conflicts++
        } else {
          failed++
        }
      } else {
        failed++
      }
    } catch {
      failed++
    }
  }

  const messages: string[] = []
  if (reverted > 0) messages.push(`${reverted} 个文件已撤销`)
  if (conflicts > 0) messages.push(`${conflicts} 个文件已被后续修改或为新建文件，已跳过`)
  if (skipped > 0) messages.push(`${skipped} 个文件缺少原始内容，无法撤销`)
  if (failed > 0) messages.push(`${failed} 个文件撤销失败`)

  if (failed === 0 && conflicts === 0 && skipped === 0) {
    ElMessage.success(`已撤销 ${reverted} 个文件的改动`)
  } else if (failed === 0) {
    ElMessage.warning(messages.join('，'))
  } else {
    ElMessage.error(messages.join('，'))
  }
  // 撤销完成后这批改动已回到撤销前，报告不再成立：清除持久化记录并收起
  deliveryReport.value = null
  deliveryReportVisible.value = false
}

// 消息字体大小（从 localStorage 读取，在设置页面中调节）
const messageFontSize = ref(parseInt(appStorage.getItem('message_font_size') || '15', 10))

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

// ============ 导出事件日志 ============

/** 导出当前会话的任务树事件日志 */
async function exportEventLog() {
  if (!session.value) return
  const snapshot = session.value.taskTreeSnapshot
  if (!snapshot) {
    ElMessage.warning('该会话没有任务树记录')
    return
  }

  const runId = snapshot.runId
  const md = taskScheduler.exportEventLog(runId, 'markdown')
  const fileName = `event-log-${session.value.topic?.slice(0, 20) || runId}.md`

  if (window.electronAPI?.showSaveDialog) {
    try {
      const result = await window.electronAPI.showSaveDialog({
        title: '导出事件日志',
        defaultPath: fileName,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (!result.canceled && result.filePath) {
        const writeResult = await window.electronAPI.writeFile(result.filePath, md)
        if (writeResult?.success) {
          ElMessage.success('事件日志已导出')
        } else {
          ElMessage.error('导出失败：' + (writeResult?.error || '未知错误'))
        }
      }
    } catch (err) {
      ElMessage.error('导出失败')
    }
  } else {
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

// ============ 圣谕（自己发的内容）超长折叠 ============
// 皇帝消息文本超过阈值时默认折叠，点击「展开全文」展开
const EMPEROR_COLLAPSE_THRESHOLD = 160
const expandedEmperorMsgs = ref<Set<string>>(new Set())

function shouldCollapseEmperor(speech: Speech): boolean {
  return speech.ministerId === 'emperor' && (speech.content || '').length > EMPEROR_COLLAPSE_THRESHOLD
}

function isEmperorExpanded(speechId: string): boolean {
  return expandedEmperorMsgs.value.has(speechId)
}

function toggleEmperorExpand(speechId: string) {
  const s = new Set(expandedEmperorMsgs.value)
  if (s.has(speechId)) {
    s.delete(speechId)
  } else {
    s.add(speechId)
  }
  expandedEmperorMsgs.value = s
}

// ============ Agent 模式 worker 执行折叠 + 右侧详情抽屉 ============
// coordinator 生成的 worker 执行发言 id 形如 `${workerId}-tree|agent|decompose-<ts>`，
// 多角色并发执行时把会话区收敛为一条状态条，详情（实时内容/工具调用/diff）点击后在右侧抽屉查看，
// 避免会话区内容不断膨胀。串行/并行/丞相规划与汇总发言不受影响。
const WORKER_EXEC_ID_RE = /-(?:tree|agent|decompose)-\d/
const activeDetailSpeechId = ref<string | null>(null)

function isWorkerExecutionSpeech(speech: Speech): boolean {
  return speech.ministerId !== 'emperor' && WORKER_EXEC_ID_RE.test(speech.id)
}

const activeDetailSpeech = computed<Speech | null>(() => {
  if (!activeDetailSpeechId.value || !session.value) return null
  return session.value.speeches.find(s => s.id === activeDetailSpeechId.value) || null
})

// el-drawer 需要布尔 v-model：有选中发言即打开，关闭时清理选中
const execDetailVisible = computed<boolean>({
  get: () => !!activeDetailSpeechId.value,
  set: (v) => { if (!v) activeDetailSpeechId.value = null }
})

function openExecDetail(speechId: string) {
  activeDetailSpeechId.value = speechId
}

// 执行详情抽屉内仍可用工具调用摘要定位最新动态

// ============ Agent 执行过程时间线（扁平步骤列表 + 整块折叠） ============
// 对齐主流 Agent 界面的执行过程样式：一行一个步骤（状态图标 + 动作名 + 一句话摘要），
// 点击行展开看命令行/入参与返回内容；标题行显示累计耗时，可整体折叠。
const expandedExecSegs = ref<Set<string>>(new Set())
/** 用户手动切换过的折叠状态：speechId -> 是否折叠；未记录时走默认策略 */
const execFoldState = ref<Map<string, boolean>>(new Map())

/** 默认：执行中展开便于看进度，执行完成后收起保持会话区紧凑 */
function isExecBlockCollapsed(speech: Speech): boolean {
  const override = execFoldState.value.get(speech.id)
  if (override !== undefined) return override
  return speech.status !== 'streaming'
}

function toggleExecBlock(speech: Speech) {
  const m = new Map(execFoldState.value)
  m.set(speech.id, !isExecBlockCollapsed(speech))
  execFoldState.value = m
}

function toggleExecSeg(key: string) {
  const s = new Set(expandedExecSegs.value)
  if (s.has(key)) {
    s.delete(key)
  } else {
    s.add(key)
  }
  expandedExecSegs.value = s
}

/**
 * 步骤列表限高内部滚动时自动贴住最新一步：
 * 首次挂载滚到底部，之后仅当视图本来就在底部附近时才跟随新步骤下滚，
 * 用户主动上滑查历史时不被强行拉回
 */
const vAutoScrollBottom: Directive<HTMLElement> = {
  mounted(el) {
    el.scrollTop = el.scrollHeight
  },
  updated(el) {
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (nearBottom) el.scrollTop = el.scrollHeight
  }
}

/** 执行耗时秒表：仅当存在 streaming 的 worker 执行发言时每秒刷新，避免无谓重渲染 */
const execNow = ref(Date.now())
let execTimer: ReturnType<typeof setInterval> | null = null

function syncExecTimer() {
  const needTick = !!session.value?.speeches.some(s => s.status === 'streaming' && isWorkerExecutionSpeech(s))
  if (needTick && !execTimer) {
    execNow.value = Date.now()
    execTimer = setInterval(() => { execNow.value = Date.now() }, 1000)
  } else if (!needTick && execTimer) {
    stopExecTimer()
  }
}

function stopExecTimer() {
  if (execTimer) {
    clearInterval(execTimer)
    execTimer = null
  }
}

function execElapsedMs(speech: Speech): number {
  if (speech.status === 'streaming') return Math.max(0, execNow.value - (speech.timestamp || execNow.value))
  return speech.durationMs ?? 0
}

/** 耗时文案：1 分钟内显示秒，超过显示分秒；历史会话无 durationMs 时不显示 */
function execElapsedText(speech: Speech): string {
  const ms = execElapsedMs(speech)
  if (ms <= 0) return ''
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`
}

function execHeaderLabel(speech: Speech): string {
  if (speech.status === 'streaming') return '正在执行中'
  if (speech.status === 'error') return '执行失败'
  return '执行完成'
}

/** 命令/检索类工具完成后措辞用“已运行”，其余用“已完成” */
const RUN_VERB_TOOLS = new Set([
  'execute_command', 'run_tests', 'git_operation', 'git_auto_commit', 'git_create_branch',
  'git_diff_summary', 'search_code', 'web_search', 'knowledge_query', 'search_memory'
])

type ExecRowState = 'ok' | 'run' | 'fail'

function execRowState(seg: ExecSegment, speech: Speech): ExecRowState {
  // 发言已收尾（完成或失败）却仍有未落定的段：说明这一轮是被异常打断的（如 API 502 直接抛错，
  // 没人替它调 endThink / finishTool）。此时不得再挂转圈标签，
  // 否则气泡中途会永远留一个假的“踌躇中…”，看起来像卡住且位置不在底部
  const settled = speech.status !== 'streaming'
  if (seg.type === 'think') return seg.done || settled ? 'ok' : 'run'
  if (seg.status === 'completed') return 'ok'
  if (seg.status === 'executing') return settled ? 'fail' : 'run'
  return 'fail'
}

/**
 * 思考中的轮换措辞：长时间执行时文案一直挂“思考中”看起来像卡住了，
 * 按执行耗时定时往下换（从平静到绞尽脑汁），首个固定为「思考中」
 */
const THINK_WORDS = [
  '思考中', '思忖中', '沉吟中', '斟酌中', '踌躇中', '揣摩中',
  '寻思中', '权衡中', '三思中', '苦思冥想中', '冥思苦想中',
  '绞尽脑汁中', '搜肠刮肚中', '左思右想中', '眉头紧锁中'
]

/** 每个措辞停留时长，一轮循环约 45 秒 */
const THINK_ROTATE_MS = 3000

/** 思考段 id 形如 think-<起始毫秒>-<序号>（见 exec-timeline.nextSegId），据此还原本轮思考的开始时刻 */
function thinkStartedAtMs(seg: ExecSegment): number {
  const m = /^think-(\d+)-/.exec(seg.id)
  const ms = m ? Number(m[1]) : NaN
  return Number.isFinite(ms) ? ms : 0
}

function execRowLabel(seg: ExecSegment, speech: Speech): string {
  if (seg.type !== 'think') return seg.displayName
  if (seg.done || speech.status !== 'streaming') return '已思考'
  // 每轮思考都从「思考中」起跳，拖得越久措辞越吃力；id 解析不出时退回整段执行耗时
  const started = thinkStartedAtMs(seg)
  const elapsed = started ? Math.max(0, execNow.value - started) : execElapsedMs(speech)
  return `${THINK_WORDS[Math.floor(elapsed / THINK_ROTATE_MS) % THINK_WORDS.length]}…`
}

/** 行内状态后缀：思考行不显示（标签本身已含状态），工具行显示 已运行/已完成/运行中/失败 */
function execRowStateText(seg: ExecSegment, speech: Speech): string {
  if (seg.type === 'think') return ''
  if (seg.status === 'completed') return RUN_VERB_TOOLS.has(seg.functionName) ? '已运行' : '已完成'
  if (seg.status === 'executing') return speech.status === 'streaming' ? '运行中' : '失败'
  return seg.status === 'timeout' ? '超时' : '失败'
}

/** 错误正文常内嵌整页 HTML（502 网关页等），摘要里先剥掉标签，否则只剩一串尖括号 */
function stripHtmlTags(text: string): string {
  return (text || '').replace(/<[^>]*>/g, ' ')
}

function resultPreview(speech: Speech): string {
  const raw = speech.status === 'error' ? stripHtmlTags(speech.content || '') : (speech.content || '')
  return clipLine(raw)
}

function clipLine(text: string, max = 120): string {
  const t = (text || '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 摘要优先取“做了什么”的关键入参（命令行、路径、查询词），其次取返回首行 */
const ARG_HINT_KEYS = ['command', 'path', 'file_path', 'directory', 'query', 'pattern', 'url', 'message', 'goal']

function extractArgHint(input?: string): string {
  if (!input) return ''
  let args: Record<string, any>
  try {
    args = JSON.parse(input)
  } catch {
    return clipLine(input)
  }
  if (!args || typeof args !== 'object') return ''
  for (const key of ARG_HINT_KEYS) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) return clipLine(v)
  }
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.trim()) return clipLine(v)
  }
  return ''
}

function execRowPreview(seg: ExecSegment): string {
  if (seg.type === 'think') return clipLine(seg.text)
  return extractArgHint(seg.input) || clipLine((seg.output || '').split('\n').find(l => l.trim()) || '')
}

/**
 * 当前正在执行的一步（未完成的思考行 / 正在执行的工具行）
 * 与已完成步骤严格分开：单独常驻在滚动列表之外，不折叠也不会被滚动条滚走
 */
function execLiveSeg(speech: Speech): ExecSegment | null {
  if (speech.status !== 'streaming') return null
  const timeline = speech.execTimeline || []
  const last = timeline[timeline.length - 1]
  if (!last) return null
  if (last.type === 'think' && !last.done) return last
  if (last.type === 'tool' && last.status === 'executing') return last
  return null
}

/** 常驻行以「零或一个元素」返回，便于模板 v-for 内局部绑定当前步 */
function execLiveSegs(speech: Speech): ExecSegment[] {
  const live = execLiveSeg(speech)
  return live ? [live] : []
}

/** 滚动列表只渲染已完成的历史步骤，当前步不混在里面 */
function execHistorySegs(speech: Speech): ExecSegment[] {
  const timeline = speech.execTimeline || []
  const live = execLiveSeg(speech)
  return live ? timeline.filter(s => s.id !== live.id) : timeline
}

/**
 * 详情抽屉按真实发生顺序逐条列出：思考段标上轮次序号，工具段保持原样。
 * 每轮思考各自成条，因此不会被下一轮的流式文本覆盖掉，事后可逐轮回看。
 */
function detailTimeline(speech: Speech): Array<{ seg: ExecSegment; roundNo?: number }> {
  const rows: Array<{ seg: ExecSegment; roundNo?: number }> = []
  let roundNo = 0
  for (const seg of speech.execTimeline || []) {
    if (seg.type === 'think') {
      roundNo++
      rows.push({ seg, roundNo })
    } else {
      rows.push({ seg })
    }
  }
  return rows
}

/** 抽屉内的行标签：思考行按轮次编号，最新一轮仍在流式输出时沿用轮换措辞 */
function detailRowLabel(seg: ExecSegment, speech: Speech, roundNo?: number): string {
  if (seg.type !== 'think') return seg.displayName
  if (!seg.done && speech.status === 'streaming') return execRowLabel(seg, speech)
  return `第 ${roundNo} 轮思考`
}

/** 抽屉行类型：思考行、单个执行步、被合并的连续执行步组头 */
type DetailRowKind = 'think' | 'tool' | 'group'

interface DetailFlatRow {
  key: string
  kind: DetailRowKind
  seg: ExecSegment | null
  depth: number
  label: string
  icon: ExecRowState
  stateText: string
  preview: string
  /** 执行步的文件变更（提取到行上，便于模板里按属性路径收窄，不必在模板里解包 seg） */
  diffData?: { filePath: string; oldContent: string; newContent: string; isNew: boolean }
  diffKey?: string
  /** 组内含当前实时步：未被手动折叠过默认展开，该轮结束后自动收回 */
  groupLive?: boolean
  groupOpen?: boolean
}

/** 用户对合并组的展开/收起选择；未记录过的组走默认策略 */
const detailFoldState = ref<Map<string, boolean>>(new Map())

function isDetailGroupOpen(key: string, live: boolean): boolean {
  const override = detailFoldState.value.get(key)
  return override === undefined ? live : override
}

function toggleDetailGroup(key: string, live: boolean) {
  const m = new Map(detailFoldState.value)
  m.set(key, !isDetailGroupOpen(key, live))
  detailFoldState.value = m
}

function onDetailRowClick(row: DetailFlatRow) {
  if (row.kind === 'group') toggleDetailGroup(row.key, !!row.groupLive)
  else toggleExecSeg(row.key)
}

/** ExecSegment 为判别联合，取工具分支字段前先收窄 */
type ToolSeg = Extract<ExecSegment, { type: 'tool' }>

function asToolSeg(seg: ExecSegment): ToolSeg {
  return seg as ToolSeg
}

/** 行数据上的 seg 只对思考/执行行存在；按分支拆成两个窄接口，免得在模板里做类型收窄 */
function rowThinkText(row: DetailFlatRow): string {
  const seg = row.seg
  return seg && seg.type === 'think' ? seg.text : ''
}

function rowTool(row: DetailFlatRow): ToolSeg {
  return row.seg as ToolSeg
}

/** 组内摘要：按出现顺序去重工具名，最多列三个 */
function groupToolSummary(segs: ToolSeg[]): string {
  const names: string[] = []
  for (const s of segs) {
    if (!names.includes(s.displayName)) names.push(s.displayName)
    if (names.length >= 3) break
  }
  return names.join('、') + (segs.length > names.length ? ' 等' : '')
}

function groupIconState(segs: ExecSegment[], speech: Speech): ExecRowState {
  const states = segs.map(s => execRowState(s, speech))
  if (states.includes('run')) return 'run'
  if (states.includes('fail')) return 'fail'
  return 'ok'
}

/** 执行过程抬头概览：直接给出“几轮思考、几次执行”的节奏 */
function detailHeadSummary(speech: Speech): string {
  const segs = speech.execTimeline || []
  const thinks = segs.filter(s => s.type === 'think').length
  return `${thinks} 轮思考 · ${segs.length - thinks} 次执行`
}

/**
 * 抽屉行序列：思考逐条保留，连续的“执行命令 / 代码搜索”这类工具步合并成一行「执行 N 步」，
 * 得到 思考 → 执行 → 思考 → 执行 的节奏。只有一步时不套壳，少一层点击。
 */
function detailRows(speech: Speech): DetailFlatRow[] {
  const timeline = speech.execTimeline || []
  const liveId = execLiveSeg(speech)?.id
  const rows: DetailFlatRow[] = []
  let roundNo = 0

  for (let i = 0; i < timeline.length; i++) {
    const seg = timeline[i]
    if (seg.type === 'think') {
      roundNo++
      rows.push({
        key: seg.id,
        kind: 'think',
        seg,
        depth: 0,
        label: detailRowLabel(seg, speech, roundNo),
        icon: execRowState(seg, speech),
        stateText: '',
        preview: clipLine(seg.text)
      })
      continue
    }

    const runs: ToolSeg[] = [asToolSeg(seg)]
    while (i + 1 < timeline.length && timeline[i + 1].type === 'tool') {
      runs.push(asToolSeg(timeline[++i]))
    }

    if (runs.length === 1) {
      rows.push({
        key: seg.id,
        kind: 'tool',
        seg,
        depth: 0,
        label: seg.displayName,
        icon: execRowState(seg, speech),
        stateText: execRowStateText(seg, speech),
        preview: execRowPreview(seg),
        diffData: seg.diffData,
        diffKey: seg.toolCallId || seg.id
      })
      continue
    }

    const key = `acts:${runs[0].id}`
    const groupLive = runs.some(s => s.id === liveId)
    const groupOpen = isDetailGroupOpen(key, groupLive)
    rows.push({
      key,
      kind: 'group',
      seg: null,
      depth: 0,
      label: `执行 ${runs.length} 步`,
      icon: groupIconState(runs, speech),
      stateText: '',
      preview: groupToolSummary(runs),
      groupLive,
      groupOpen
    })
    if (!groupOpen) continue

    for (const s of runs) {
      rows.push({
        key: s.id,
        kind: 'tool',
        seg: s,
        depth: 1,
        label: s.displayName,
        icon: execRowState(s, speech),
        stateText: execRowStateText(s, speech),
        preview: execRowPreview(s),
        diffData: s.diffData,
        diffKey: s.toolCallId || s.id
      })
    }
  }

  return rows
}

/** 工具入参展示：execute_command 直接显示命令行，其余显示格式化 JSON */
function formatToolInput(seg: ExecSegment): string {
  if (seg.type !== 'tool') return ''
  try {
    const args = JSON.parse(seg.input || '{}')
    if (seg.functionName === 'execute_command' && typeof args.command === 'string') {
      return `$ ${args.command}`
    }
    return JSON.stringify(args, null, 2)
  } catch {
    // 参数被截断导致解析失败时，直接展示原文
    return seg.input || ''
  }
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
    ElMessage.success('已复制到剪贴板')
  } catch {
    ElMessage.warning('复制失败，请手动选择复制')
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
  const summaryId = appStorage.getItem('summary_model_id')
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

/**
 * P1-B: 交付报告 — 读写都落到会话对象上，由 store 同步到历史归档。
 *
 * 以前是组件内的一次性 ref：点“确认交付”或切换标签页（ChatSession 按 sessionId 重建）
 * 就永久丢失，现在随会话持久化，任何时候都能回到“交付审阅”面板重看成果。
 */
const deliveryReport = computed<DeliveryReport | null>({
  get: () => (session.value?.deliveryReport as DeliveryReport) || null,
  set: (report) => {
    if (!session.value) return
    debateStore.saveDeliveryReport(session.value.id, report)
    if (!report) session.value.deliveryConfirmedAt = undefined
  }
})

const deliveryStateLabel = computed(() => {
  switch (deliveryReport.value?.acceptanceState) {
    case 'passed': return '验收通过'
    case 'failed': return '验收未通过'
    case 'unverified': return '未验证'
    default: return '验收待定'
  }
})

/** 确认交付：保留报告与成果记录，只收起面板并打上已确认标记 */
function handleDeliveryConfirm() {
  if (session.value) debateStore.markDeliveryConfirmed(session.value.id)
  deliveryReportVisible.value = false
}

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

/**
 * 进入会话/开始执行时，用会话持久化的工作目录重新授权主进程。
 * 主进程的目录授权（authorizedRoots）是内存态，按 webContents.id 存储，
 * 应用重启或渲染进程重载后会丢失，而会话里的 workingDirectory 字符串仍持久化。
 * 不重新授权会导致大臣执行文件工具时报“请先在首页选择工作目录”。
 */
async function ensureWorkspaceAuthorized() {
  const dir = session.value?.workingDirectory
  if (!dir) return
  if (!window.electronAPI?.authorizeWorkspace) return
  try {
    const res = await window.electronAPI.authorizeWorkspace(dir)
    if (!res?.success) {
      console.warn('[Workspace] 工作目录授权失败:', res?.error)
    }
  } catch { /* 忽略：后续工具调用会给出明确错误 */ }
}

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
  // 用会话持久化的工作目录重新授权主进程（重启/重载后授权会丢失）
  void ensureWorkspaceAuthorized()
  // Agent 模式：重进会话时恢复未批准的执行计划审阅面板（含旧会话兼容）
  resumeStuckAgentPlan()
  // 监听用户手动滚动
  speechesContainer.value?.addEventListener('scroll', checkScrollPosition, { passive: true })
  // Ctrl+F 打开搜索
  window.addEventListener('keydown', handleGlobalKeydown)
  // 粘贴图片
  window.addEventListener('paste', handlePaste)
  // 执行过程耗时秒表：仅在有 worker 执行发言 streaming 时走秒
  syncExecTimer()
  watch(() => session.value?.speeches.map(s => s.status).join(','), syncExecTimer)
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
  stopExecTimer()
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

  // P1-fix: 每次执行开始时清空旧的交付报告，避免失败轮次展示上次报告
  deliveryReport.value = null
  deliveryReportVisible.value = false

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

  // 动态工具选择：根据议题智能筛选相关工具（避免全量发送导致上下文过长）
  const maxTools = parseInt(appStorage.getItem('max_tools_per_turn') || '12', 10)
  const toolDefs = await selectToolsForTopic(ministerId, userMessage, maxTools)
  console.log(`[runMinisterTurn] 工具选择: ${toolDefs.length} 个 (上限 ${maxTools})，约 ${estimateToolTokens(toolDefs)} tokens`)
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

  // 工具调用轮次上限：取设置项（默认 500），触顶后只要求总结，不再因小额度截断任务
  const MAX_ROUNDS = getMaxToolRounds()
  let finalContent = ''
  let accumulatedContent = ''
  const allToolCallResults: Array<{ functionName: string; status: string; arguments?: Record<string, any> }> = []

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

      // 命令免确认：危险命令不再弹出人工确认框，直接执行

      // Diff 预览：write_file / search_replace 执行前读取旧内容
      let preWriteOldContent: string | null = null
      let preWriteFilePath = ''
      if (tc.function.name === 'write_file' || tc.function.name === 'search_replace') {
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

      // 跟踪工具调用结果（用于验收）
      try {
        allToolCallResults.push({
          functionName: tc.function.name,
          status: result.status,
          arguments: JSON.parse(tc.function.arguments)
        })
      } catch {
        allToolCallResults.push({ functionName: tc.function.name, status: result.status })
      }

      // Diff 预览：write_file 执行后捕获 diff 数据
      const statusEntry = reactiveSpeech.toolStatuses.find(s => s.toolCallId === tc.id)
      if (statusEntry) {
        statusEntry.status = result.status === 'success' ? 'completed' : 'error'
        statusEntry.summary = typeof result.result === 'string'
          ? result.result.slice(0, 60)
          : result.error || ''

        // 如果是 write_file / search_replace 且执行成功，附加 diff 数据
        if ((tc.function.name === 'write_file' || tc.function.name === 'search_replace') && result.status === 'success') {
          try {
            const args = JSON.parse(tc.function.arguments)
            let newContent = args.content || ''
            // search_replace: 读取写入后的文件内容
            if (tc.function.name === 'search_replace' && window.electronAPI?.readFile) {
              const postRead = await window.electronAPI.readFile(args.path || '')
              if (postRead.success) newContent = postRead.content || ''
            }
            statusEntry.diffData = {
              filePath: args.path || '',
              oldContent: preWriteOldContent || '',
              newContent,
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
        if (!summaryProvider) {
          // 无摘要模型但上下文超限 → 终止大臣进言
          throw new Error('上下文已超模型容量但未配置摘要模型，无法压缩。建议开启新会话。')
        }
        console.log(`[runMinisterTurn] 上下文超过阈值 (${totalChars} > ${threshold})，开始压缩...`)
        let compressed
        try {
          compressed = await compressContext(messages as any, summaryProvider, threshold, undefined, topic, props.sessionId)
        } catch (e) {
          // 压缩过程出错 → 终止大臣进言（上下文已超限，不能继续）
          const errMsg = e instanceof Error ? e.message : String(e)
          throw new Error(`上下文压缩失败: ${errMsg}。上下文已超模型容量，建议开启新会话。`)
        }
        // safe 检查：不安全时抛错，向上传播终止大臣进言
        if (!compressed.safe) {
          throw new Error(compressed.warning || '上下文无法安全压缩，建议开启新会话')
        }
        // 替换 messages 数组内容
        messages.splice(0, messages.length, ...compressed.messages as any)
        console.log(`[runMinisterTurn] 压缩完成, 消息数: ${messages.length}, 字符: ${countMessageChars(messages as any)}`)
      }
    }

    // 最后一轮仍有工具调用，追加一条提示让模型总结
    if (round === MAX_ROUNDS - 1) {
      console.log('[runMinisterTurn] 达到最大轮次，要求模型总结...')

      // 先检查容量并压缩（不追加总结提示）
      const finalThreshold = getCompressThreshold()
      const finalTotalChars = countMessageChars(messages as any)
      if (finalTotalChars > finalThreshold) {
        const summaryProvider = getSummaryProvider()
        if (!summaryProvider) {
          throw new Error('最终总结前上下文已超模型容量但未配置摘要模型，无法压缩。建议开启新会话。')
        }
        console.log(`[runMinisterTurn] 最终总结前上下文超限 (${finalTotalChars} > ${finalThreshold})，尝试压缩...`)
        let compressed
        try {
          compressed = await compressContext(messages as any, summaryProvider, finalThreshold, undefined, topic, props.sessionId)
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e)
          throw new Error(`最终总结前上下文压缩失败: ${errMsg}。建议开启新会话。`)
        }
        if (!compressed.safe) {
          throw new Error(compressed.warning || '最终总结前上下文无法安全压缩，建议开启新会话')
        }
        messages.splice(0, messages.length, ...compressed.messages as any)
        console.log(`[runMinisterTurn] 最终总结前压缩完成`)
      }

      // 压缩后（或无需压缩）追加总结提示（只追加一次）
      messages.push({
        role: 'user',
        content: '请基于你已经收集到的所有信息，直接给出最终分析和回复，不要再调用工具。'
      })

      // 最终校验：追加提示后检查是否超限
      const afterAppendChars = countMessageChars(messages as any)
      if (afterAppendChars > finalThreshold) {
        console.warn(`[runMinisterTurn] 追加总结提示后超限 (${afterAppendChars} > ${finalThreshold})，尝试再次压缩...`)
        const summaryProvider = getSummaryProvider()
        if (!summaryProvider) {
          throw new Error('追加总结提示后上下文超限但未配置摘要模型，无法压缩。建议开启新会话。')
        }
        let compressed
        try {
          compressed = await compressContext(messages as any, summaryProvider, finalThreshold, undefined, topic, props.sessionId)
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e)
          throw new Error(`追加总结提示后压缩失败: ${errMsg}。建议开启新会话。`)
        }
        if (!compressed.safe) {
          throw new Error(compressed.warning || '追加总结提示后无法安全压缩，建议开启新会话')
        }
        // 压缩后重新追加总结提示（先检查压缩保留的最近消息中是否已包含）
        messages.splice(0, messages.length, ...compressed.messages as any)
        const SUMMARY_PROMPT = '请基于你已经收集到的所有信息，直接给出最终分析和回复，不要再调用工具。'
        const lastMsg = messages[messages.length - 1]
        if (!(lastMsg && lastMsg.role === 'user' && lastMsg.content === SUMMARY_PROMPT)) {
          messages.push({ role: 'user', content: SUMMARY_PROMPT })
        }
        // 再次校验
        const finalCheckChars = countMessageChars(messages as any)
        if (finalCheckChars > finalThreshold) {
          throw new Error(`追加总结提示后压缩仍超限 (${finalCheckChars} > ${finalThreshold})，建议开启新会话。`)
        }
      }

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

  // P0-B: 验收——工具循环结束后，若有文件改动则运行检查
  if (workingDir && allToolCallResults.length > 0) {
    const changedFiles = collectChangedFiles(allToolCallResults)
    if (changedFiles.length > 0) {
      const cmdExecutor: CommandExecutor = {
        execute: async (cmd: string, cwd?: string, timeoutMs?: number) => {
          if (window.electronAPI?.executeCommand) {
            const r = await window.electronAPI.executeCommand({
              command: cmd,
              cwd: cwd || workingDir,
              timeout: timeoutMs || 120000
            })
            return {
              exitCode: r.exitCode ?? (r.success ? 0 : 1),
              stdout: r.stdout || '',
              stderr: r.stderr || '',
              timedOut: r.timedOut || false
            }
          }
          return { exitCode: 1, stdout: '', stderr: '无命令执行能力', timedOut: false }
        }
      }
      try {
        const acceptance = await runAcceptance(workingDir, changedFiles, cmdExecutor)
        // 验收结果如实标注在回复里，但不再据此隐藏成果：
        // 未通过 / 未验证时用户同样需要知道这一次到底改了什么
        if (acceptance.overallState === 'failed') {
          const failedChecks = acceptance.checks.filter(c => c.status === 'failed')
          const diagnostics = failedChecks.map(c => `- [${c.kind}] ${c.command}: ${c.summary}`).join('\n')
          finalContent += `\n\n---\n❌ **验收检查未通过**\n\n${diagnostics}\n\n以上检查未通过，代码可能存在问题，请仔细检查后再采纳。\n\n文件变更已列入下方「📦 交付审阅」，采纳前可逐文件查看并撤销。`
          onContent(finalContent)
        } else if (acceptance.overallState === 'passed') {
          const passedSummary = acceptance.checks.map(c => `- [${c.kind}] ${c.command}: ✅ 通过`).join('\n')
          finalContent += `\n\n---\n✅ **验收检查全部通过**\n\n${passedSummary}`
          onContent(finalContent)
        } else if (acceptance.overallState === 'unverified') {
          // P1-fix: 未验证状态也明确告知用户
          finalContent += '\n\n---\n⚠️ **验收检查未执行**\n\n未配置自动检查，无法验证完成状态。'
          onContent(finalContent)
        }
        // P1-B: 构建交付报告（不再被验收状态阻断）并展开审阅面板
        deliveryReport.value = buildDeliveryReport({
          toolCalls: allToolCallResults as any,
          acceptance,
          nodeTitle: '会话'
        })
        deliveryReportVisible.value = true
      } catch (acceptanceError) {
        // P1-fix: 验收过程抛错时不再静默忽略，而是在回复中展示
        const errMsg = acceptanceError instanceof Error ? acceptanceError.message : String(acceptanceError)
        finalContent += `\n\n---\n⚠️ **验收过程出错**\n\n${errMsg}\n\n请注意以上错误，建议手动检查代码。`
        onContent(finalContent)
        // 验收没跑成，但文件变更清单仍有价值：不带验收信息构建报告
        deliveryReport.value = buildDeliveryReport({
          toolCalls: allToolCallResults as any,
          nodeTitle: '会话'
        })
        deliveryReportVisible.value = true
      }
    }
  }

  // 清理本次注册的 MCP 工具处理器
  for (const name of mcpToolNames) {
    toolExecutor.unregister(name)
  }
}

async function runCourtDebate() {
  if (!session.value) return

  // 确保工具可访问工作目录（串行/并行/Agent 均依赖）
  await ensureWorkspaceAuthorized()

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

// ============ 任务快照统一处理 + 任务文档落盘（docs/任务分解.md） ============
let taskDocTimer: ReturnType<typeof setTimeout> | null = null

/** 统一的快照写入入口：更新会话/持久化，并在首次建树时拉出面板 + 调度文档落盘 */
function applyTreeSnapshot(tree: any) {
  if (!session.value) return
  const isFirstTree = !session.value.taskTreeSnapshot
  // 调度器的 tree 是原地修改的同一引用：直接赋值因引用不变而不触发 Vue 更新，
  // 面板会停在初次建树的状态。深拷贝脱离可变源，任务树面板才能随执行实时同步节点状态
  const snapshot = JSON.parse(JSON.stringify(tree))
  session.value.taskTreeSnapshot = snapshot
  debateStore.saveTaskTreeSnapshot(session.value.id, snapshot)
  if (isFirstTree) emit('open-task-tree-panel')
  scheduleTaskDocWrite(snapshot)
}

/** 去抖写文档：状态高频变化时合并，避免频繁磁盘写入 */
function scheduleTaskDocWrite(tree: any) {
  if (!session.value?.workingDirectory) return
  if (taskDocTimer) clearTimeout(taskDocTimer)
  taskDocTimer = setTimeout(() => { void doWriteTaskDoc(tree) }, 400)
}

async function doWriteTaskDoc(tree: any) {
  const wd = session.value?.workingDirectory
  if (!wd || !tree || !window.electronAPI?.writeFile) return
  try {
    const res = await writeTaskDoc(wd, tree, session.value?.topic || '', debateStore.sortedMinisters)
    if (!res.ok && res.error) console.warn('[TaskDoc] 写入失败:', res.error)
  } catch (e) {
    console.warn('[TaskDoc] 写入异常:', e)
  }
}

/**
 * 继续/重试任务树：不传 nodeId 时整树续跑（重跑所有未完成/失败节点），
 * 传 nodeId 时仅重试该节点。不重走丞相拆解与 Plan 审阅。
 * 由右侧任务树面板通过 HomeView 调用。
 */
async function continueTaskTree(nodeId?: string) {
  if (!session.value) return
  const snapshot = session.value.taskTreeSnapshot

  // 任务树已暂停但调度器仍驻留该 run（tick 循环还在、isDebating 仍为 true）：
  // 必须优先走就地恢复，否则会被下面的“任务正在执行中”守卫拦住，无法重试已暂停任务
  if (snapshot && snapshot.state === 'paused') {
    const runId = taskScheduler.findRunIdByDebateId(session.value.id)
    if (runId) {
      let retried = false
      if (nodeId) {
        // 用户明确点击了重试按钮，视作已确认（写操作安全闸门）
        retried = taskScheduler.retryNode(runId, nodeId, true)
      }
      taskScheduler.resume(runId)
      if (nodeId) {
        retried
          ? ElMessage.success('已重新排队该任务并恢复执行')
          : ElMessage.warning('该节点当前状态不可重试，已恢复整树执行')
      } else {
        ElMessage.success('已恢复执行')
      }
      return
    }
  }

  if (isDebating.value) { ElMessage.info('任务正在执行中，请稍候'); return }
  const tree = snapshot
  if (!tree) { ElMessage.warning('当前会话没有任务树，无法继续'); return }
  if (tree.state === 'running') { ElMessage.info('任务树仍在执行中'); return }

  await ensureWorkspaceAuthorized()

  const allMinisters = debateStore.sortedMinisters
  const mentioned = session.value.mentionedMinisters
  const ministers = mentioned && mentioned.length > 0
    ? allMinisters.filter(m => mentioned.includes(m.id))
    : allMinisters
  const chancellor = ministers.find(m => m.id === 'chancellor')
  if (!chancellor) { ElMessage.error('缺少丞相角色，无法继续'); return }
  const execMinisters = ministers.filter(m => m.id !== 'chancellor')
  const workers = execMinisters.length > 0 ? execMinisters : [chancellor]

  const agent = new CoordinatorAgent({ planMode: false })
  agent.onEvent((event) => {
    if (['worker-start', 'worker-done', 'node-completed', 'node-failed', 'tree-completed', 'tree-failed', 'guardian-alert', 'complete'].includes(event.type)) {
      nextTick(() => { isNearBottom = true; scrollToBottom() })
    }
  })

  // 命令免确认：所有工具调用直接放行
  const onBeforeToolExecute = async () => true
  const onRetryNode = async (_nid: string, reason: string) => {
    try {
      await ElMessageBox.confirm(
        `监护器检测到问题：${reason}\n\n是否重试该节点？`,
        '🛡️ 执行监护报警',
        { confirmButtonText: '重试', cancelButtonText: '跳过', distinguishCancelAndClose: true, type: 'warning' }
      )
      return true
    } catch {
      return false
    }
  }

  isDebating.value = true
  hasStartedCourt.value = true
  if (session.value.status !== 'running') session.value.status = 'running'

  let res: { ok: boolean; requeued: number; reason?: string }
  try {
    res = await agent.resumeTaskTree({
      tree,
      nodeId,
      workers,
      resolveLLM: resolveLLMConfig,
      addSpeech: (speech) => debateStore.addSpeech(speech, props.sessionId),
      getReactiveSpeech: (speechId) => session.value!.speeches.find(s => s.id === speechId)!,
      shouldContinue: () => !!session.value && session.value.status === 'running',
      workingDirectory: session.value.workingDirectory,
      onBeforeToolExecute,
      saveSnapshot: (t: any) => applyTreeSnapshot(t),
      onRetryNode,
      topic: session.value.topic + getAttachmentContext()
    })
  } finally {
    isDebating.value = false
    if (session.value) debateStore.completeDebate()
    isNearBottom = true
    scrollToBottom()
  }

  if (res.ok) ElMessage.success(`已继续执行 ${res.requeued} 个任务`)
  else ElMessage.warning(res.reason || '未能继续执行')
}

defineExpose({ continueTaskTree })

/**
 * Agent 模式：丞相拆解 → Workers 执行 → 丞相汇总
 */
async function runAgentDebate(options?: { approvedPlan?: any }) {
  if (!session.value) return

  // 执行前确保工作目录已授权（重启/重载后主进程内存态授权会丢）
  await ensureWorkspaceAuthorized()

  // P1-fix: 每次执行开始时清空旧的交付报告，避免失败轮次展示上次报告
  deliveryReport.value = null
  deliveryReportVisible.value = false

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

  // 除丞相外的大臣作为执行者；若无可用执行者，则由丞相召集（亲自兼任执行者），避免任务派发死锁
  const execMinisters = ministers.filter(m => m.id !== 'chancellor')
  const workers = execMinisters.length > 0 ? execMinisters : [chancellor]

  isNearBottom = true
  await nextTick()
  scrollToBottom()

  const agent = new CoordinatorAgent({
    planMode: !options?.approvedPlan
  })

  // Phase 1: Plan Mode 审阅回调 — 弹出可视化编辑面板（恢复已批准计划时不需要）
  const onPlanReady = createPlanReviewCallback(workers)

  // 命令免确认回调：所有工具调用直接放行
  const onBeforeToolExecute = async () => true

  // 监听 Agent 事件，自动滚动
  agent.onEvent((event) => {
    if (['worker-start', 'worker-done', 'node-completed', 'node-failed', 'tree-created', 'tree-completed', 'tree-failed', 'guardian-alert', 'synthesizing', 'complete'].includes(event.type)) {
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
      debateId: session.value.id,
      onPlanReady,
      ...(options?.approvedPlan ? { initialDecomposition: options.approvedPlan } : {}),
      onBeforeToolExecute,
      saveSnapshot: (tree: any) => applyTreeSnapshot(tree),
      onRetryNode: async (_nodeId: string, reason: string) => {
        try {
          await ElMessageBox.confirm(
            `监护器检测到问题：${reason}\n\n是否重试该节点？`,
            '🛡️ 执行监护报警',
            {
              confirmButtonText: '重试',
              cancelButtonText: '跳过',
              distinguishCancelAndClose: true,
              type: 'warning'
            }
          )
          return true
        } catch {
          return false
        }
      },
      onRecoverInterrupted: async () => {
        const session_val = session.value
        if (!session_val?.taskTreeSnapshot || session_val.taskTreeSnapshot.state !== 'interrupted') return { choice: 'restart' as const }
        try {
          await ElMessageBox.confirm(
            '检测到上次中断的任务树，是否继续执行？',
            '🔄 恢复中断任务',
            {
              confirmButtonText: '继续执行',
              cancelButtonText: '重新开始',
              distinguishCancelAndClose: true,
              type: 'warning'
            }
          )
          return { choice: 'resume' as const, tree: session_val.taskTreeSnapshot }
        } catch (action) {
          if (action === 'cancel') return { choice: 'restart' as const }
          return { choice: null } // ESC 关闭 = 取消
        }
      }
    })
  } catch (error) {
    console.error('[Agent] 协作流程失败:', error)
    // 显示错误信息给用户
    const errorMsg = error instanceof Error ? error.message : '未知错误'
    const errorSpeech: Speech = {
      id: `agent-error-${Date.now()}`,
      ministerId: 'chancellor',
      content: `❌ **协作流程失败**\n\n${errorMsg}\n\n> 建议开启新会话或检查配置后重试。`,
      timestamp: Date.now(),
      status: 'error'
    }
    debateStore.addSpeech(errorSpeech, props.sessionId)
  }

  isNearBottom = true
  scrollToBottom()

  if (session.value) {
    debateStore.completeDebate()
  }

  // P1-B: Agent 模式完成后构建交付报告
  if (session.value?.taskTreeSnapshot) {
    const tree = session.value.taskTreeSnapshot
    const nodes = Object.values(tree.nodes || {})
    // P1-fix: 聚合所有叶节点的验收状态 + 文件变更
    let overallState: 'passed' | 'failed' | 'unverified' = 'unverified'
    const allChecks: any[] = []
    let hasFailed = false
    let hasAnyChecks = false
    // P1-fix: 检查任务树终态：failed/interrupted 会把汇总验收判为未通过
    const treeState = tree.state
    // P1-fix: 逐一核对所有 action 模式叶节点的验收状态
    let allActionNodesPassed = true
    let anyActionNodeLacksAcceptance = false
    for (const rawNode of nodes) {
      const node = rawNode as any
      // 跳过根节点和非叶节点
      if (node.id === tree.rootId || node.childIds.length > 0) continue
      // 只检查 action 模式的叶节点
      if (node.mode !== 'action') continue
      // 跳过已取消/已跳过的节点
      if (node.status === 'cancelled' || node.status === 'skipped') continue
      if (node.status === 'failed') {
        hasFailed = true
        allActionNodesPassed = false
      }
      if (node.acceptanceChecks?.length) {
        allChecks.push(...node.acceptanceChecks)
        hasAnyChecks = true
        if (node.acceptanceState === 'failed') {
          hasFailed = true
          allActionNodesPassed = false
        } else if (node.acceptanceState !== 'passed') {
          // 有检查记录但不是 passed
          allActionNodesPassed = false
        }
      } else {
        // action 模式叶节点没有验收检查记录
        anyActionNodeLacksAcceptance = true
      }
    }
    // P1-fix: 汇总判定：必须所有 action 叶节点都有验收记录且全部 passed
    if (hasAnyChecks && allActionNodesPassed && !anyActionNodeLacksAcceptance && treeState !== 'failed' && treeState !== 'interrupted') {
      overallState = 'passed'
    } else if (hasFailed || treeState === 'failed' || treeState === 'interrupted') {
      overallState = 'failed'
    }
    // 聚合所有叶节点的文件变更
    const allChangedFiles: FileChange[] = []
    for (const node of nodes) {
      if ((node as any).fileBaselines) {
        for (const [path, baseline] of Object.entries((node as any).fileBaselines as Record<string, any>)) {
          const existing = allChangedFiles.find(f => f.path === path)
          if (!existing) {
            // P1-fix: 读取实际文件内容与哈希，校验是否与任务写入后一致
            let actualNewContent = ''
            let currentSha256: string | undefined
            let isNew = false
            if (window.electronAPI?.readFile) {
              try {
                const readResult = await window.electronAPI.readFile(path)
                if (readResult.success) {
                  actualNewContent = readResult.content || ''
                  currentSha256 = readResult.sha256
                }
              } catch { /* 忽略读取失败 */ }
            }
            // 如果没有 beforeSha256 或 beforeSha256 为 'unknown'，可能是新建文件
            if (!baseline.beforeSha256 || baseline.beforeSha256 === 'unknown') {
              isNew = true
            }
            // P0-fix: 从执行时的 diff 保存首次写入前内容；缺失时禁用撤销
            const savedOldContent = baseline.originalContent
            const hasRevertData = isNew || savedOldContent !== undefined
            // P0-fix: 校验当前文件哈希是否与任务写入后一致，不一致说明用户后续修改了文件
            let hashMismatch = false
            if (currentSha256 && baseline.afterSha256 && currentSha256 !== baseline.afterSha256) {
              hashMismatch = true
            }
            allChangedFiles.push({
              path,
              status: isNew ? 'created' : 'modified',
              newContent: actualNewContent,
              oldContent: savedOldContent !== undefined ? savedOldContent : '',
              linesAdded: 0,
              linesRemoved: 0,
              // 标记是否可撤销：新建文件、缺失原始内容、哈希不一致都禁用撤销
              revertDisabled: !hasRevertData || hashMismatch
            })
          }
          // P1-fix: 多节点修改同文件时，保留首次写入的 originalContent（真正的原始版本）
          // 已存在的条目不需要更新，因为第一个节点的 originalContent 就是修改前的真正原始内容
        }
      }
    }
    // P1-fix: 交付报告不再被验收状态阻断：未验证 / 未通过也要让用户看到这次的成果，
    // 验收状态在面板顶部标注，是否采纳由人判断（撤销能力按每个文件的数据完整性自行把关）
    deliveryReport.value = {
      changedFiles: allChangedFiles,
      acceptanceState: overallState,
      acceptanceChecks: allChecks,
      unresolvedQuestions: nodes.filter((n: any) => n.status === 'failed').map((n: any) => `${n.title}: ${n.resultSummary || '执行失败'}`),
      repairsUsed: 0,
      nodeTitle: 'Agent 协作'
    }
    deliveryReportVisible.value = true
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

  // 追问同样需要工作目录授权（主进程内存态可能已丢）
  await ensureWorkspaceAuthorized()

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
  // 空白会话（从项目新建进入）：用首条圣谕作为议题标题
  if (!session.value.topic || session.value.topic === '新会话') {
    session.value.topic = courtInput.value.trim().slice(0, 30) || '新会话'
  }
  debateStore.addSpeech(emperorSpeech, props.sessionId)
  courtInput.value = ''
  showCourtMentionPopup.value = false
  isNearBottom = true
  await nextTick()
  scrollToBottom()

  // 被@的大臣回复
  isSending.value = true
  // 重新打开已完成的朝议；空白会话（idle）首条消息也进入运行态
  if (session.value.status === 'completed' || session.value.status === 'idle') {
    session.value.status = 'running'
  }

  if (debateMode.value === 'agent') {
    // Agent 模式：丞相拆解 + Workers 执行 + 丞相汇总
    const chancellor = ministers.find(m => m.id === 'chancellor')
    // 除丞相外的大臣作为执行者；若无可用执行者，则由丞相召集（亲自兼任执行者）
    const execMinisters = ministers.filter(m => m.id !== 'chancellor')
    const workers = execMinisters.length > 0 ? execMinisters : (chancellor ? [chancellor] : [])

    if (chancellor && workers.length > 0) {
      const agent = new CoordinatorAgent({
        planMode: true
      })

      // Phase 1: Plan Mode 审阅回调 — 弹出可视化编辑面板
      const onPlanReady = createPlanReviewCallback(workers)

      // 命令免确认回调：所有工具调用直接放行
      const onBeforeToolExecute = async () => true

      agent.onEvent((event) => {
        if (['worker-start', 'worker-done', 'node-completed', 'node-failed', 'tree-created', 'tree-completed', 'tree-failed', 'guardian-alert', 'synthesizing', 'complete'].includes(event.type)) {
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
          debateId: session.value!.id,
          onPlanReady,
          onBeforeToolExecute,
          saveSnapshot: (tree: any) => applyTreeSnapshot(tree),
          onRetryNode: async (_nodeId: string, reason: string) => {
            try {
              await ElMessageBox.confirm(
                `监护器检测到问题：${reason}\n\n是否重试该节点？`,
                '🛡️ 执行监护报警',
                {
                  confirmButtonText: '重试',
                  cancelButtonText: '跳过',
                  distinguishCancelAndClose: true,
                  type: 'warning'
                }
              )
              return true
            } catch {
              return false
            }
          },
          onRecoverInterrupted: async () => {
            const session_val = session.value
            if (!session_val?.taskTreeSnapshot || session_val.taskTreeSnapshot.state !== 'interrupted') return { choice: 'restart' as const }
            try {
              await ElMessageBox.confirm(
                '检测到上次中断的任务树，是否继续执行？',
                '🔄 恢复中断任务',
                {
                  confirmButtonText: '继续执行',
                  cancelButtonText: '重新开始',
                  distinguishCancelAndClose: true,
                  type: 'warning'
                }
              )
              return { choice: 'resume' as const, tree: session_val.taskTreeSnapshot }
            } catch (action) {
              if (action === 'cancel') return { choice: 'restart' as const }
              return { choice: null }
            }
          }
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
                {{ isWorkerExecutionSpeech(speech) ? '执行中' : '进言中' }}
                <span class="typing-dots typing-dots-trailing"><span></span><span></span><span></span></span>
              </el-tag>
              <el-tag v-else-if="speech.status === 'error'" type="danger" size="small" effect="plain" class="status-tag">
                错误
              </el-tag>
            </div>

            <div class="message-body" :style="{ fontSize: messageFontSize + 'px' }">
              <!-- Agent worker 执行过程：扁平步骤列表（图标 + 动作名 + 一句话摘要），点击行展开详情 -->
              <div v-if="isWorkerExecutionSpeech(speech)" class="exec-flow">
                <div class="exec-flow-head">
                  <button
                    class="exec-flow-fold"
                    :title="isExecBlockCollapsed(speech) ? '展开执行过程' : '折叠执行过程'"
                    @click="toggleExecBlock(speech)"
                  >
                    <el-icon class="exec-flow-chev" :class="{ 'is-folded': isExecBlockCollapsed(speech) }"><ArrowDown /></el-icon>
                  </button>
                  <span class="exec-flow-title" :class="`exec-flow-title-${speech.status}`">
                    {{ execHeaderLabel(speech) }}<template v-if="execElapsedText(speech)"> · {{ execElapsedText(speech) }}</template>
                  </span>
                  <span class="exec-flow-link" @click="openExecDetail(speech.id)">查看详情 ›</span>
                </div>

                <div v-if="!isExecBlockCollapsed(speech)" class="exec-flow-rows" v-auto-scroll-bottom>
                  <div v-for="seg in execHistorySegs(speech)" :key="seg.id" class="exec-row">
                    <div class="exec-row-line" @click="toggleExecSeg(seg.id)">
                      <span class="exec-row-icon">
                        <el-icon v-if="execRowState(seg, speech) === 'ok'" class="exec-ico-ok"><CircleCheck /></el-icon>
                        <el-icon v-else-if="execRowState(seg, speech) === 'run'" class="exec-ico-run is-loading"><Loading /></el-icon>
                        <el-icon v-else class="exec-ico-fail"><CircleClose /></el-icon>
                      </span>
                      <span class="exec-row-label">{{ execRowLabel(seg, speech) }}</span>
                      <span v-if="execRowStateText(seg, speech)" class="exec-row-state">{{ execRowStateText(seg, speech) }}</span>
                      <template v-if="execRowPreview(seg)">
                        <span class="exec-row-dot">·</span>
                        <span class="exec-row-preview" :class="{ 'is-code': seg.type === 'tool' }" :title="execRowPreview(seg)">{{ execRowPreview(seg) }}</span>
                      </template>
                    </div>

                    <div v-if="expandedExecSegs.has(seg.id)" class="exec-row-detail">
                      <pre v-if="seg.type === 'think'" class="exec-think-text">{{ seg.text || '（本轮无思考文本输出）' }}</pre>
                      <template v-else>
                        <div class="exec-tool-section">
                          <div class="exec-tool-section-title">命令 / 参数</div>
                          <pre class="exec-tool-input">{{ formatToolInput(seg) }}</pre>
                        </div>
                        <div class="exec-tool-section">
                          <div class="exec-tool-section-title">
                            返回内容
                            <span v-if="seg.status === 'executing'" class="exec-tool-running">（执行中…）</span>
                            <span v-else-if="seg.status !== 'completed'" class="exec-tool-failed">（失败）</span>
                          </div>
                          <pre class="exec-tool-output">{{ seg.output || (seg.status === 'executing' ? '…' : '（无输出）') }}</pre>
                        </div>
                        <div v-if="seg.diffData" class="exec-tool-section">
                          <div class="exec-tool-section-title">
                            文件变更
                            <span v-if="seg.diffData.isNew" class="diff-badge diff-new">+新文件</span>
                            <span v-else class="diff-badge diff-modified">
                              <span class="diff-added">+{{ getDiffStats(seg.diffData.oldContent, seg.diffData.newContent).added }}</span>
                              <span class="diff-removed">-{{ getDiffStats(seg.diffData.oldContent, seg.diffData.newContent).removed }}</span>
                            </span>
                          </div>
                          <div class="diff-file-path">{{ seg.diffData.filePath }}</div>
                          <div v-if="seg.diffData.isNew" class="diff-new-file">
                            <pre class="diff-content diff-all-added">{{ seg.diffData.newContent }}</pre>
                          </div>
                          <div v-else class="diff-changes">
                            <div
                              v-for="(line, idx) in computeSimpleDiff(seg.diffData.oldContent, seg.diffData.newContent)"
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
                      </template>
                    </div>
                  </div>
                </div>

                <!-- 当前正在执行的一步：常驻在滚动列表之外，不折叠也不随步骤滚动，点击看右侧详情 -->
                <div
                  v-for="liveSeg in execLiveSegs(speech)"
                  :key="liveSeg.id"
                  class="exec-flow-live"
                  title="查看执行详情"
                  @click="openExecDetail(speech.id)"
                >
                  <span class="exec-row-icon">
                    <el-icon class="exec-ico-run is-loading"><Loading /></el-icon>
                  </span>
                  <span class="exec-row-label">{{ execRowLabel(liveSeg, speech) }}</span>
                  <span v-if="execRowStateText(liveSeg, speech)" class="exec-row-state">{{ execRowStateText(liveSeg, speech) }}</span>
                  <template v-if="execRowPreview(liveSeg)">
                    <span class="exec-row-dot">·</span>
                    <span class="exec-row-preview" :class="{ 'is-code': liveSeg.type === 'tool' }" :title="execRowPreview(liveSeg)">{{ execRowPreview(liveSeg) }}</span>
                  </template>
                </div>

                <!-- 执行结果正文：完成后常驻展示一行摘要（不随步骤列表折叠），点击展开完整正文 -->
                <div v-if="speech.content && speech.status !== 'streaming'" class="exec-flow-result">
                  <div class="exec-row-line" @click="toggleExecSeg(speech.id + '-result')">
                    <el-icon v-if="speech.status === 'error'" class="exec-ico-fail"><CircleClose /></el-icon>
                    <el-icon v-else class="exec-ico-ok"><CircleCheck /></el-icon>
                    <span class="exec-row-label">{{ speech.status === 'error' ? '错误详情' : '执行结果' }}</span>
                    <span class="exec-row-dot">·</span>
                    <span class="exec-row-preview" :title="resultPreview(speech)">{{ resultPreview(speech) }}</span>
                  </div>
                  <div v-if="expandedExecSegs.has(speech.id + '-result')" class="exec-row-detail">
                    <!-- 报错正文按纯文本展示：走 markdown 渲染会被 sanitize-markdown 当作非法标签整棵删掉，详情就“看不见”了 -->
                    <pre v-if="speech.status === 'error'" class="exec-error-text">{{ speech.content }}</pre>
                    <div v-else class="message-text markdown-body" v-html="renderMarkdown(speech.content)"></div>
                  </div>
                </div>
              </div>

              <!-- 工具调用状态展示 -->
              <div v-if="!isWorkerExecutionSpeech(speech) && speech.toolStatuses && speech.toolStatuses.length > 0" class="tool-calls-section">
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

              <pre
                v-if="!isWorkerExecutionSpeech(speech) && speech.status === 'error'"
                class="message-text exec-error-text"
              >{{ speech.content }}</pre>
              <div
                v-else-if="!isWorkerExecutionSpeech(speech)"
                class="message-text markdown-body"
                :class="{ 'emperor-collapsed': shouldCollapseEmperor(speech) && !isEmperorExpanded(speech.id) }"
                v-html="renderMarkdown(speech.content)"
              ></div>
              <div
                v-if="shouldCollapseEmperor(speech)"
                class="emperor-collapse-toggle"
                @click="toggleEmperorExpand(speech.id)"
              >
                {{ isEmperorExpanded(speech.id) ? '收起 ▲' : '展开全文 ▼' }}
              </div>
            </div>

            <!-- Phase 1: Plan Mode 审阅 — 确定/取消内联在丞相拆解发言气泡底部 -->
            <div v-if="isPendingPlanSpeech(speech)" class="plan-review-inline">
              <span class="plan-review-hint">📋 是否批准按以上拆解执行？</span>
              <div class="plan-review-actions">
                <el-button size="small" @click="handlePlanCancel">取消</el-button>
                <el-button size="small" type="primary" @click="approveCurrentPlan">✅ 确定执行</el-button>
              </div>
            </div>

            <!-- 消息操作栏（底部） -->
            <div v-if="speech.status === 'completed' && !isWorkerExecutionSpeech(speech)" class="message-actions">
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

    <!-- Sprint A - #1：决策质量报告（四象限）（暂时停用，见 enableDecisionReport） -->
    <div
      v-if="enableDecisionReport && session.mode === 'court' && session.status === 'completed'"
      class="decision-report-wrapper"
    >
      <div v-if="!session.decisionReport" class="decision-report-loading">
        <el-icon class="is-loading"><Loading /></el-icon>
        <span>丞相正在整理决策报告（共识 / 分歧 / 风险 / 假设）…</span>
      </div>
      <div v-else class="decision-report">
        <header class="decision-report-header" @click="decisionReportExpanded = !decisionReportExpanded">
          <h3 class="decision-report-title">📜 决策报告 <span class="decision-report-caret">{{ decisionReportExpanded ? '▾ 收起' : '▸ 展开' }}</span></h3>
          <span class="decision-report-time">
            {{ new Date(session.decisionReport.generatedAt).toLocaleTimeString('zh-CN') }}
          </span>
        </header>
        <div v-show="decisionReportExpanded" class="decision-report-body">
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
    </div>

    <!-- P1-B: 交付审阅面板（报告随会话持久化，可通过输入框上方的入口反复展开） -->
    <div
      v-if="deliveryReportVisible && deliveryReport && deliveryReport.changedFiles.length + deliveryReport.acceptanceChecks.length > 0"
      class="delivery-panel-wrapper"
    >
      <DeliveryPanel
        :report="deliveryReport"
        @confirm="handleDeliveryConfirm"
        @revert="handleDeliveryRevert"
      />
    </div>

    <!-- Agent worker 执行详情抽屉（右侧）：实时内容 + 工具调用 + diff -->
    <el-drawer
      v-model="execDetailVisible"
      :with-header="false"
      direction="rtl"
      size="min(520px, 92vw)"
      class="exec-detail-drawer"
    >
      <div v-if="activeDetailSpeech" class="exec-detail-inner">
        <header class="exec-detail-header">
          <div class="exec-detail-identity">
            <div class="avatar-content exec-detail-avatar">
              <img v-if="isImageAvatar(getMinisterAvatar(activeDetailSpeech.ministerId))" :src="getMinisterAvatar(activeDetailSpeech.ministerId)" class="avatar-img" />
              <span v-else>{{ getMinisterAvatar(activeDetailSpeech.ministerId) }}</span>
            </div>
            <div class="exec-detail-titlenote">
              <div class="exec-detail-name">{{ getMinisterName(activeDetailSpeech.ministerId) }}</div>
              <div class="exec-detail-sub">
                {{ getMinisterTitle(activeDetailSpeech.ministerId) }}
                <span v-if="getMinisterModel(activeDetailSpeech.ministerId)"> · {{ getMinisterModel(activeDetailSpeech.ministerId) }}</span>
              </div>
            </div>
          </div>
          <div class="exec-detail-headright">
            <el-tag v-if="activeDetailSpeech.status === 'streaming'" type="warning" size="small" effect="plain">
              执行中<span class="typing-dots typing-dots-trailing"><span></span><span></span><span></span></span>
            </el-tag>
            <el-tag v-else-if="activeDetailSpeech.status === 'error'" type="danger" size="small" effect="plain">失败</el-tag>
            <el-tag v-else type="success" size="small" effect="plain">已完成</el-tag>
            <el-button text size="small" @click="execDetailVisible = false">✕ 关闭</el-button>
          </div>
        </header>

        <div class="exec-detail-body">
          <!-- 刚起头、还什么都没发生时给一句说明，不留整块空白 -->
          <p
            v-if="detailTimeline(activeDetailSpeech).length === 0 && (!activeDetailSpeech.toolStatuses || activeDetailSpeech.toolStatuses.length === 0)"
            class="exec-detail-empty"
          >
            尚无执行步骤（正在等待本轮输出）
          </p>

          <!-- 执行过程：思考逐条保留，连续的命令/搜索类步骤合并成一行「执行 N 步」，
               读起来就是 思考 → 执行 → 思考 → 执行 的节奏，不被一大串工具行淹没 -->
          <section v-if="detailTimeline(activeDetailSpeech).length > 0" class="exec-detail-section">
            <h4 class="exec-detail-section-title">🧭 执行过程（{{ detailHeadSummary(activeDetailSpeech) }}）</h4>
            <div class="exec-detail-steps" v-auto-scroll-bottom>
              <div
                v-for="row in detailRows(activeDetailSpeech)"
                :key="row.key"
                class="exec-row"
                :class="{ 'is-sub': row.depth > 0, 'is-group': row.kind === 'group' }"
              >
                <div class="exec-row-line" @click="onDetailRowClick(row)">
                  <span class="exec-row-icon">
                    <el-icon v-if="row.icon === 'ok'" class="exec-ico-ok"><CircleCheck /></el-icon>
                    <el-icon v-else-if="row.icon === 'run'" class="exec-ico-run is-loading"><Loading /></el-icon>
                    <el-icon v-else class="exec-ico-fail"><CircleClose /></el-icon>
                  </span>
                  <el-icon v-if="row.kind === 'group'" class="exec-row-chev" :class="{ 'is-folded': !row.groupOpen }"><ArrowDown /></el-icon>
                  <span class="exec-row-label">{{ row.label }}</span>
                  <span v-if="row.stateText" class="exec-row-state">{{ row.stateText }}</span>
                  <span
                    v-if="row.diffData"
                    class="tool-diff-toggle"
                    @click.stop="toggleDiffExpand(row.diffKey || row.key)"
                  >
                    <span v-if="row.diffData.isNew" class="diff-badge diff-new">+新文件</span>
                    <span v-else class="diff-badge diff-modified">
                      <span class="diff-added">+{{ getDiffStats(row.diffData.oldContent, row.diffData.newContent).added }}</span>
                      <span class="diff-removed">-{{ getDiffStats(row.diffData.oldContent, row.diffData.newContent).removed }}</span>
                    </span>
                  </span>
                  <template v-if="row.preview">
                    <span class="exec-row-dot">·</span>
                    <span class="exec-row-preview" :class="{ 'is-code': row.kind !== 'think' }" :title="row.preview">{{ row.preview }}</span>
                  </template>
                </div>

                <!-- 组行自己不展开：它的“详情”就是下面列出的各个执行步 -->
                <div v-if="row.kind !== 'group' && expandedExecSegs.has(row.key)" class="exec-row-detail">
                  <pre v-if="row.kind === 'think'" class="exec-detail-think">{{ rowThinkText(row) || '（本轮无思考文本输出）' }}</pre>
                  <template v-else>
                    <div class="exec-tool-section">
                      <div class="exec-tool-section-title">命令 / 参数</div>
                      <pre class="exec-tool-input">{{ formatToolInput(rowTool(row)) }}</pre>
                    </div>
                    <div class="exec-tool-section">
                      <div class="exec-tool-section-title">
                        返回内容
                        <span v-if="rowTool(row).status === 'executing'" class="exec-tool-running">（执行中…）</span>
                        <span v-else-if="rowTool(row).status !== 'completed'" class="exec-tool-failed">（失败）</span>
                      </div>
                      <pre class="exec-tool-output">{{ rowTool(row).output || (rowTool(row).status === 'executing' ? '…' : '（无输出）') }}</pre>
                    </div>
                    <div v-if="row.diffData && expandedDiffs.has(row.diffKey || row.key)" class="tool-diff-panel" @click.stop>
                      <div class="diff-file-path">{{ row.diffData.filePath }}</div>
                      <div v-if="row.diffData.isNew" class="diff-new-file">
                        <pre class="diff-content diff-all-added">{{ row.diffData.newContent }}</pre>
                      </div>
                      <div v-else class="diff-changes">
                        <div
                          v-for="(line, idx) in computeSimpleDiff(row.diffData.oldContent, row.diffData.newContent)"
                          :key="idx"
                          class="diff-line"
                          :class="`diff-line-${line.type}`"
                        >
                          <span class="diff-line-marker">{{ line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ' }}</span>
                          <span v-if="line.lineNum" class="diff-line-num">{{ line.lineNum }}</span>
                          <span class="diff-line-text">{{ line.line }}</span>
                        </div>
                      </div>
                    </div>
                    <div v-else-if="row.diffData" class="exec-tool-hint">
                      点击上方行的 +/- 徽标展开文件变更
                    </div>
                  </template>
                </div>
              </div>
            </div>
          </section>

          <!-- 兼容旧归档数据：改动前落盘的会话没有 execTimeline，退化到按工具调用平铺 -->
          <section
            v-else-if="activeDetailSpeech.toolStatuses && activeDetailSpeech.toolStatuses.length > 0"
            class="exec-detail-section"
          >
            <h4 class="exec-detail-section-title">🔧 执行步骤（{{ activeDetailSpeech.toolStatuses.length }}）</h4>
            <div
              v-for="tc in activeDetailSpeech.toolStatuses"
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
          </section>

          <!-- 结论正文：发言收尾后才出现。speech.content 每轮都会被引擎重写一次，
               执行中不展示，否则看起来像“上一轮内容被下一条思考覆盖掉了” -->
          <section v-if="activeDetailSpeech.status !== 'streaming'" class="exec-detail-section">
            <h4 class="exec-detail-section-title">📄 最终结论</h4>
            <p v-if="activeDetailSpeech.status === 'error'" class="exec-detail-hint">
              执行过程被该错误中断，上方「执行过程」保留了中断前已落定的各轮思考与工具调用。
            </p>
            <pre
              v-if="activeDetailSpeech.status === 'error'"
              class="exec-error-text"
            >{{ activeDetailSpeech.content }}</pre>
            <div
              v-else-if="activeDetailSpeech.content"
              class="message-text markdown-body"
              v-html="renderMarkdown(activeDetailSpeech.content)"
            ></div>
            <p v-else class="exec-detail-empty">（暂无输出内容）</p>
          </section>
        </div>
      </div>
    </el-drawer>

    <!-- 底部 -->
    <footer class="session-footer">
      <!-- 交付成果常驻入口：报告随会话持久化，确认交付或切换标签页后仍能重新查看 -->
      <div v-if="deliveryReport" class="delivery-entry">
        <span class="delivery-entry-icon">📦</span>
        <span class="delivery-entry-text">
          交付成果：{{ deliveryReport.changedFiles.length }} 个文件变更
          <span class="delivery-entry-state" :class="`delivery-entry-${deliveryReport.acceptanceState}`">{{ deliveryStateLabel }}</span>
          <span v-if="session?.deliveryConfirmedAt" class="delivery-entry-confirmed">已确认交付</span>
        </span>
        <button class="delivery-entry-btn" @click="deliveryReportVisible = !deliveryReportVisible">
          {{ deliveryReportVisible ? '收起 ▾' : '查看 ▴' }}
        </button>
      </div>
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
            <el-tooltip content="搜索 (Ctrl+F)" placement="top">
              <el-button size="small" circle @click="toggleSearch" class="toolbar-icon-btn" :class="{ 'search-active': showSearch }">🔍</el-button>
            </el-tooltip>
            <el-tooltip content="导出 Markdown (Ctrl+E)" placement="top">
              <el-button size="small" circle @click="exportToMarkdown" class="toolbar-icon-btn">
                <el-icon><Download /></el-icon>
              </el-button>
            </el-tooltip>
            <el-tooltip v-if="session?.taskTreeSnapshot" content="导出任务树事件日志" placement="top">
              <el-button size="small" circle @click="exportEventLog" class="toolbar-icon-btn">
                📋
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
  /* 头像列宽度（头像 48px + 间距 16px）：消息区与底部输入框共用的单一来源，
     气泡只让出自己这一列头像，输入框按同一口径限宽，两者边缘对齐 */
  --avatar-col: 64px;
  /* 气泡与输入框的最小宽度：面板拉到再窄也不再缩于此值，超出部分横向滚动 */
  --bubble-min-w: 400px;
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
  /* 窄面板下气泡不再被挤压，而是整列保持下限宽度，靠横向滚动看完 */
  overflow-x: auto;
  padding: 24px;
}

/* 任务树可视化容器：不被长消息挤压，居中对齐、限宽 */
.task-tree-container {
  flex-shrink: 0;
  padding: 0 24px 10px;
  max-width: 1100px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}

/* Phase 1: Plan Mode 审阅确认条（内联在丞相拆解发言气泡底部）
   - 只保留确定/取消，不再重复展示拆解内容 */
.plan-review-inline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--ct-border);
}

.plan-review-hint {
  font-size: 13px;
  color: var(--ct-text-primary);
}

.plan-review-actions {
  display: flex;
  gap: 8px;
}

.messages-inner {
  /* 消息流撑满会话区（减去 .session-messages 左右内边距），气泡铺满整行 */
  max-width: 100%;
  /* 下限按“气泡最小宽 + 一列头像”倒推：容器到这个宽度后不再收窄，
     气泡可用宽度恰好是 var(--bubble-min-w)（max-width 为 100% 减去一列头像） */
  min-width: calc(var(--bubble-min-w) + var(--avatar-col));
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
  /* 气泡 = 整行宽度减去自己这一列头像（约 95%），头像加气泡刚好铺满 100% */
  flex: 1;
  max-width: calc(100% - var(--avatar-col));
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

/* 跳动省略号：限定容器高度并缩小跳动幅度，避免小尺寸 el-tag 内三点越出边框 */
.typing-dots {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 12px;
  margin-right: 4px;
  flex-shrink: 0;
  overflow: hidden;
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

/* 跟在文字后面（如“执行中…”）时改用左侧间距 */
.typing-dots-trailing { margin-right: 0; margin-left: 4px; }

@keyframes typing {
  0%, 60%, 100% { transform: translateY(0); }
  30% { transform: translateY(-3px); }
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

/* 圣谕（自己发的内容）超长折叠：限高 + 底部渐隐，点击展开全文后解除 */
.message-text.emperor-collapsed {
  max-height: 96px;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, #000 60%, transparent 100%);
  mask-image: linear-gradient(to bottom, #000 60%, transparent 100%);
}

.emperor-collapse-toggle {
  margin-top: 6px;
  font-size: 12px;
  color: var(--ct-accent);
  cursor: pointer;
  user-select: none;
  text-align: right;
  opacity: 0.85;
}

.emperor-collapse-toggle:hover {
  opacity: 1;
  text-decoration: underline;
}

/* ===== Agent 执行过程（扁平步骤列表） ===== */
.exec-flow {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.exec-flow-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--ct-text-secondary);
}

.exec-flow-fold {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--ct-border);
  border-radius: 5px;
  background: var(--ct-bg-secondary);
  color: var(--ct-text-muted);
  cursor: pointer;
}

.exec-flow-fold:hover { background: var(--ct-bg-tertiary); }

.exec-flow-chev { transition: transform 0.15s ease; }
.exec-flow-chev.is-folded { transform: rotate(-90deg); }

.exec-flow-title { font-weight: 600; }
.exec-flow-title-streaming { color: var(--ct-text-primary); }
.exec-flow-title-completed { color: #2e7d32; }
.exec-flow-title-error { color: #ef4444; }

.exec-flow-link {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--ct-accent);
  cursor: pointer;
  opacity: 0.85;
}

.exec-flow-link:hover { opacity: 1; }

.exec-flow-rows {
  display: flex;
  flex-direction: column;
  gap: 1px;
  /* 步骤过多时限高内部滚动，避免气泡被拉得过长看不清当前位置 */
  max-height: 320px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 4px;
}

.exec-row-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 3px 6px;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
  font-size: 12.5px;
}

.exec-row-line:hover { background: var(--ct-bg-tertiary); }

.exec-row-icon {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  font-size: 13px;
}

.exec-ico-ok { color: #2e7d32; }
.exec-ico-run { color: var(--ct-text-muted); }
.exec-ico-fail { color: #ef4444; }

.exec-row-label {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--ct-text-primary);
}

.exec-row-state { flex-shrink: 0; color: var(--ct-text-secondary); }
.exec-row-dot { flex-shrink: 0; color: var(--ct-text-muted); }

.exec-row-preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ct-text-muted);
}

.exec-row-preview.is-code {
  font-family: ui-monospace, Consolas, 'Courier New', monospace;
  font-size: 11.5px;
}

.exec-row-detail {
  margin: 2px 0 6px 26px;
  padding: 8px 10px;
  border-left: 2px solid var(--ct-border);
  border-radius: 0 6px 6px 0;
  background: var(--ct-bg-secondary);
}

/* 当前正在执行的一步：常驻在滚动列表下方的独立区域，不折叠、不参与滚动 */
.exec-flow-live {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-top: 6px;
  padding: 4px 6px;
  border-top: 1px dashed var(--ct-border);
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
  font-size: 12.5px;
}

.exec-flow-live:hover { background: var(--ct-bg-tertiary); }

.exec-flow-live .exec-row-label {
  color: var(--ct-accent);
}

.exec-flow-result { margin-top: 2px; }

.exec-think-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ct-text-secondary);
  font-family: inherit;
}

.exec-tool-section { margin-bottom: 8px; }
.exec-tool-section:last-child { margin-bottom: 0; }

/* 报错正文：不参与 markdown 渲染，原样可见并可滚动 */
.exec-error-text {
  display: block;
  margin: 0;
  padding: 8px 10px;
  background: var(--ct-bg-tertiary);
  border: 1px solid var(--ct-border);
  border-left: 2px solid #ef4444;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  color: #ef4444;
  font-family: ui-monospace, Consolas, 'Courier New', monospace;
  max-height: 300px;
  overflow: auto;
}

.exec-tool-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ct-text-muted);
}

.exec-tool-running { color: var(--ct-accent); font-weight: 400; }
.exec-tool-failed { color: #ef4444; font-weight: 400; }

.exec-tool-input,
.exec-tool-output {
  margin: 0;
  padding: 8px 10px;
  background: var(--ct-bg-tertiary);
  border: 1px solid var(--ct-border);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--ct-text-primary);
  max-height: 260px;
  overflow: auto;
}

.exec-tool-output { color: var(--ct-text-secondary); }

/* ===== 右侧执行详情抽屉内容 ===== */
.exec-detail-inner {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.exec-detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--ct-border);
}

.exec-detail-identity {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.exec-detail-avatar {
  width: 40px;
  height: 40px;
  font-size: 22px;
  flex-shrink: 0;
}

.exec-detail-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--ct-text-primary);
}

.exec-detail-sub {
  font-size: 12px;
  color: var(--ct-text-muted);
}

.exec-detail-headright {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.exec-detail-body {
  flex: 1;
  overflow-y: auto;
}

.exec-detail-section {
  margin-bottom: 18px;
}

.exec-detail-section-title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ct-accent);
}

.exec-detail-empty {
  font-size: 13px;
  color: var(--ct-text-muted);
  font-style: italic;
  margin: 0;
}

/* 抽屉里的执行过程：自身带限高滚动，跟住最新一步而不把上方抬头与结论顶出可视区 */
.exec-detail-steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 55vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 4px;
}

/* 合并组展开后的子步骤：缩进 + 左侧连线，与组头形成从属关系 */
.exec-row.is-sub {
  margin-left: 20px;
  padding-left: 8px;
  border-left: 1px solid var(--ct-border);
}

/* 组头措辞与普通步骤区分，让“可点开的一串执行”一眼可认 */
.exec-row.is-group > .exec-row-line .exec-row-label {
  color: var(--ct-accent);
}

.exec-row-chev {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--ct-text-muted);
  transition: transform 0.15s ease;
}

.exec-row-chev.is-folded { transform: rotate(-90deg); }

/* 每轮思考全文：抽屉是看细节的地方，不像气泡那样只留一行摘要 */
.exec-detail-think {
  margin: 4px 0 0;
  padding: 8px 10px;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ct-text-primary);
  background: var(--ct-bg-tertiary);
  border-left: 2px solid var(--ct-accent);
  border-radius: 4px;
}

.exec-detail-hint {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--ct-text-muted);
  line-height: 1.5;
}

.exec-tool-hint {
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--ct-text-muted);
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
  /* 输入框有最小宽度下限，窄面板下靠横向滚动而不是被外层 overflow:hidden 裁掉 */
  overflow-x: auto;
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

.chat-input {
  /* 与气泡同宽：整行减去一列头像宽度；
     .session-messages 与 .session-footer 左右内边距同为 24px，宽度基准一致 */
  max-width: calc(100% - var(--avatar-col));
  min-width: var(--bubble-min-w);
  margin: 0 auto;
}

/* 交付成果入口条：与输入框同宽同轴，有报告时常驻在输入框上方 */
.delivery-entry {
  max-width: calc(100% - var(--avatar-col));
  min-width: var(--bubble-min-w);
  margin: 0 auto 6px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border: 1px solid var(--ct-border);
  border-radius: 10px;
  background: var(--ct-bg);
  font-size: 12px;
  color: var(--ct-text-secondary);
}

.delivery-entry-icon {
  flex-shrink: 0;
}

.delivery-entry-text {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.delivery-entry-state {
  padding: 0 6px;
  border-radius: 8px;
  font-size: 11px;
  border: 1px solid var(--ct-border);
}

.delivery-entry-passed { color: #10b981; border-color: rgba(16, 185, 129, 0.4); }
.delivery-entry-failed { color: #ef4444; border-color: rgba(239, 68, 68, 0.4); }
.delivery-entry-unverified { color: #f59e0b; border-color: rgba(245, 158, 11, 0.4); }

.delivery-entry-confirmed {
  color: var(--ct-text-muted);
  font-size: 11px;
}

.delivery-entry-btn {
  flex-shrink: 0;
  padding: 1px 10px;
  border-radius: 8px;
  border: 1px solid var(--ct-accent);
  background: transparent;
  color: var(--ct-accent);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}

.delivery-entry-btn:hover {
  background: var(--ct-accent);
  color: #fff;
}

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
  .session-container {
    /* 头像 40px + 间距 12px，气泡与输入框同步收窄 */
    --avatar-col: 52px;
  }
  .message-item {
    gap: 12px;
  }
  .avatar-content { width: 40px; height: 40px; font-size: 24px; }
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
  flex-shrink: 0;
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
  cursor: pointer;
  user-select: none;
}

.decision-report-body {
  max-height: 42vh;
  overflow-y: auto;
}

.decision-report-caret {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 400;
  color: var(--ct-text-muted);
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
