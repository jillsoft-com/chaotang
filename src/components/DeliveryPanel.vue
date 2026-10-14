<template>
  <div class="delivery-panel-wrapper">
    <div class="delivery-panel">
      <!-- 头部 -->
      <header class="delivery-header">
        <h3 class="delivery-title">📦 交付审阅</h3>
        <div class="delivery-meta">
          <span v-if="report.durationMs" class="delivery-time">
            耗时 {{ formatDuration(report.durationMs) }}
          </span>
          <span v-if="report.repairsUsed > 0" class="delivery-repairs">
            🔧 修复 {{ report.repairsUsed }} 次
          </span>
        </div>
      </header>

      <!-- 1. 文件变更列表 -->
      <section class="delivery-section">
        <h4 class="delivery-section-title" @click="filesExpanded = !filesExpanded">
          <span>📝 文件变更 ({{ report.changedFiles.length }})</span>
          <span class="delivery-toggle">{{ filesExpanded ? '▾' : '▸' }}</span>
        </h4>
        <div v-if="filesExpanded" class="delivery-files">
          <div v-if="report.changedFiles.length === 0" class="delivery-empty">
            无文件变更
          </div>
          <div
            v-for="file in report.changedFiles"
            :key="file.path"
            class="delivery-file-item"
          >
            <div class="delivery-file-header" @click="toggleFileDiff(file.path)">
              <span class="delivery-file-icon">{{ file.status === 'created' ? '🆕' : '✏️' }}</span>
              <span class="delivery-file-path" :title="file.path">{{ shortenPath(file.path) }}</span>
              <span class="delivery-file-stats">
                <span class="delivery-file-added">+{{ file.linesAdded }}</span>
                <span class="delivery-file-removed">-{{ file.linesRemoved }}</span>
              </span>
              <span class="delivery-toggle">{{ expandedFiles.has(file.path) ? '▾' : '▸' }}</span>
            </div>
            <!-- 行级 diff -->
            <div v-if="expandedFiles.has(file.path)" class="delivery-file-diff">
              <div v-if="!file.oldContent && !file.newContent" class="delivery-diff-empty">
                无内容差异数据
              </div>
              <pre v-else class="delivery-diff-pre"><template v-for="line in computeDiffLines(file)" :key="line.prefix + line.text.slice(0, 20)"><span :class="line.cls">{{ line.prefix }}{{ line.text }}
</span></template></pre>
            </div>
          </div>
        </div>
      </section>

      <!-- 2. 验收结果 -->
      <section class="delivery-section">
        <h4 class="delivery-section-title">
          <span>
            {{ acceptanceIcon }} 验收结果
            <span class="delivery-state-badge" :class="'state-' + report.acceptanceState">
              {{ stateLabel(report.acceptanceState) }}
            </span>
          </span>
        </h4>
        <div v-if="report.acceptanceChecks.length === 0" class="delivery-empty">
          无验收检查
        </div>
        <div v-else class="delivery-checks">
          <div
            v-for="(check, i) in report.acceptanceChecks"
            :key="i"
            class="delivery-check-item"
          >
            <span class="delivery-check-icon">{{ check.status === 'passed' ? '✅' : check.status === 'failed' ? '❌' : '⚠️' }}</span>
            <span class="delivery-check-kind">[{{ check.kind }}]</span>
            <span class="delivery-check-cmd">{{ check.command || '未知' }}</span>
            <span v-if="check.exitCode !== undefined" class="delivery-check-exit">
              退出码 {{ check.exitCode }}
            </span>
            <span v-if="check.finishedAt && check.startedAt" class="delivery-check-duration">
              {{ check.finishedAt - check.startedAt }}ms
            </span>
            <div v-if="check.summary && check.summary !== '通过'" class="delivery-check-summary">
              {{ check.summary }}
            </div>
          </div>
        </div>
      </section>

      <!-- 3. 未完成事项 -->
      <section v-if="report.unresolvedQuestions.length > 0" class="delivery-section">
        <h4 class="delivery-section-title">
          <span>⚠️ 待关注事项 ({{ report.unresolvedQuestions.length }})</span>
        </h4>
        <ul class="delivery-questions">
          <li v-for="(q, i) in report.unresolvedQuestions" :key="i">{{ q }}</li>
        </ul>
      </section>

      <!-- 4. 操作按钮 -->
      <footer class="delivery-actions">
        <el-button type="primary" size="small" @click="handleConfirm">
          ✅ 确认交付
        </el-button>
        <el-button
          v-if="canRevert"
          type="danger"
          plain
          size="small"
          :loading="isReverting"
          @click="handleRevert"
        >
          ↩️ 撤销改动
        </el-button>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { DeliveryReport, FileChange } from '@/services/agent/delivery-report'

const props = defineProps<{
  report: DeliveryReport
}>()

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'revert'): void
}>()

// ============ 状态 ============

const filesExpanded = ref(true)
const expandedFiles = ref<Set<string>>(new Set())
const isReverting = ref(false)

// ============ 计算属性 ============

const canRevert = computed(() => {
  return props.report.changedFiles.length > 0 &&
    props.report.changedFiles.some(f => f.oldContent !== undefined)
})

const acceptanceIcon = computed(() => {
  switch (props.report.acceptanceState) {
    case 'passed': return '✅'
    case 'failed': return '❌'
    case 'unverified': return '⚠️'
    default: return '⏳'
  }
})

// ============ 方法 ============

function stateLabel(state: string): string {
  const map: Record<string, string> = {
    passed: '通过',
    failed: '失败',
    unverified: '未验证',
    pending: '等待中',
    running: '运行中'
  }
  return map[state] || state
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

function shortenPath(path: string): string {
  // 如果路径太长，截取最后两段
  const parts = path.replace(/\\/g, '/').split('/')
  if (parts.length <= 3) return path
  return '…/' + parts.slice(-2).join('/')
}

function toggleFileDiff(path: string) {
  const s = new Set(expandedFiles.value)
  if (s.has(path)) {
    s.delete(path)
  } else {
    s.add(path)
  }
  expandedFiles.value = s
}

interface DiffLine {
  cls: string
  prefix: string
  text: string
}

function computeDiffLines(file: FileChange): DiffLine[] {
  if (!file.oldContent && file.newContent) {
    // 新文件：全部为添加
    return file.newContent.split('\n').map(text => ({
      cls: 'diff-add',
      prefix: '+',
      text
    }))
  }

  if (file.oldContent && !file.newContent) {
    // 删除文件：全部为删除
    return file.oldContent.split('\n').map(text => ({
      cls: 'diff-remove',
      prefix: '-',
      text
    }))
  }

  if (!file.oldContent || !file.newContent) return []

  // 简单逐行 diff
  const oldLines = file.oldContent.split('\n')
  const newLines = file.newContent.split('\n')
  const lines: DiffLine[] = []

  // 使用简化 LCS：标记公共行
  const maxLen = Math.max(oldLines.length, newLines.length)
  if (maxLen > 500) {
    // 大文件只显示摘要
    lines.push({ cls: '', prefix: '', text: `（文件较大，省略 ${maxLen} 行差异详情）` })
    return lines
  }

  // 简化 diff：逐行对比
  const oldSet = new Set(oldLines)
  const newSet = new Set(newLines)

  // 先输出删除的行
  for (const line of oldLines) {
    if (!newSet.has(line)) {
      lines.push({ cls: 'diff-remove', prefix: '-', text: line })
    }
  }
  // 再输出新增的行
  for (const line of newLines) {
    if (!oldSet.has(line)) {
      lines.push({ cls: 'diff-add', prefix: '+', text: line })
    }
  }

  if (lines.length === 0) {
    lines.push({ cls: '', prefix: '', text: '（无行级差异，可能是格式变化）' })
  }

  return lines
}

async function handleConfirm() {
  emit('confirm')
  ElMessage.success('已确认交付')
}

async function handleRevert() {
  try {
    await ElMessageBox.confirm(
      '确定要撤销所有文件改动吗？这将恢复文件到修改前的状态。',
      '⚠️ 撤销确认',
      {
        confirmButtonText: '确认撤销',
        cancelButtonText: '取消',
        type: 'warning',
        distinguishCancelAndClose: true
      }
    )
    isReverting.value = true
    emit('revert')
  } catch {
    // 取消
  } finally {
    isReverting.value = false
  }
}
</script>

<style scoped>
.delivery-panel-wrapper {
  padding: 0 24px 12px;
  max-width: 1100px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}

.delivery-panel {
  border: 1px solid var(--ct-border);
  border-radius: 12px;
  padding: 18px;
  background: var(--ct-bg-secondary);
}

.delivery-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--ct-border);
  padding-bottom: 10px;
  margin-bottom: 12px;
}

.delivery-title {
  margin: 0;
  font-size: 18px;
  color: var(--ct-accent);
}

.delivery-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--ct-text-muted);
}

.delivery-repairs {
  color: #f59e0b;
}

.delivery-section {
  margin-bottom: 14px;
}

.delivery-section-title {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--ct-text-primary);
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
  user-select: none;
}

.delivery-toggle {
  font-size: 12px;
  color: var(--ct-text-muted);
}

.delivery-empty {
  color: var(--ct-text-muted);
  font-size: 13px;
  text-align: center;
  padding: 8px 0;
}

/* 文件列表 */
.delivery-files {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.delivery-file-item {
  border: 1px solid var(--ct-border);
  border-radius: 6px;
  overflow: hidden;
  background: var(--ct-bg);
}

.delivery-file-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  transition: background 0.15s;
}

.delivery-file-header:hover {
  background: var(--ct-bg-tertiary, rgba(255, 255, 255, 0.04));
}

.delivery-file-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.delivery-file-path {
  flex: 1;
  font-size: 13px;
  color: var(--ct-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'Consolas', 'Monaco', monospace;
}

.delivery-file-stats {
  display: flex;
  gap: 6px;
  font-size: 12px;
  font-family: 'Consolas', 'Monaco', monospace;
  flex-shrink: 0;
}

.delivery-file-added {
  color: #10b981;
}

.delivery-file-removed {
  color: #ef4444;
}

/* Diff 视图 */
.delivery-file-diff {
  border-top: 1px solid var(--ct-border);
  max-height: 300px;
  overflow: auto;
}

.delivery-diff-pre {
  margin: 0;
  padding: 8px;
  font-size: 12px;
  line-height: 1.5;
  font-family: 'Consolas', 'Monaco', monospace;
  white-space: pre-wrap;
  word-break: break-all;
}

.delivery-diff-pre .diff-add {
  background: rgba(16, 185, 129, 0.12);
  color: #10b981;
}

.delivery-diff-pre .diff-remove {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}

.delivery-diff-empty {
  padding: 8px;
  font-size: 12px;
  color: var(--ct-text-muted);
  text-align: center;
}

/* 验收检查 */
.delivery-checks {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.delivery-check-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--ct-bg);
  font-size: 13px;
  flex-wrap: wrap;
}

.delivery-check-icon {
  flex-shrink: 0;
}

.delivery-check-kind {
  color: var(--ct-text-muted);
  font-size: 12px;
  flex-shrink: 0;
}

.delivery-check-cmd {
  font-family: 'Consolas', 'Monaco', monospace;
  color: var(--ct-text-primary);
  font-size: 12px;
}

.delivery-check-exit {
  font-size: 11px;
  color: var(--ct-text-muted);
  flex-shrink: 0;
}

.delivery-check-duration {
  font-size: 11px;
  color: var(--ct-text-muted);
  flex-shrink: 0;
}

.delivery-check-summary {
  width: 100%;
  font-size: 12px;
  color: var(--ct-text-secondary);
  padding: 4px 8px;
  background: rgba(239, 68, 68, 0.06);
  border-radius: 3px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 120px;
  overflow: auto;
}

/* 状态徽章 */
.delivery-state-badge {
  display: inline-block;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 10px;
  margin-left: 6px;
  font-weight: 500;
}

.state-passed {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
}

.state-failed {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}

.state-unverified {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
}

.state-pending, .state-running {
  background: rgba(59, 130, 246, 0.15);
  color: #3b82f6;
}

/* 未解决问题 */
.delivery-questions {
  margin: 0;
  padding-left: 20px;
}

.delivery-questions li {
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--ct-text-secondary);
  line-height: 1.5;
}

/* 操作按钮 */
.delivery-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding-top: 12px;
  border-top: 1px solid var(--ct-border);
}
</style>
