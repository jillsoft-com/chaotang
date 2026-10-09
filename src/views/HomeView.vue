<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useDebateStore } from '@/stores/debate'
import { Promotion, Setting, Fold, Expand, Plus, Close, House, Clock, Right, FolderOpened, Edit, DocumentCopy, Connection, Delete, User, InfoFilled } from '@element-plus/icons-vue'
import ChatSession from '@/components/ChatSession.vue'
import { llmService } from '@/services/llm-config'
import { ElMessageBox } from 'element-plus'

const router = useRouter()
const debateStore = useDebateStore()
const topic = ref('')
const showSidebar = ref(true)

// 角色选中状态
const selectedMinisters = ref<Set<string>>(new Set(debateStore.ministers.map(m => m.id)))

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
  if (!topic.value.trim()) return
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
  debateStore.startDebate(topic.value, 'court', ministersForSession, dir)
  topic.value = ''
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
      <button class="toolbar-icon-btn" title="历史朝议">
        <el-icon :size="20"><Clock /></el-icon>
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
            <el-icon :size="16"><Right /></el-icon>
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
        <ChatSession :sessionId="debateStore.activeSessionId!" :key="debateStore.activeSessionId!" />
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
          <div class="input-container">
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
              v-model="topic"
              type="textarea"
              :autosize="{ minRows: 3, maxRows: 6 }"
              placeholder="陛下有何议题..."
              @keydown.enter.exact.prevent="startDebate"
              resize="none"
            />

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
                  type="primary"
                  :icon="Promotion"
                  circle
                  :disabled="!topic.trim()"
                  @click="startDebate"
                />
              </div>
            </div>
          </div>
          <div class="input-hint">按 Enter 发送，Shift + Enter 换行，输入 @ 可指定大臣 · Agent 模式自动拆解任务 · {{ selectedCount }}/{{ totalCount }} 角色参与</div>
        </div>
      </template>
      </div>
      </div>

      <!-- Right Panel Resize Handle -->
      <div v-if="showRightPanel" class="resize-handle" @mousedown="startResizeRight"></div>

      <!-- Right Panel -->
      <div v-if="showRightPanel" class="right-panel" :style="{ width: rightPanelWidth + 'px' }">
        <div class="right-panel-header">
          <span>面板</span>
          <el-button text size="small" @click="toggleRightPanel">
            <el-icon><Close /></el-icon>
          </el-button>
        </div>
        <div class="right-panel-body">
          <p style="color: var(--ct-text-muted); font-size: 13px; text-align: center; margin-top: 40px;">
            预留区域
          </p>
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
</style>
