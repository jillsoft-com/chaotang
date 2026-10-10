<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useDebateStore } from '@/stores/debate'
import { ArrowLeft, Search, Plus } from '@element-plus/icons-vue'

const router = useRouter()
const route = useRoute()
const debateStore = useDebateStore()
const searchInputRef = ref<HTMLInputElement | null>(null)

// 如果 URL 带有 search=1 参数，自动聚焦搜索框
onMounted(() => {
  if (route.query.search === '1') {
    // 等 DOM 渲染后聚焦
    setTimeout(() => searchInputRef.value?.focus(), 100)
  }
})

// ============ 搜索与标签状态（Sprint A - #10） ============

const searchQuery = ref('')
const activeTags = ref<string[]>([])
const newTagInput = ref<Record<string, string>>({})  // debateId -> 输入中的标签文本

// 计算属性：基于搜索词 + 标签筛选后的结果
const filteredDebates = computed(() => {
  return debateStore.searchDebates(searchQuery.value, activeTags.value, 200)
})

// 全部标签（按使用次数降序）
const allTags = computed(() => debateStore.getAllTags())

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN')
}

function reopenDebate(id: string) {
  debateStore.reopenSession(id)
  router.push('/')
}

function toggleTagFilter(tag: string) {
  const idx = activeTags.value.indexOf(tag)
  if (idx >= 0) activeTags.value.splice(idx, 1)
  else activeTags.value.push(tag)
}

function clearFilters() {
  searchQuery.value = ''
  activeTags.value = []
}

/** 为某个朝议添加标签（通过输入框） */
function addTagToDebate(debateId: string) {
  const tag = (newTagInput.value[debateId] || '').trim()
  if (!tag) return
  debateStore.toggleDebateTag(debateId, tag)
  newTagInput.value[debateId] = ''
}

/** 切换某个朝议上的标签（点击已存在的标签即删除） */
function removeTagFromDebate(debateId: string, tag: string) {
  debateStore.toggleDebateTag(debateId, tag)
}

/** 从某条朝议中快速复用已有标签到筛选器 */
function useTagAsFilter(tag: string) {
  if (!activeTags.value.includes(tag)) activeTags.value.push(tag)
}
</script>

<template>
  <div class="history-container">
    <div class="history-content">
      <header class="history-header">
        <el-button :icon="ArrowLeft" text @click="router.push('/')" />
        <h1 class="history-title">朝议历史</h1>
        <span class="history-count">{{ filteredDebates.length }} / {{ debateStore.debates.length }}</span>
      </header>

      <!-- Sprint A - #10：搜索栏 + 标签筛选 -->
      <div v-if="debateStore.debates.length > 0" class="history-filters">
        <el-input
          ref="searchInputRef"
          v-model="searchQuery"
          placeholder="搜索议题、圣旨、发言内容、标签…"
          :prefix-icon="Search"
          clearable
          class="search-input"
        />
        <el-button v-if="searchQuery || activeTags.length > 0" text @click="clearFilters">
          清除筛选
        </el-button>
      </div>

      <div v-if="allTags.length > 0" class="history-tag-cloud">
        <span class="tag-cloud-label">标签：</span>
        <el-tag
          v-for="entry in allTags"
          :key="entry.tag"
          :type="activeTags.includes(entry.tag) ? 'primary' : 'info'"
          :effect="activeTags.includes(entry.tag) ? 'dark' : 'plain'"
          size="small"
          class="tag-cloud-item"
          @click="toggleTagFilter(entry.tag)"
        >
          {{ entry.tag }}
          <span class="tag-cloud-count">({{ entry.count }})</span>
        </el-tag>
      </div>

      <el-empty v-if="debateStore.debates.length === 0" description="暂无历史记录">
        <el-button type="primary" @click="router.push('/')">开始朝议</el-button>
      </el-empty>

      <el-empty
        v-else-if="filteredDebates.length === 0"
        description="没有匹配的历史朝议"
      >
        <el-button text @click="clearFilters">清除筛选条件</el-button>
      </el-empty>

      <div v-else class="history-list">
        <el-card
          v-for="debate in filteredDebates"
          :key="debate.id"
          shadow="hover"
          class="history-card"
          @click="reopenDebate(debate.id)"
        >
          <div class="card-header">
            <div class="card-info">
              <h2 class="card-title">{{ debate.topic }}</h2>
              <div class="card-meta">
                <span class="meta-item">{{ formatDate(debate.createdAt) }}</span>
                <el-tag size="small" effect="plain">
                  {{ debate.mode === 'court' ? '朝议模式' : debate.mode === 'private' ? '召见模式' : '对比模式' }}
                </el-tag>
              </div>
            </div>
            <el-tag
              :type="debate.status === 'completed' ? 'success' : 'warning'"
              effect="plain"
              size="small"
            >
              {{ debate.status === 'completed' ? '已完成' : '进行中' }}
            </el-tag>
          </div>

          <!-- 标签区（Sprint A - #10） -->
          <div class="card-tags" @click.stop>
            <el-tag
              v-for="tag in debate.tags || []"
              :key="tag"
              size="small"
              effect="plain"
              class="card-tag"
              closable
              @close="removeTagFromDebate(debate.id, tag)"
              @click="useTagAsFilter(tag)"
            >
              {{ tag }}
            </el-tag>
            <div class="card-tag-input" @click.stop>
              <el-input
                v-model="newTagInput[debate.id]"
                size="small"
                placeholder="+ 新标签"
                :prefix-icon="Plus"
                @keydown.enter.prevent="addTagToDebate(debate.id)"
                @keydown.esc="newTagInput[debate.id] = ''"
              />
            </div>
          </div>

          <div class="card-participants">
            <div
              v-for="speech in debate.speeches.slice(0, 6)"
              :key="speech.id"
              class="participant"
            >
              <span class="participant-avatar">
                {{ speech.ministerId === 'emperor' ? '🐲' : debateStore.ministers.find(m => m.id === speech.ministerId)?.avatar }}
              </span>
              <span class="participant-name">
                {{ speech.ministerId === 'emperor' ? '圣上' : debateStore.ministers.find(m => m.id === speech.ministerId)?.name }}
              </span>
            </div>
            <el-tag v-if="debate.speeches.length > 6" size="small" effect="plain">
              +{{ debate.speeches.length - 6 }}
            </el-tag>
          </div>

          <!-- 四象限报告摘要（Sprint A - #1） -->
          <div v-if="debate.decisionReport" class="card-report" @click.stop>
            <div class="report-title">📜 决策报告</div>
            <p v-if="debate.decisionReport.verdict" class="report-verdict">
              {{ debate.decisionReport.verdict }}
            </p>
            <div class="report-stats">
              <span class="stat stat-consensus">✅ 共识 {{ debate.decisionReport.consensus.length }}</span>
              <span class="stat stat-disagreements">⚔️ 分歧 {{ debate.decisionReport.disagreements.length }}</span>
              <span class="stat stat-risks">⚠️ 风险 {{ debate.decisionReport.risks.length }}</span>
              <span class="stat stat-assumptions">🔍 假设 {{ debate.decisionReport.assumptions.length }}</span>
            </div>
          </div>

          <div v-else-if="debate.imperialDecree" class="card-decree">
            <div class="decree-label">圣旨</div>
            <p class="decree-text">{{ debate.imperialDecree }}</p>
          </div>
        </el-card>
      </div>
    </div>
  </div>
</template>

<style scoped>
.history-container {
  min-height: 100vh;
  background: var(--ct-bg);
  padding: 24px;
}

.history-content {
  max-width: 1000px;
  margin: 0 auto;
}

.history-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
}

.history-title {
  font-size: 28px;
  font-weight: 700;
  color: var(--ct-accent);
  margin: 0;
}

.history-count {
  margin-left: auto;
  font-size: 13px;
  color: var(--ct-text-muted);
}

.history-filters {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 12px;
}

.search-input {
  flex: 1;
  max-width: 600px;
}

.history-tag-cloud {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 20px;
  padding: 10px 12px;
  background: var(--ct-bg-secondary);
  border-radius: 8px;
  border: 1px solid var(--ct-border);
}

.tag-cloud-label {
  font-size: 12px;
  color: var(--ct-text-muted);
  margin-right: 4px;
}

.tag-cloud-item {
  cursor: pointer;
  transition: transform 0.1s;
}

.tag-cloud-item:hover {
  transform: translateY(-1px);
}

.tag-cloud-count {
  margin-left: 4px;
  opacity: 0.7;
  font-size: 11px;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.history-card {
  --el-card-bg-color: var(--ct-bg-secondary);
  --el-card-border-color: var(--ct-border);
  cursor: pointer;
  transition: all 0.2s;
}

.history-card:hover {
  border-color: var(--ct-accent) !important;
  transform: translateY(-2px);
  box-shadow: 0 4px 12px var(--ct-card-shadow);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 12px;
}

.card-info {
  flex: 1;
}

.card-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--ct-text-primary);
  margin-bottom: 8px;
}

.card-meta {
  display: flex;
  gap: 12px;
  align-items: center;
}

.meta-item {
  font-size: 13px;
  color: var(--ct-text-secondary);
}

/* 标签区 */
.card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 8px 10px;
  margin-bottom: 12px;
  background: var(--ct-bg);
  border-radius: 8px;
  min-height: 40px;
}

.card-tag {
  cursor: pointer;
}

.card-tag-input {
  width: 120px;
}

.card-tag-input :deep(.el-input__wrapper) {
  box-shadow: none !important;
  background: transparent;
  border-bottom: 1px dashed var(--ct-border);
  border-radius: 0;
  padding: 0 4px;
}

.card-participants {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  padding: 12px;
  background: var(--ct-bg);
  border-radius: 8px;
}

.participant {
  display: flex;
  align-items: center;
  gap: 6px;
}

.participant-avatar {
  font-size: 20px;
}

.participant-name {
  font-size: 13px;
  color: var(--ct-text-primary);
}

/* 决策报告摘要 */
.card-report {
  border-top: 1px solid var(--ct-border);
  padding-top: 12px;
  margin-top: 4px;
}

.report-title {
  font-size: 13px;
  color: var(--ct-accent);
  margin-bottom: 6px;
  font-weight: 500;
}

.report-verdict {
  font-size: 13px;
  color: var(--ct-text-primary);
  line-height: 1.5;
  margin: 0 0 8px;
  padding: 6px 10px;
  background: rgba(212, 175, 55, 0.08);
  border-left: 3px solid var(--ct-accent);
  border-radius: 4px;
}

.report-stats {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
}

.stat {
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--ct-bg);
}

.stat-consensus { color: #10b981; }
.stat-disagreements { color: #f59e0b; }
.stat-risks { color: #ef4444; }
.stat-assumptions { color: #3b82f6; }

.card-decree {
  border-top: 1px solid var(--ct-border);
  padding-top: 16px;
}

.decree-label {
  font-size: 13px;
  color: var(--ct-accent);
  margin-bottom: 8px;
  font-weight: 500;
}

.decree-text {
  font-size: 14px;
  color: var(--ct-text-primary);
  line-height: 1.6;
  margin: 0;
}
</style>
