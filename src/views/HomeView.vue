<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useDebateStore } from '@/stores/debate'
import { Promotion, Setting, Fold, Expand, Plus, Close, House, Clock, Right, Back, FolderOpened, Edit, DocumentCopy, Connection, Delete, User, InfoFilled, Search } from '@element-plus/icons-vue'
import ChatSession from '@/components/ChatSession.vue'
import { llmService } from '@/services/llm-config'
import { ElMessageBox } from 'element-plus'
import { TOPIC_TEMPLATES, getTemplateCategories, applyTemplate as applyTopicTemplate } from '@/services/topic-templates'
import type { TopicTemplate } from '@/services/topic-templates'
import type { Attachment } from '@/types'
import { backgroundScheduler } from '@/services/scheduler'

const router = useRouter()
const debateStore = useDebateStore()
const topic = ref('')
const showSidebar = ref(true)

// 角色选中状态（默认仅选中丞相）
const selectedMinisters = ref<Set<string>>(new Set(['chancellor']))

function toggleMinisterSelection(ministerId: string) {
  const newSet = new Set(selectedMinisters.value)
  if (newSet.has(ministerId)) {
    newSet.delete(ministerId)
  } else {
    newSet.add(ministerId)
  }
  selectedMinisters.value = newSet
}

const selectedCount = computed(() => selectedMinisters.value.size)
const totalCount = computed(() => debateStore.ministers.length)

// 工作目录
const workingDirectory = ref('')
const workingDirName = computed(() => {
  const dir = workingDirectory.value
  if (!dir) return ''
  // 取最后一级目录名
  const normalized = dir.replace(/[\\/]+$/, '')
  const lastSep = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  return lastSep >= 0 ? normalized.slice(lastSep + 1) : normalized
})

function browseWorkingDir() {
  if (window.electronAPI?.showOpenDialog) {
    window.electronAPI.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择工作目录'
    }).then((result: any) => {
      if (!result.canceled && result.filePaths?.length > 0) {
        workingDirectory.value = result.filePaths[0]
      }
    }).catch(() => { /* 取消 */ })
  }
}

// 左侧工具条
const showLeftToolbar = ref(true)

// About 弹窗
const showAboutDialog = ref(false)

// 登录按钮点击（预留）
function handleLoginClick() {
  // TODO: 实现登录流程
  ElMessageBox.alert('登录功能开发中，敬请期待', '登录', {
    confirmButtonText: '知道了',
    type: 'info'
  })
}

// 右侧面板
const showRightPanel = ref(false)
const rightPanelWidth = ref(300)
const mainContentRef = ref<HTMLElement | null>(null)
let isResizingRight = false
let resizeStartX = 0
let resizeStartWidth = 0

function toggleRightPanel() {
  showRightPanel.value = !showRightPanel.value
}

// ============ 右侧任务面板 ============

const rightPanelTab = ref<'tasks' | 'attachments'>('tasks')

/** 当前会话关联的后台任务 */
const sessionTasks = computed(() => {
  const sessionId = debateStore.activeSessionId
  if (!sessionId) return []
  return backgroundScheduler.getAll().filter(t => t.debateId === sessionId)
})

const activeTaskCount = computed(() => sessionTasks.value.filter(t => t.status === 'pending' || t.status === 'running').length)

function openTaskPanel() {
  rightPanelTab.value = 'tasks'
  showRightPanel.value = true
}

function openAttachmentPanel() {
  rightPanelTab.value = 'attachments'
  showRightPanel.value = true
}

function getTaskStatusIcon(status: string): string {
  switch (status) {
    case 'pending': return '⏳'
    case 'running': return '🔄'
    case 'completed': return '✅'
    case 'failed': return '❌'
    case 'cancelled': return '🚫'
    default: return '❓'
  }
}

function getTaskStatusLabel(status: string): string {
  switch (status) {
    case 'pending': return '等待中'
    case 'running': return '执行中'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
    default: return status
  }
}

function getTaskTypeLabel(type: string): string {
  switch (type) {
    case 'delayed': return '延时任务'
    case 'interval': return '周期任务'
    case 'follow-up': return '再上奏'
    case 'long-debate': return '长辩论'
    default: return type
  }
}

function formatTime(ts: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function cancelTask(taskId: string) {
  backgroundScheduler.cancel(taskId)
}

/** 当前会话的附件列表（代理到 session） */
const sessionAttachments = computed(() => debateStore.activeSession?.attachments || [])

function startResizeRight(e: MouseEvent) {
  isResizingRight = true
  resizeStartX = e.clientX
  resizeStartWidth = rightPanelWidth.value
  document.addEventListener('mousemove', onResizeRight)
  document.addEventListener('mouseup', stopResizeRight)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onResizeRight(e: MouseEvent) {
  if (!isResizingRight) return
  const delta = resizeStartX - e.clientX
  const maxWidth = mainContentRef.value ? mainContentRef.value.offsetWidth * 0.5 : 600
  rightPanelWidth.value = Math.max(200, Math.min(maxWidth, resizeStartWidth + delta))
}

function stopResizeRight() {
  isResizingRight = false
  document.removeEventListener('mousemove', onResizeRight)
  document.removeEventListener('mouseup', stopResizeRight)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

const recentDebates = computed(() => debateStore.debates.slice(0, 10))

// 状态栏：当前主题名称
const currentThemeName = computed(() => {
  const presets = debateStore.getDynastyPresets()
  const current = presets.find(p => p.id === debateStore.currentDynastyId)
  return current ? `${current.icon} ${current.name}` : '未知主题'
})

// @ 提及功能
const showMentionPopup = ref(false)
const mentionFilter = ref('')

const filteredMinisters = computed(() => {
  const filter = mentionFilter.value.toLowerCase()
  return debateStore.sortedMinisters.filter(m =>
    !filter || m.name.toLowerCase().includes(filter) || m.title.toLowerCase().includes(filter)
  )
})

watch(topic, (val) => {
  const match = val.match(/@(\S*)$/)
  if (match) {
    showMentionPopup.value = true
    mentionFilter.value = match[1]
  } else {
    showMentionPopup.value = false
    mentionFilter.value = ''
  }
})

function selectMention(ministerId: string) {
  const minister = debateStore.ministers.find(m => m.id === ministerId)
  if (!minister) return
  topic.value = topic.value.replace(/@\S*$/, `@${minister.name} `)
  showMentionPopup.value = false
}

function parseMentions(text: string): string[] {
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

function startDebate() {
  if (!topic.value.trim() && attachments.value.length === 0) return
  const mentioned = parseMentions(topic.value)
  // 优先使用 @ 指定的大臣，否则使用复选框选中的大臣
  let ministersForSession: string[] | undefined
  if (mentioned.length > 0) {
    ministersForSession = mentioned
  } else {
    // 始终传递复选框选中的角色列表
    ministersForSession = Array.from(selectedMinisters.value)
  }
  const dir = workingDirectory.value.trim() || undefined
  const atts = attachments.value.length > 0 ? [...attachments.value] : undefined
  debateStore.startDebate(topic.value, 'court', ministersForSession, dir, atts)
  topic.value = ''
  attachments.value = []
}

// ============ 附件功能 ============

const attachments = ref<Attachment[]>([])
const attachingFile = ref(false)
const isDraggingFiles = ref(false)

/** 通过文件路径读取附件（拖拽和对话框共用） */
async function loadAttachmentFiles(filePaths: string[]) {
  if (!window.electronAPI?.readAttachment) return
  attachingFile.value = true
  try {
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
        attachments.value.push(att)
      } else {
        ElMessageBox.alert(`文件读取失败：${readResult.error || '未知错误'}\n${filePath}`, '附件导入失败', { type: 'error' })
      }
    }
  } catch (error) {
    console.error('[loadAttachmentFiles] 失败:', error)
  } finally {
    attachingFile.value = false
  }
}

async function addAttachment() {
  if (!window.electronAPI?.showOpenDialog || !window.electronAPI?.readAttachment) {
    ElMessageBox.alert('附件功能需要 Electron 桌面版支持', '提示', { type: 'info' })
    return
  }
  try {
    const result = await window.electronAPI.showOpenDialog({
      title: '选择附件文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '文档', extensions: ['pdf', 'doc', 'docx', 'txt', 'md', 'csv', 'xlsx', 'xls', 'pptx'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return
    await loadAttachmentFiles(result.filePaths)
  } catch (error) {
    console.error('[addAttachment] 失败:', error)
  }
}

// 拖拽文件处理
function onDragOver(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer?.types.includes('Files')) {
    isDraggingFiles.value = true
  }
}

function onDragLeave(e: DragEvent) {
  e.preventDefault()
  // 只有真正离开容器时才重置
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const { clientX, clientY } = e
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    isDraggingFiles.value = false
  }
}

async function onDropFiles(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  isDraggingFiles.value = false

  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return

  // Electron 环境下 file.path 包含完整路径
  const paths: string[] = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i] as any
    if (f.path) {
      paths.push(f.path)
    }
  }
  if (paths.length > 0) {
    await loadAttachmentFiles(paths)
  } else {
    ElMessageBox.alert('无法获取文件路径，请通过按钮选择文件', '拖拽导入失败', { type: 'warning' })
  }
}

function removeAttachment(id: string) {
  attachments.value = attachments.value.filter(a => a.id !== id)
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

// ============ 主题模板库 ============

const showTemplateDialog = ref(false)
const templateCategory = ref('all')
const selectedTemplate = ref<TopicTemplate | null>(null)
const placeholderValues = ref<Record<string, string>>({})

const templateCategories = getTemplateCategories()

const filteredTemplates = computed(() => {
  if (templateCategory.value === 'all') return TOPIC_TEMPLATES
  return TOPIC_TEMPLATES.filter(t => t.category === templateCategory.value)
})

function openTemplateDialog() {
  templateCategory.value = 'all'
  selectedTemplate.value = null
  showTemplateDialog.value = true
}

function pickTemplate(tpl: TopicTemplate) {
  if (tpl.placeholders && tpl.placeholders.length > 0) {
    // 有占位符，进入填充步骤
    selectedTemplate.value = tpl
    const vals: Record<string, string> = {}
    for (const ph of tpl.placeholders) {
      vals[ph.key] = ph.defaultValue || ''
    }
    placeholderValues.value = vals
  } else {
    // 无占位符，直接应用
    doApplyTemplate(tpl, {})
  }
}

function confirmPlaceholder() {
  if (!selectedTemplate.value) return
  doApplyTemplate(selectedTemplate.value, placeholderValues.value)
}

function doApplyTemplate(tpl: TopicTemplate, values: Record<string, string>) {
  // 填充议题
  const finalTopic = applyTopicTemplate(tpl, values)
  topic.value = finalTopic

  // 设置模式（如果模板有推荐模式）
  if (tpl.recommendedMode && tpl.recommendedMode !== 'court') {
    debateStore.debateMode = tpl.recommendedMode
  }

  // 预选角色
  if (tpl.recommendedMinisters && tpl.recommendedMinisters.length > 0) {
    const ministerSet = new Set<string>()
    for (const id of tpl.recommendedMinisters) {
      if (debateStore.ministers.find(m => m.id === id)) {
        ministerSet.add(id)
      }
    }
    // 保留已选中的角色，同时加入模板推荐的角色
    for (const id of selectedMinisters.value) {
      ministerSet.add(id)
    }
    selectedMinisters.value = ministerSet
  }

  showTemplateDialog.value = false
  selectedTemplate.value = null
}

function toggleSidebar() {
  showSidebar.value = !showSidebar.value
}

function summonMinister(ministerId: string) {
  debateStore.startPrivateAudience(ministerId)
}

function goToWelcome() {
  debateStore.activeSessionId = null
}

function goToHistorySearch() {
  router.push({ path: '/history', query: { search: '1' } })
}

function switchTab(id: string) {
  debateStore.switchSession(id)
}

function closeTab(id: string, event: Event) {
  event.stopPropagation()
  debateStore.closeSession(id)
}

// ============ Tab 右键菜单 ============

const tabContextMenu = ref<{ visible: boolean; x: number; y: number; sessionId: string }>({
  visible: false, x: 0, y: 0, sessionId: ''
})

function onTabContextMenu(event: MouseEvent, sessionId: string) {
  event.preventDefault()
  event.stopPropagation()
  tabContextMenu.value = { visible: true, x: event.clientX, y: event.clientY, sessionId }
  document.addEventListener('click', closeTabContextMenu, { once: true })
}

function closeTabContextMenu() {
  tabContextMenu.value.visible = false
}

async function handleRenameTab() {
  const sessionId = tabContextMenu.value.sessionId
  // 同时查找 sessions 和 debates
  const session = debateStore.sessions.find(s => s.id === sessionId)
  const debate = debateStore.debates.find(d => d.id === sessionId)
  const currentTopic = session?.topic || debate?.topic || ''
  if (!session && !debate) return
  try {
    const { value } = await ElMessageBox.prompt('输入新的会话名称', '重命名会话', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      inputValue: currentTopic,
      inputValidator: (val: string) => val.trim().length > 0 || '名称不能为空'
    })
    debateStore.renameSession(sessionId, value)
  } catch { /* 取消 */ }
}

function handleDuplicateTab() {
  const sessionId = tabContextMenu.value.sessionId
  // 如果是历史记录，先 reopen
  debateStore.ensureSession(sessionId)
  debateStore.duplicateSession(sessionId)
}

function handleForkFromLast() {
  const sessionId = tabContextMenu.value.sessionId
  // 如果是历史记录，先 reopen
  const session = debateStore.ensureSession(sessionId)
  if (session && session.speeches.length > 1) {
    debateStore.forkSession(sessionId, session.speeches.length - 1)
  }
}

function handleDeleteDebate() {
  const sessionId = tabContextMenu.value.sessionId
  debateStore.deleteDebate(sessionId)
}

function getSessionIcon(session: { mode: string; topic: string }): string {
  if (session.mode === 'private') {
    // 从 topic 中提取角色名
    const name = session.topic.replace('召见', '')
    const minister = debateStore.ministers.find(m => m.name === name)
    return minister?.avatar || '💬'
  }
  return '🏛️'
}

function getMinisterLLMName(minister: typeof debateStore.ministers[0]): string {
  const llmId = (minister.llm as any).llmId
  if (llmId) {
    const config = llmService.getById(llmId)
    if (config?.name) return config.name
    if (config?.model) return config.model
  }
  return minister.llm.model || '未配置'
}

// ============ 全局快捷键 ============

const topicInputRef = ref<{ focus: () => void } | null>(null)

function handleHomeKeydown(e: KeyboardEvent) {
  const ctrl = e.ctrlKey || e.metaKey
  // Ctrl+N 新建会话
  if (ctrl && e.key === 'n') {
    e.preventDefault()
    goToWelcome()
    // 等 DOM 更新后聚焦输入框
    setTimeout(() => topicInputRef.value?.focus(), 100)
  }
  // Ctrl+H 历史
  if (ctrl && e.key === 'h') {
    e.preventDefault()
    router.push('/history')
  }
  // Ctrl+, 设置
  if (ctrl && e.key === ',') {
    e.preventDefault()
    router.push('/settings')
  }
  // Ctrl+Shift+F 搜索历史
  if (ctrl && e.shiftKey && e.key === 'F') {
    e.preventDefault()
    goToHistorySearch()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleHomeKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleHomeKeydown)
})
</script>

<template>
  <div class="app-layout">
  <!-- 主工作区（横向：工具条 + 内容） -->
  <div class="app-workspace">
  <!-- Left Toolbar -->
  <div v-if="showLeftToolbar" class="left-toolbar">
    <div class="toolbar-top">
      <button class="toolbar-icon-btn" title="首页" @click="goToWelcome">
        <el-icon :size="20"><House /></el-icon>
      </button>
      <button class="toolbar-icon-btn" title="历史朝议" @click="router.push('/history')">
        <el-icon :size="20"><Clock /></el-icon>
      </button>
      <button class="toolbar-icon-btn" title="搜索历史会话" @click="goToHistorySearch">
        <el-icon :size="20"><Search /></el-icon>
      </button>
    </div>
    <div class="toolbar-bottom">
      <button class="toolbar-icon-btn" title="设置" @click="router.push('/settings')">
        <el-icon :size="20"><Setting /></el-icon>
      </button>
      <button class="toolbar-icon-btn" title="关于" @click="showAboutDialog = true">
        <el-icon :size="20"><InfoFilled /></el-icon>
      </button>
      <button class="toolbar-icon-btn" title="登录" @click="handleLoginClick">
        <el-icon :size="20"><User /></el-icon>
      </button>
    </div>
  </div>

  <div class="chat-container">
    <!-- Sidebar -->
    <aside v-if="showSidebar" class="sidebar">
      <div class="sidebar-header">
        <el-button :icon="Fold" text @click="toggleSidebar" />
        <h1 class="app-title">朝堂</h1>
      </div>

      <el-button type="primary" class="new-chat-btn" @click="goToWelcome">
        <el-icon style="margin-right: 6px"><Plus /></el-icon>
        新的会话
      </el-button>

      <div class="history-section">
        <h3 class="section-title">历史朝议</h3>
        <el-scrollbar height="calc(100vh - 288px)">
          <div class="history-list">
            <div
              v-for="debate in recentDebates"
              :key="debate.id"
              class="history-item"
              :class="{ active: debate.id === debateStore.activeSessionId }"
              @click="debateStore.reopenSession(debate.id)"
              @contextmenu="onTabContextMenu($event, debate.id)"
            >
              <div class="history-title">{{ debate.topic }}</div>
              <div class="history-meta">
                {{ new Date(debate.createdAt).toLocaleDateString('zh-CN') }}
              </div>
            </div>
          </div>
        </el-scrollbar>
      </div>

    </aside>

    <!-- Main Content -->
    <main class="main-content" ref="mainContentRef">
      <div class="main-column">
      <!-- Tab Bar -->
      <div class="tab-bar">
        <div class="tab-bar-left" v-if="!showSidebar">
          <el-button :icon="Expand" text @click="toggleSidebar" size="small" />
        </div>

        <div class="tab-list">
          <div
            v-for="session in debateStore.sessions"
            :key="session.id"
            class="tab-item"
            :class="{ active: session.id === debateStore.activeSessionId }"
            @click="switchTab(session.id)"
            @contextmenu="onTabContextMenu($event, session.id)"
          >
            <span class="tab-icon">{{ getSessionIcon(session) }}</span>
            <span class="tab-label">{{ session.topic }}</span>
            <span class="tab-close" @click="closeTab(session.id, $event)">
              <el-icon :size="12"><Close /></el-icon>
            </span>
          </div>

          <div class="tab-item tab-add" @click="goToWelcome">
            <el-icon :size="14"><Plus /></el-icon>
          </div>
        </div>
        <div class="tab-bar-right">
          <button class="toolbar-icon-btn" :class="{ active: showRightPanel }" title="侧边面板" @click="toggleRightPanel">
            <el-icon :size="16"><Right v-if="showRightPanel" /><Back v-else /></el-icon>
          </button>
        </div>
      </div>

      <!-- Tab 右键菜单 -->
      <teleport to="body">
        <div
          v-if="tabContextMenu.visible"
          class="tab-context-menu"
          :style="{ left: tabContextMenu.x + 'px', top: tabContextMenu.y + 'px' }"
        >
          <div class="tab-context-item" @click="handleRenameTab">
            <el-icon :size="14"><Edit /></el-icon>
            <span>重命名</span>
          </div>
          <div class="tab-context-item" @click="handleDuplicateTab">
            <el-icon :size="14"><DocumentCopy /></el-icon>
            <span>复制会话</span>
          </div>
          <div class="tab-context-item" @click="handleForkFromLast">
            <el-icon :size="14"><Connection /></el-icon>
            <span>从此分叉</span>
          </div>
          <div class="tab-context-divider"></div>
          <div class="tab-context-item tab-context-danger" @click="handleDeleteDebate">
            <el-icon :size="14"><Delete /></el-icon>
            <span>删除</span>
          </div>
        </div>
      </teleport>

      <!-- Content Area -->
      <div class="content-area">
      <template v-if="debateStore.activeSession">
        <ChatSession :sessionId="debateStore.activeSessionId!" :key="debateStore.activeSessionId!" @open-task-panel="openTaskPanel" @open-attachment-panel="openAttachmentPanel" />
      </template>

      <!-- Welcome Page -->
      <template v-else>
        <div class="welcome-section">
          <div class="welcome-content">
            <h1 class="welcome-title">朝堂</h1>
            <p class="welcome-subtitle">百官进言，圣裁由你</p>

            <div class="ministers-grid">
              <el-card
                v-for="minister in debateStore.sortedMinisters"
                :key="minister.id"
                shadow="hover"
                class="minister-card"
                :class="{ selected: selectedMinisters.has(minister.id) }"
                :body-style="{ padding: '20px', display: 'flex', alignItems: 'center', gap: '16px' }"
                @click="summonMinister(minister.id)"
              >
                <div class="minister-checkbox" @click.stop>
                  <el-checkbox
                    :model-value="selectedMinisters.has(minister.id)"
                    @change="toggleMinisterSelection(minister.id)"
                  />
                </div>
                <div class="minister-avatar">{{ minister.avatar }}</div>
                <div class="minister-info">
                  <div class="minister-name">{{ minister.name }}</div>
                  <div class="minister-title">{{ minister.title }}</div>
                  <div class="minister-llm">{{ getMinisterLLMName(minister) }}</div>
                </div>
              </el-card>
            </div>
          </div>
        </div>

        <div class="input-section">
          <div
            class="input-container"
            :class="{ 'drag-over': isDraggingFiles }"
            @dragover="onDragOver"
            @dragleave="onDragLeave"
            @drop="onDropFiles"
          >
            <!-- 拖拽提示遮罩 -->
            <div v-if="isDraggingFiles" class="drop-overlay">
              <div class="drop-overlay-content">📎 释放文件以添加附件</div>
            </div>
            <!-- @ 选人弹出层 -->
            <div v-if="showMentionPopup" class="mention-popup">
              <div class="mention-title">选择大臣</div>
              <div
                v-for="minister in filteredMinisters"
                :key="minister.id"
                class="mention-item"
                @mousedown.prevent="selectMention(minister.id)"
              >
                <span class="mention-avatar">{{ minister.avatar }}</span>
                <span class="mention-name">{{ minister.name }}</span>
                <span class="mention-title-text">{{ minister.title }}</span>
              </div>
              <div v-if="filteredMinisters.length === 0" class="mention-empty">无匹配大臣</div>
            </div>

            <el-input
              ref="topicInputRef"
              v-model="topic"
              type="textarea"
              :autosize="{ minRows: 3, maxRows: 6 }"
              placeholder="陛下有何议题..."
              @keydown.enter.exact.prevent="startDebate"
              resize="none"
            />

            <!-- 附件列表 -->
            <div v-if="attachments.length > 0" class="attachment-chips">
              <div v-for="att in attachments" :key="att.id" class="attachment-chip">
                <span class="attachment-chip-icon">{{ att.fileType === 'pdf' ? '📄' : att.fileType === 'docx' || att.fileType === 'doc' ? '📝' : att.fileType === 'xlsx' || att.fileType === 'xls' ? '📊' : '📎' }}</span>
                <span class="attachment-chip-name" :title="att.filePath">{{ att.fileName }}</span>
                <span class="attachment-chip-size">{{ formatFileSize(att.fileSize) }}</span>
                <button class="attachment-chip-remove" @click="removeAttachment(att.id)">&times;</button>
              </div>
            </div>

            <div class="input-actions">
              <el-radio-group v-model="debateStore.debateMode" size="small">
                <el-radio-button value="serial">串行</el-radio-button>
                <el-radio-button value="parallel">并行</el-radio-button>
                <el-radio-button value="agent">Agent</el-radio-button>
              </el-radio-group>
              <div class="input-actions-right">
                <el-button
                  size="small"
                  :icon="FolderOpened"
                  :type="workingDirectory ? 'warning' : 'default'"
                  @click="browseWorkingDir"
                  :title="workingDirectory || '选择工作目录'"
                >
                  {{ workingDirectory ? workingDirName : '工作目录' }}
                </el-button>
                <el-button
                  size="small"
                  :loading="attachingFile"
                  @click="addAttachment"
                  title="添加附件（合同、文档等，供大臣审议）"
                >
                  📎 附件{{ attachments.length > 0 ? ` (${attachments.length})` : '' }}
                </el-button>
                <el-button
                  type="primary"
                  :icon="Promotion"
                  circle
                  :disabled="!topic.trim() && attachments.length === 0"
                  @click="startDebate"
                />
              </div>
            </div>
          </div>
          <div class="input-hint">
            <span class="template-picker-link" @click="openTemplateDialog">📋 选择模板</span>
            <span>按 Enter 发送，Shift + Enter 换行，输入 @ 可指定大臣 · Agent 模式自动拆解任务 · {{ selectedCount }}/{{ totalCount }} 角色参与</span>
          </div>
        </div>
      </template>
      </div>
      </div>

      <!-- Right Panel Resize Handle -->
      <div v-if="showRightPanel" class="resize-handle" @mousedown="startResizeRight"></div>

      <!-- Right Panel -->
      <div v-if="showRightPanel" class="right-panel" :style="{ width: rightPanelWidth + 'px' }">
        <div class="right-panel-header">
          <div class="right-panel-tabs">
            <button
              class="right-panel-tab"
              :class="{ active: rightPanelTab === 'tasks' }"
              @click="rightPanelTab = 'tasks'"
            >
              📋 任务{{ activeTaskCount > 0 ? ` (${activeTaskCount})` : '' }}
            </button>
            <button
              class="right-panel-tab"
              :class="{ active: rightPanelTab === 'attachments' }"
              @click="rightPanelTab = 'attachments'"
            >
              📎 附件{{ sessionAttachments.length > 0 ? ` (${sessionAttachments.length})` : '' }}
            </button>
          </div>
          <el-button text size="small" @click="toggleRightPanel">
            <el-icon><Right v-if="showRightPanel" /><Back v-else /></el-icon>
          </el-button>
        </div>

        <div class="right-panel-body">
          <!-- 任务列表 -->
          <template v-if="rightPanelTab === 'tasks'">
            <div v-if="sessionTasks.length === 0" class="panel-empty">
              <p>🕊️ 当前会话暂无关联任务</p>
              <p class="panel-empty-hint">拍板后的行动项、再上奏、长辩论等会显示在这里</p>
            </div>
            <div v-else class="task-list">
              <div v-for="task in sessionTasks" :key="task.id" class="task-card" :class="`task-status-${task.status}`">
                <div class="task-card-header">
                  <span class="task-status-icon">{{ getTaskStatusIcon(task.status) }}</span>
                  <span class="task-title">{{ task.title }}</span>
                </div>
                <div class="task-card-meta">
                  <el-tag size="small" :type="task.status === 'running' ? 'warning' : task.status === 'completed' ? 'success' : task.status === 'failed' ? 'danger' : 'info'">
                    {{ getTaskTypeLabel(task.type) }}
                  </el-tag>
                  <span class="task-status-label">{{ getTaskStatusLabel(task.status) }}</span>
                </div>
                <p class="task-desc">{{ task.description }}</p>
                <div class="task-card-footer">
                  <span class="task-time" v-if="task.lastRunAt">上次: {{ formatTime(task.lastRunAt) }}</span>
                  <span class="task-time" v-else>下次: {{ formatTime(task.nextRunAt) }}</span>
                  <span class="task-runs" v-if="task.runCount > 0">已执行 {{ task.runCount }} 次</span>
                  <el-button
                    v-if="task.status === 'pending' || task.status === 'running'"
                    size="small"
                    type="danger"
                    text
                    @click="cancelTask(task.id)"
                  >取消</el-button>
                </div>
                <div v-if="task.lastResult" class="task-result">
                  <div class="task-result-label">最近结果：</div>
                  <div class="task-result-content">{{ task.lastResult }}</div>
                </div>
                <div v-if="task.error" class="task-error">
                  ❌ {{ task.error }}
                </div>
              </div>
            </div>
          </template>

          <!-- 附件列表 -->
          <template v-if="rightPanelTab === 'attachments'">
            <div v-if="sessionAttachments.length === 0" class="panel-empty">
              <p>📎 当前会话暂无附件</p>
              <p class="panel-empty-hint">在会话输入区点击“附件”按钮或拖拽文件添加</p>
            </div>
            <div v-else class="panel-attachment-list">
              <div v-for="att in sessionAttachments" :key="att.id" class="panel-att-item">
                <div class="panel-att-icon">{{ att.fileType === 'pdf' ? '📄' : att.fileType === 'docx' || att.fileType === 'doc' ? '📝' : att.fileType === 'xlsx' || att.fileType === 'xls' ? '📊' : '📎' }}</div>
                <div class="panel-att-info">
                  <div class="panel-att-name" :title="att.filePath">{{ att.fileName }}</div>
                  <div class="panel-att-meta">{{ att.fileType.toUpperCase() }} · {{ att.fileSize < 1024 ? att.fileSize + ' B' : att.fileSize < 1048576 ? (att.fileSize / 1024).toFixed(1) + ' KB' : (att.fileSize / 1048576).toFixed(1) + ' MB' }} · {{ att.content?.length || 0 }} 字符</div>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </main>
  </div>
  </div>

  <!-- 底部状态栏 -->
  <div class="status-bar">
    <div class="status-bar-left">
      <span class="status-item" v-if="workingDirectory" :title="workingDirectory">
        <el-icon :size="12"><FolderOpened /></el-icon>
        <span>{{ workingDirName }}</span>
      </span>
      <span class="status-item status-theme" :title="'当前主题'">
        {{ currentThemeName }}
      </span>
    </div>
    <div class="status-bar-center">
      <span class="status-item" v-if="debateStore.activeSession" :title="'当前会话'">
        {{ getSessionIcon(debateStore.activeSession) }} {{ debateStore.activeSession.topic }}
      </span>
      <span class="status-item status-hint" v-else>朝堂 · 百官进言，圣裁由你</span>
    </div>
    <div class="status-bar-right">
      <span class="status-item status-mode" :title="'朝议模式'">
        {{ debateStore.debateMode === 'serial' ? '串行' : debateStore.debateMode === 'parallel' ? '并行' : 'Agent' }}
      </span>
      <span class="status-item" :title="'打开的会话数'">
        {{ debateStore.sessions.length }} 个会话
      </span>
      <!-- 预留按钮插槽 -->
      <slot name="status-actions"></slot>
    </div>
  </div>
  </div>

  <!-- 主题模板库对话框 -->
  <el-dialog v-model="showTemplateDialog" title="📋 议题模板库" width="680px" align-center>
    <div class="template-dialog-body">
      <!-- 分类标签 -->
      <div class="template-categories">
        <el-radio-group v-model="templateCategory" size="small">
          <el-radio-button v-for="cat in templateCategories" :key="cat.id" :value="cat.id">
            {{ cat.icon }} {{ cat.name }}
          </el-radio-button>
        </el-radio-group>
      </div>

      <!-- 模板列表 -->
      <div v-if="!selectedTemplate" class="template-grid">
        <div
          v-for="tpl in filteredTemplates"
          :key="tpl.id"
          class="template-card"
          @click="pickTemplate(tpl)"
        >
          <div class="template-card-header">
            <span class="template-icon">{{ tpl.icon }}</span>
            <span class="template-name">{{ tpl.name }}</span>
            <el-tag v-if="tpl.recommendedMode" size="small" type="info" class="template-mode-tag">
              {{ tpl.recommendedMode === 'agent' ? 'Agent' : tpl.recommendedMode === 'parallel' ? '并行' : tpl.recommendedMode === 'serial' ? '串行' : '朝议' }}
            </el-tag>
          </div>
          <p class="template-desc">{{ tpl.topic || '自由议题，由圣上亲自拟定' }}</p>
          <div v-if="tpl.recommendedMinisters && tpl.recommendedMinisters.length > 0" class="template-ministers">
            推荐角色：{{ tpl.recommendedMinisters.length }} 位
          </div>
        </div>
      </div>

      <!-- 占位符填充 -->
      <div v-else class="template-placeholder-form">
        <div class="template-placeholder-header">
          <span class="template-icon">{{ selectedTemplate.icon }}</span>
          <div>
            <h3>{{ selectedTemplate.name }}</h3>
            <p class="template-placeholder-topic">{{ selectedTemplate.topic }}</p>
          </div>
        </div>
        <div class="template-placeholder-inputs">
          <div v-for="ph in selectedTemplate.placeholders" :key="ph.key" class="placeholder-field">
            <label>{{ ph.label }}</label>
            <el-input
              v-model="placeholderValues[ph.key]"
              :placeholder="ph.defaultValue || '请输入'"
              size="default"
              @keydown.enter.prevent="confirmPlaceholder"
            />
          </div>
        </div>
        <div class="template-placeholder-actions">
          <el-button @click="selectedTemplate = null">返回</el-button>
          <el-button type="primary" @click="confirmPlaceholder">应用模板</el-button>
        </div>
      </div>
    </div>
  </el-dialog>

  <!-- About 弹窗 -->
  <el-dialog v-model="showAboutDialog" title="" :show-close="true" width="420px" class="about-dialog" align-center>
    <div class="about-content">
      <div class="about-logo">🏛️</div>
      <h2 class="about-title">朝堂</h2>
      <p class="about-version">v0.1.0</p>
      <p class="about-slogan">百官进言，圣裁由你</p>
      <div class="about-divider"></div>
      <p class="about-desc">多角色辩论式 AI 决策辅助平台</p>
      <div class="about-stack">
        <span class="about-tag">Vue 3</span>
        <span class="about-tag">TypeScript</span>
        <span class="about-tag">Element Plus</span>
        <span class="about-tag">Electron</span>
        <span class="about-tag">Pinia</span>
      </div>
      <div class="about-divider"></div>
      <div class="about-features">
        <div class="about-feature-row">
          <span>🎭 多角色辩论</span>
          <span>🔧 Agent 工具链</span>
        </div>
        <div class="about-feature-row">
          <span>🧠 持久记忆</span>
          <span>📂 代码搜索</span>
        </div>
        <div class="about-feature-row">
          <span>🌿 Git 集成</span>
          <span>🧪 测试循环</span>
        </div>
      </div>
      <div class="about-divider"></div>
      <p class="about-copyright">© 2026 ChaoTang · Made with Dr. Jiang</p>
      <div class="about-links">
        <a class="about-link" href="mailto:2836478@qq.com">
          <span class="about-link-icon">✉</span>
          <span>2836478@qq.com</span>
        </a>
        <a class="about-link" href="https://github.com/jillsoft-com/chaotang" target="_blank">
          <span class="about-link-icon">⚡</span>
          <span>GitHub</span>
        </a>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.app-workspace {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.chat-container {
  display: flex;
  flex: 1;
  overflow: hidden;
  background: var(--ct-bg);
}

/* Sidebar */
.sidebar {
  width: 260px;
  background: var(--ct-bg-secondary);
  border-right: 1px solid var(--ct-border);
  display: flex;
  flex-direction: column;
  transition: all 0.3s;
}

.sidebar-header {
  padding: 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--ct-border);
}

.app-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--ct-accent);
  margin: 0;
}

.new-chat-btn {
  margin: 16px;
  width: calc(100% - 32px);
}

.history-section {
  flex: 1;
  overflow: hidden;
  padding: 0 16px;
}

.section-title {
  font-size: 12px;
  color: var(--ct-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 16px 0 8px;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-bottom: 16px;
}

.history-item {
  padding: 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
}

.history-item:hover {
  background: var(--ct-bg-tertiary);
}

.history-item.active {
  background: var(--ct-bg-tertiary);
  border-left: 3px solid var(--ct-accent);
  padding-left: 9px;
}

.history-item.active .history-title {
  color: var(--ct-accent);
  font-weight: 600;
}

.history-title {
  font-size: 14px;
  color: var(--ct-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-meta {
  font-size: 12px;
  color: var(--ct-text-muted);
  margin-top: 4px;
}

/* Main Content */
.main-content {
  flex: 1;
  display: flex;
  flex-direction: row;
  overflow: hidden;
}

.content-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.main-column {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Tab Bar */
.tab-bar {
  display: flex;
  align-items: center;
  background: var(--ct-bg-secondary);
  border-bottom: 1px solid var(--ct-border);
  min-height: 40px;
  padding: 0 8px;
}

.tab-bar-right {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  padding-left: 4px;
}

.tab-bar-right .toolbar-icon-btn {
  width: 28px;
  height: 28px;
}

.tab-bar-left {
  padding-right: 4px;
}

.tab-list {
  display: flex;
  align-items: center;
  gap: 2px;
  overflow-x: auto;
  flex: 1;
}

.tab-list::-webkit-scrollbar {
  height: 0;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  cursor: pointer;
  border-radius: 8px 8px 0 0;
  font-size: 13px;
  color: var(--ct-text-secondary);
  white-space: nowrap;
  transition: all 0.2s;
  position: relative;
  max-width: 200px;
}

.tab-item:hover {
  background: var(--ct-bg-tertiary);
  color: var(--ct-text-primary);
}

.tab-item.active {
  background: var(--ct-bg);
  color: var(--ct-accent);
  font-weight: 500;
}

.tab-item.active::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--ct-accent);
}

.tab-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 130px;
}

.tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  flex-shrink: 0;
  opacity: 0;
  transition: all 0.15s;
}

.tab-item:hover .tab-close {
  opacity: 0.6;
}

.tab-close:hover {
  opacity: 1 !important;
  background: var(--ct-border);
}

.tab-add {
  padding: 8px 10px;
  opacity: 0.5;
}

.tab-add:hover {
  opacity: 1;
}

/* Welcome */
.content-area .welcome-section {
  flex: 1;
  overflow-y: auto;
  padding: 40px 20px;
}

/* Left Toolbar */
.left-toolbar {
  width: 48px;
  background: var(--ct-bg-secondary);
  border-right: 1px solid var(--ct-border);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  flex-shrink: 0;
}

.toolbar-top,
.toolbar-bottom {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.toolbar-icon-btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--ct-text-secondary);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
}

.toolbar-icon-btn:hover {
  background: var(--ct-bg-tertiary);
  color: var(--ct-text-primary);
}

.toolbar-icon-btn.active {
  background: var(--ct-bg-tertiary);
  color: var(--ct-accent);
}

/* Right Panel */
.resize-handle {
  width: 2px;
  cursor: col-resize;
  background: transparent;
  flex-shrink: 0;
  transition: background 0.2s;
}

.resize-handle:hover {
  background: var(--ct-accent);
}

.right-panel {
  background: var(--ct-bg-secondary);
  border-left: 1px solid var(--ct-border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow: hidden;
}

.right-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--ct-border);
  font-size: 14px;
  font-weight: 500;
  color: var(--ct-text-primary);
  min-height: 40px;
}

.right-panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

/* 右侧面板 - 标签页 */
.right-panel-tabs {
  display: flex;
  gap: 2px;
  flex: 1;
}

.right-panel-tab {
  padding: 4px 12px;
  border: none;
  background: transparent;
  color: var(--ct-text-secondary);
  font-size: 13px;
  cursor: pointer;
  border-radius: 6px;
  transition: all 0.15s;
  white-space: nowrap;
}

.right-panel-tab:hover {
  background: var(--ct-bg-tertiary);
  color: var(--ct-text-primary);
}

.right-panel-tab.active {
  background: var(--ct-bg-tertiary);
  color: var(--ct-accent);
  font-weight: 500;
}

/* 空状态 */
.panel-empty {
  text-align: center;
  padding: 32px 12px;
  color: var(--ct-text-muted);
}

.panel-empty p {
  margin: 4px 0;
  font-size: 13px;
}

.panel-empty-hint {
  font-size: 12px !important;
  opacity: 0.7;
}

/* 任务卡片 */
.task-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.task-card {
  padding: 10px 12px;
  border: 1px solid var(--ct-border);
  border-radius: 8px;
  background: var(--ct-bg);
  transition: all 0.15s;
}

.task-card:hover {
  border-color: var(--ct-accent);
}

.task-card.task-status-running {
  border-color: rgba(212, 175, 55, 0.4);
  box-shadow: 0 0 8px rgba(212, 175, 55, 0.08);
}

.task-card.task-status-failed {
  border-color: rgba(239, 68, 68, 0.3);
}

.task-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.task-status-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.task-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ct-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.task-status-label {
  font-size: 11px;
  color: var(--ct-text-muted);
}

.task-desc {
  font-size: 12px;
  color: var(--ct-text-secondary);
  margin: 0 0 6px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.task-card-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--ct-text-muted);
}

.task-card-footer .el-button {
  margin-left: auto;
  padding: 0 4px;
  font-size: 11px;
}

.task-result {
  margin-top: 6px;
  padding: 6px 8px;
  background: var(--ct-bg-secondary);
  border-radius: 4px;
  font-size: 11px;
}

.task-result-label {
  color: var(--ct-text-muted);
  margin-bottom: 2px;
}

.task-result-content {
  color: var(--ct-text-secondary);
  line-height: 1.4;
  white-space: pre-wrap;
  max-height: 80px;
  overflow-y: auto;
}

.task-error {
  margin-top: 6px;
  padding: 4px 8px;
  background: rgba(239, 68, 68, 0.08);
  border-radius: 4px;
  font-size: 11px;
  color: #ef4444;
}

/* 附件面板 */
.panel-attachment-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.panel-att-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--ct-border);
  border-radius: 8px;
  background: var(--ct-bg);
}

.panel-att-icon {
  font-size: 20px;
  flex-shrink: 0;
}

.panel-att-info {
  flex: 1;
  min-width: 0;
}

.panel-att-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ct-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel-att-meta {
  font-size: 11px;
  color: var(--ct-text-muted);
  margin-top: 2px;
}

.welcome-content {
  max-width: 800px;
  margin: 0 auto;
  text-align: center;
}

.welcome-title {
  font-size: 48px;
  font-weight: 700;
  color: var(--ct-accent);
  margin-bottom: 8px;
}

.welcome-subtitle {
  font-size: 18px;
  color: var(--ct-text-secondary);
  margin-bottom: 48px;
}

.ministers-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin-bottom: 48px;
}

.minister-card {
  --el-card-bg-color: var(--ct-bg-secondary);
  --el-card-border-color: var(--ct-border);
  transition: all 0.2s;
  cursor: pointer;
  position: relative;
}

.minister-card:hover {
  border-color: var(--ct-accent) !important;
  transform: translateY(-2px);
}

.minister-card.selected {
  border-color: var(--ct-accent) !important;
  box-shadow: 0 0 12px rgba(212, 175, 55, 0.15);
}

.minister-checkbox {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1;
}

.minister-avatar { font-size: 36px; }

.minister-info { text-align: left; }

.minister-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--ct-text-primary);
}

.minister-title {
  font-size: 13px;
  color: var(--ct-text-secondary);
  margin-top: 4px;
}

.minister-llm {
  font-size: 11px;
  color: var(--ct-text-muted);
  margin-top: 4px;
  opacity: 0.8;
}

/* Input */
.input-section {
  padding: 20px;
  background: var(--ct-bg);
  border-top: 1px solid var(--ct-border);
}

.input-container {
  max-width: 800px;
  margin: 0 auto;
  background: var(--ct-bg-secondary);
  border: 1px solid var(--ct-border);
  border-radius: 12px;
  padding: 16px;
  transition: all 0.2s;
}

.input-container:focus-within { border-color: var(--ct-accent); }

.input-container :deep(.el-textarea__inner) {
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0;
  color: var(--ct-text-primary);
  font-size: 16px;
}

.input-container :deep(.el-textarea__inner::placeholder) {
  color: var(--ct-text-muted);
}

.input-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 12px;
}

.input-actions-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.input-hint {
  max-width: 800px;
  margin: 8px auto 0;
  text-align: center;
  font-size: 12px;
  color: var(--ct-text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.template-picker-link {
  color: var(--ct-accent);
  cursor: pointer;
  font-weight: 500;
  transition: opacity 0.2s;
  white-space: nowrap;
}

.template-picker-link:hover {
  opacity: 0.8;
  text-decoration: underline;
}

/* 模板库对话框 */
.template-dialog-body {
  min-height: 300px;
}

.template-categories {
  margin-bottom: 16px;
  text-align: center;
}

.template-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  max-height: 400px;
  overflow-y: auto;
  padding-right: 4px;
}

.template-card {
  padding: 14px;
  border: 1px solid var(--ct-border);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s;
  background: var(--ct-bg);
}

.template-card:hover {
  border-color: var(--ct-accent);
  box-shadow: 0 2px 8px rgba(212, 175, 55, 0.12);
  transform: translateY(-1px);
}

.template-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.template-icon {
  font-size: 20px;
}

.template-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--ct-text-primary);
}

.template-mode-tag {
  margin-left: auto;
}

.template-desc {
  font-size: 12px;
  color: var(--ct-text-secondary);
  margin: 0 0 6px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.template-ministers {
  font-size: 11px;
  color: var(--ct-text-muted);
}

/* 占位符填充表单 */
.template-placeholder-form {
  padding: 8px 0;
}

.template-placeholder-header {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 20px;
}

.template-placeholder-header h3 {
  margin: 0;
  font-size: 16px;
  color: var(--ct-text-primary);
}

.template-placeholder-topic {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--ct-text-muted);
  line-height: 1.5;
}

.template-placeholder-inputs {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 20px;
}

.placeholder-field label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--ct-text-secondary);
  margin-bottom: 4px;
}

.template-placeholder-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* @ Mention Popup */
.mention-popup {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  background: var(--ct-bg-secondary);
  border: 1px solid var(--ct-border);
  border-radius: 8px;
  margin-bottom: 8px;
  max-height: 240px;
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

.input-container {
  position: relative;
}

@media (max-width: 768px) {
  .sidebar {
    position: absolute;
    z-index: 10;
    height: 100%;
  }
  .ministers-grid {
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }
}

/* Tab 右键菜单 */
.tab-context-menu {
  position: fixed;
  z-index: 9999;
  background: var(--ct-bg-secondary);
  border: 1px solid var(--ct-border);
  border-radius: 8px;
  padding: 4px 0;
  min-width: 140px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  animation: contextMenuFadeIn 0.12s ease-out;
}

@keyframes contextMenuFadeIn {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}

.tab-context-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  font-size: 13px;
  color: var(--ct-text-primary);
  cursor: pointer;
  transition: background 0.15s;
}

.tab-context-item:hover {
  background: var(--ct-bg-tertiary);
  color: var(--ct-accent);
}

.tab-context-divider {
  height: 1px;
  background: var(--ct-border);
  margin: 4px 8px;
}

.tab-context-danger {
  color: #e74c3c;
}

.tab-context-danger:hover {
  background: rgba(231, 76, 60, 0.1);
  color: #c0392b;
}

/* 底部状态栏 */
.status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 28px;
  min-height: 28px;
  padding: 0 12px;
  background: var(--ct-bg-secondary);
  border-top: 1px solid var(--ct-border);
  font-size: 12px;
  color: var(--ct-text-muted);
  user-select: none;
  flex-shrink: 0;
}

.status-bar-left,
.status-bar-center,
.status-bar-right {
  display: flex;
  align-items: center;
  gap: 12px;
  overflow: hidden;
}

.status-bar-left {
  flex-shrink: 0;
}

.status-bar-center {
  flex: 1;
  justify-content: center;
  min-width: 0;
}

.status-bar-right {
  flex-shrink: 0;
}

.status-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.status-hint {
  color: var(--ct-text-muted);
  opacity: 0.6;
}

.status-theme {
  opacity: 0.8;
}

.status-mode {
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--ct-bg-tertiary);
  font-weight: 500;
  color: var(--ct-text-secondary);
}

/* About 弹窗 */
.about-dialog :deep(.el-dialog) {
  border-radius: 16px;
  background: var(--ct-bg-secondary);
  border: 1px solid var(--ct-border);
  overflow: hidden;
}

.about-dialog :deep(.el-dialog__header) {
  display: none;
}

.about-dialog :deep(.el-dialog__body) {
  padding: 24px 32px;
}

.about-content {
  text-align: center;
  padding: 8px 0;
}

.about-logo {
  font-size: 56px;
  margin-bottom: 8px;
}

.about-title {
  font-size: 28px;
  font-weight: 700;
  color: var(--ct-accent);
  margin: 0;
  letter-spacing: 4px;
}

.about-version {
  font-size: 13px;
  color: var(--ct-text-muted);
  margin: 4px 0 0;
}

.about-slogan {
  font-size: 15px;
  color: var(--ct-text-secondary);
  margin: 12px 0 0;
  font-style: italic;
}

.about-divider {
  height: 1px;
  background: var(--ct-border);
  margin: 16px 0;
}

.about-desc {
  font-size: 14px;
  color: var(--ct-text-primary);
  margin: 0;
}

.about-stack {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 12px;
}

.about-tag {
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 12px;
  background: var(--ct-bg-tertiary);
  color: var(--ct-text-secondary);
  border: 1px solid var(--ct-border);
}

.about-features {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.about-feature-row {
  display: flex;
  justify-content: center;
  gap: 24px;
  font-size: 13px;
  color: var(--ct-text-secondary);
}

.about-copyright {
  font-size: 12px;
  color: var(--ct-text-muted);
  margin: 0;
}

.about-links {
  display: flex;
  justify-content: center;
  gap: 20px;
  margin-top: 10px;
}

.about-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--ct-accent);
  text-decoration: none;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--ct-border);
  background: var(--ct-bg-tertiary);
  transition: all 0.2s;
}

.about-link:hover {
  border-color: var(--ct-accent);
  background: rgba(212, 175, 55, 0.1);
}

.about-link-icon {
  font-size: 13px;
}

/* ============ 附件列表 ============ */

.attachment-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 0 4px;
}

.attachment-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 16px;
  background: var(--ct-bg-tertiary, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--ct-border, rgba(255, 255, 255, 0.08));
  font-size: 12px;
  color: var(--ct-text-secondary, #9ca3af);
  max-width: 240px;
}

.attachment-chip-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.attachment-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
  color: var(--ct-text-primary, #e5e7eb);
}

.attachment-chip-size {
  font-size: 11px;
  color: var(--ct-text-muted, #6b7280);
  flex-shrink: 0;
}

.attachment-chip-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  background: transparent;
  color: var(--ct-text-muted, #6b7280);
  cursor: pointer;
  border-radius: 50%;
  font-size: 14px;
  line-height: 1;
  padding: 0;
  flex-shrink: 0;
  transition: all 0.15s;
}

.attachment-chip-remove:hover {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
}

/* ============ 拖拽文件 ============ */

.input-container.drag-over {
  border-color: var(--ct-accent);
  box-shadow: 0 0 0 2px rgba(212, 175, 55, 0.25);
}

.drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  border-radius: 12px;
  backdrop-filter: blur(2px);
  pointer-events: none;
  animation: fadeIn 0.15s ease;
}

.drop-overlay-content {
  font-size: 16px;
  font-weight: 600;
  color: var(--ct-accent);
  padding: 12px 24px;
  border: 2px dashed var(--ct-accent);
  border-radius: 12px;
  background: rgba(212, 175, 55, 0.08);
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
