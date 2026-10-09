<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useDebateStore } from '@/stores/debate'
import { ArrowLeft } from '@element-plus/icons-vue'

const router = useRouter()
const debateStore = useDebateStore()

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN')
}

function reopenDebate(id: string) {
  debateStore.reopenSession(id)
  router.push('/')
}
</script>

<template>
  <div class="history-container">
    <div class="history-content">
      <header class="history-header">
        <el-button :icon="ArrowLeft" text @click="router.push('/')" />
        <h1 class="history-title">朝议历史</h1>
      </header>

      <el-empty v-if="debateStore.debates.length === 0" description="暂无历史记录">
        <el-button type="primary" @click="router.push('/')">开始朝议</el-button>
      </el-empty>

      <div v-else class="history-list">
        <el-card
          v-for="debate in debateStore.debates"
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

          <div v-if="debate.imperialDecree" class="card-decree">
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
  margin-bottom: 32px;
}

.history-title {
  font-size: 28px;
  font-weight: 700;
  color: var(--ct-accent);
  margin: 0;
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
  margin-bottom: 16px;
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

.card-participants {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
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
