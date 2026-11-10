<template>
  <div class="task-tree-panel">
    <header class="tt-header" @click="collapsed = !collapsed">
      <div class="tt-header-left">
        <span class="tt-title">🌳 任务树</span>
        <span class="tt-state" :class="`tt-state-${tree.state}`">{{ stateLabel }}</span>
        <span class="tt-progress">
          {{ doneCount }}/{{ leafCount }} 完成
          <template v-if="failedCount > 0"> · {{ failedCount }} 失败</template>
        </span>
      </div>
      <div class="tt-header-right">
        <button
          v-if="canContinue"
          class="tt-continue-btn"
          title="继续执行未完成或失败的任务"
          @click.stop="emit('continue')"
        >▶ 继续未完成/失败</button>
        <span class="tt-caret">{{ collapsed ? '▸ 展开' : '▾ 收起' }}</span>
      </div>
    </header>

    <div v-show="!collapsed" class="tt-body">
      <div v-if="rows.length === 0" class="tt-empty">暂无任务节点</div>
      <div
        v-for="row in rows"
        :key="row.node.id"
        class="tt-row"
        :style="{ paddingLeft: `${row.depth * 16}px` }"
      >
        <div class="tt-row-main" @click="toggleDetail(row.node.id)">
          <span
            v-if="row.hasChildren"
            class="tw-caret"
            title="展开/收起子任务"
            @click.stop="toggleChildren(row.node.id)"
          >{{ collapsedNodes.has(row.node.id) ? '▸' : '▾' }}</span>
          <span v-else class="tw-caret tw-leaf">·</span>
          <span class="tt-dot" :class="`tt-dot-${row.node.status}`"></span>
          <span class="tt-node-title">{{ row.node.title }}</span>
          <span class="tt-badge" :class="`tt-badge-${row.node.status}`">{{ statusLabel(row.node.status) }}</span>
          <span
            v-if="row.node.acceptanceState === 'unverified'"
            class="tt-accept-tag"
            title="未配置自动检查，完成状态尚未经工具验证"
          >未验证</span>
          <span v-if="assigneeName(row.node.assigneeId)" class="tt-assignee">{{ assigneeName(row.node.assigneeId) }}</span>
          <button
            v-if="canContinue && isRetryable(row.node.status)"
            class="tt-retry-btn"
            title="重试该任务"
            @click.stop="emit('retry-node', row.node.id)"
          >↻ 重试</button>
          <span class="tt-expander">{{ openDetail.has(row.node.id) ? '收起' : '详情' }}</span>
        </div>
        <div v-if="openDetail.has(row.node.id)" class="tt-detail">
          <div v-if="row.node.description" class="tt-detail-item tt-detail-block">
            <span class="tt-detail-k">说明</span>
            <span class="tt-detail-v">{{ row.node.description }}</span>
          </div>
          <div class="tt-detail-item">
            <span class="tt-detail-k">状态</span>
            <span class="tt-detail-v">{{ statusLabel(row.node.status) }}<template v-if="row.node.waitingReason"> · {{ row.node.waitingReason }}</template></span>
          </div>
          <!-- 失败类终态的具体缘由：没这一行时面板只剩一个“失败”，无从判断是未达成目标还是执行报错 -->
          <div v-if="row.node.failureReason" class="tt-detail-item tt-detail-block">
            <span class="tt-detail-k">失败原因</span>
            <div class="tt-failure">{{ row.node.failureReason }}</div>
          </div>
          <div v-if="assigneeName(row.node.assigneeId)" class="tt-detail-item">
            <span class="tt-detail-k">执行者</span>
            <span class="tt-detail-v">{{ assigneeName(row.node.assigneeId) }}</span>
          </div>
          <div class="tt-detail-item">
            <span class="tt-detail-k">用量</span>
            <span class="tt-detail-v">迭代 {{ row.node.usage?.iterations ?? 0 }} · 工具 {{ row.node.usage?.toolCalls ?? 0 }} · 耗时 {{ formatMs(row.node.usage?.elapsedMs ?? 0) }}<template v-if="(row.node.attempt ?? 0) > 0"> · 已重试 {{ row.node.attempt }} 次</template></span>
          </div>
          <div v-if="row.node.acceptanceState" class="tt-detail-item">
            <span class="tt-detail-k">验收</span>
            <span class="tt-detail-v">{{ acceptanceLabel(row.node.acceptanceState) }}<template v-if="row.node.acceptanceState === 'unverified'"> · 未配置自动检查</template></span>
          </div>
          <div v-if="row.node.resultSummary" class="tt-detail-item tt-detail-block">
            <span class="tt-detail-k">执行结果</span>
            <div class="tt-result">{{ row.node.resultSummary }}</div>
          </div>
          <!-- 节点级成果：按任务列出改动过的文件，点开可看与改动前的行级差异 -->
          <div v-if="nodeFiles(row.node).length" class="tt-detail-item tt-detail-block">
            <span class="tt-detail-k">成果文件 ({{ nodeFiles(row.node).length }})</span>
            <div class="tt-files">
              <div v-for="f in nodeFiles(row.node)" :key="f.key" class="tt-file">
                <div class="tt-file-line" @click.stop="toggleNodeFile(f)">
                  <span>{{ f.isNew ? '🆕' : '✏️' }}</span>
                  <span class="tt-file-path" :title="f.abs">{{ f.path }}</span>
                  <span class="tt-expander">{{ expandedFile.has(f.key) ? '收起' : '查看改动' }}</span>
                </div>
                <div v-if="expandedFile.has(f.key)" class="tt-file-diff">
                  <div v-if="fileState[f.key] === 'loading'" class="tt-file-muted">读取中…</div>
                  <div v-else-if="fileState[f.key] === 'error'" class="tt-file-muted">读不到当前文件（可能已被移动或删除，或当前环境无本地文件读取能力）</div>
                  <pre v-else-if="fileDiff[f.key]" class="tt-diff-pre"><span
                    v-for="(line, i) in fileDiff[f.key]"
                    :key="i"
                    :class="line.cls"
                  >{{ line.prefix }}{{ line.text }}
</span></pre>
                </div>
              </div>
            </div>
          </div>
          <div v-if="row.node.acceptance && row.node.acceptance.length" class="tt-detail-item tt-detail-block">
            <span class="tt-detail-k">验收标准</span>
            <ul class="tt-detail-list">
              <li v-for="(a, i) in row.node.acceptance" :key="i">{{ a }}</li>
            </ul>
          </div>
          <div v-if="row.node.unresolvedQuestions && row.node.unresolvedQuestions.length" class="tt-detail-item tt-detail-block">
            <span class="tt-detail-k">未决问题</span>
            <ul class="tt-detail-list">
              <li v-for="(q, i) in row.node.unresolvedQuestions" :key="i">{{ q }}</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { TaskTreeSnapshot, TaskNode, TaskStatus, TreeState } from '@/services/agent/task-tree'
import type { Minister } from '@/types'

const props = defineProps<{
  tree: TaskTreeSnapshot
  ministers: Minister[]
  /** 外部每次 Agent 事件自增，用于强制重算（调度器原地修改节点状态，引用不变） */
  tick?: number
  /** 会话工作目录：节点里的成果文件多为相对路径，读盘看 diff 时需拼成绝对路径 */
  workingDirectory?: string
}>()

const emit = defineEmits<{
  (e: 'continue'): void
  (e: 'retry-node', nodeId: string): void
}>()

const collapsed = ref(false)
// collapsedNodes：已折叠子任务的节点 id；openDetail：已展开任务详情的节点 id
const collapsedNodes = ref<Set<string>>(new Set())
const openDetail = ref<Set<string>>(new Set())

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: '待处理',
  ready: '就绪',
  running: '执行中',
  awaiting_approval: '待批准',
  waiting: '等待',
  paused: '已暂停',
  interrupted: '已中断',
  completed: '已完成',
  partial: '部分完成',
  failed: '失败',
  blocked: '受阻',
  skipped: '已跳过',
  cancelled: '已取消'
}

const STATE_LABELS: Record<TreeState, string> = {
  planning: '规划中',
  awaiting_approval: '待批准',
  running: '执行中',
  paused: '已暂停',
  interrupted: '已中断',
  completed: '已完成',
  completed_with_gaps: '完成（有缺口）',
  failed: '失败',
  cancelled: '已取消'
}

// 验收状态（与任务状态解耦：任务可以已完成但验收未验证）
const ACCEPTANCE_LABELS: Record<string, string> = {
  passed: '已通过',
  failed: '未通过',
  unverified: '未验证',
  running: '验收中',
  pending: '待验收'
}

function acceptanceLabel(state: string): string {
  return ACCEPTANCE_LABELS[state] || state
}

function statusLabel(status: TaskStatus): string {
  return STATUS_LABELS[status] || status
}

const stateLabel = computed(() => STATE_LABELS[props.tree?.state] || props.tree?.state || '')

const nameById = computed(() => {
  const map: Record<string, string> = {}
  for (const m of props.ministers || []) map[m.id] = m.name
  return map
})

function assigneeName(id: string | null): string {
  if (!id) return ''
  return nameById.value[id] || id
}

interface TreeRow {
  node: TaskNode
  depth: number
  hasChildren: boolean
}

// 依赖 props.tick 触发重算：读原始 tree（scheduler 原地更新节点状态）
const rows = computed<TreeRow[]>(() => {
  void props.tick
  const tree = props.tree
  const out: TreeRow[] = []
  if (!tree || !tree.nodes) return out
  const walk = (id: string, depth: number) => {
    const node = tree.nodes[id]
    if (!node) return
    // 根节点仅展开其子节点，不单独占一行
    if (id !== tree.rootId) {
      out.push({ node, depth, hasChildren: node.childIds.length > 0 })
    }
    // 折叠的节点不再渲染其子节点
    if (collapsedNodes.value.has(id)) return
    const childDepth = id === tree.rootId ? depth : depth + 1
    for (const cid of node.childIds) walk(cid, childDepth)
  }
  walk(tree.rootId, 0)
  return out
})

const leafCount = computed(() => rows.value.filter(r => r.node.childIds.length === 0).length)
const doneCount = computed(() => rows.value.filter(r => r.node.status === 'completed').length)
const failedCount = computed(() => rows.value.filter(r => r.node.status === 'failed').length)

// 可重试的单节点状态（与 coordinator.resumeTaskTree 的 RESUMABLE_FROM 对齐）
const RETRYABLE_STATUSES: TaskStatus[] = ['failed', 'blocked', 'partial', 'paused', 'interrupted', 'waiting']
function isRetryable(status: TaskStatus): boolean {
  return RETRYABLE_STATUSES.includes(status)
}

// 是否存在未完成/失败而可继续的节点（含尚未执行的 pending/ready）
const hasResumable = computed(() => {
  void props.tick
  const tree = props.tree
  if (!tree || !tree.nodes) return false
  return Object.values(tree.nodes).some(
    n => n.id !== tree.rootId && (RETRYABLE_STATUSES.includes(n.status) || n.status === 'pending' || n.status === 'ready')
  )
})

// 仅在整树非执行中且存在可继续节点时展示“继续”入口
const canContinue = computed(() => {
  void props.tick
  return props.tree?.state !== 'running' && hasResumable.value
})

function toggleChildren(id: string) {
  const s = new Set(collapsedNodes.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  collapsedNodes.value = s
}

function toggleDetail(id: string) {
  const s = new Set(openDetail.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  openDetail.value = s
}

function formatMs(ms: number): string {
  if (!ms || ms < 0) return '0s'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return `${m}m${s}s`
}

// ============ 节点级成果文件 ============

interface NodeFile {
  /** 展开态与 diff 缓存的键：节点 id + 路径 */
  key: string
  /** 节点记录里的路径（可能是相对工作目录） */
  path: string
  /** 拼好的绝对路径，用于读当前文件内容 */
  abs: string
  /** 改动前文件不存在（新建） */
  isNew: boolean
  /** 改动前内容；缺失时无法给出真实差异 */
  original?: string
}

interface DiffLine {
  cls: string
  prefix: string
  text: string
}

/** 从节点的 fileBaselines（写入时捕获的基线）取出这个任务改过哪些文件 */
function nodeFiles(node: TaskNode): NodeFile[] {
  const baselines = node.fileBaselines
  if (!baselines) return []
  const wd = props.workingDirectory || ''
  const sep = wd.includes('\\') ? '\\' : '/'
  return Object.entries(baselines).map(([path, baseline]) => {
    const isAbsolute = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')
    return {
      key: `${node.id}|${path}`,
      path,
      abs: isAbsolute || !wd ? path : `${wd.replace(/[\\/]+$/, '')}${sep}${path.replace(/^[\\/]+/, '')}`,
      isNew: !baseline.beforeSha256 || baseline.beforeSha256 === 'unknown',
      original: baseline.originalContent
    }
  })
}

const expandedFile = ref<Set<string>>(new Set())
// 每个文件的读取状态与 diff 缓存：展开时读一次盘，收起再展开不重复读
const fileState = ref<Record<string, 'loading' | 'error' | 'ready'>>({})
const fileDiff = ref<Record<string, DiffLine[]>>({})

/** 简易行级 diff：按行集合对比，先列删除行再列新增行（与交付审阅面板口径一致） */
function buildDiffLines(oldContent: string, newContent: string, hasOriginal: boolean): DiffLine[] {
  if (!hasOriginal) {
    // 没存改动前内容：只能展示当前文件，不谎报为全新增
    const note: DiffLine[] = [{ cls: 'tt-diff-note', prefix: '', text: '（无改动前内容，以下展示当前文件内容）' }]
    return note.concat(newContent.split('\n').map(text => ({ cls: '', prefix: ' ', text })))
  }
  if (!oldContent) {
    return newContent.split('\n').map(text => ({ cls: 'tt-diff-add', prefix: '+', text }))
  }

  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  if (Math.max(oldLines.length, newLines.length) > 500) {
    return [{ cls: 'tt-diff-note', prefix: '', text: `（文件较大：${oldLines.length} → ${newLines.length} 行，不展开逐行差异）` }]
  }

  const oldSet = new Set(oldLines)
  const newSet = new Set(newLines)
  const lines: DiffLine[] = []
  for (const text of oldLines) {
    if (!newSet.has(text)) lines.push({ cls: 'tt-diff-remove', prefix: '-', text })
  }
  for (const text of newLines) {
    if (!oldSet.has(text)) lines.push({ cls: 'tt-diff-add', prefix: '+', text })
  }
  if (lines.length === 0) lines.push({ cls: 'tt-diff-note', prefix: '', text: '（无行级差异，可能只是格式变化）' })
  return lines
}

async function toggleNodeFile(file: NodeFile) {
  const s = new Set(expandedFile.value)
  if (s.has(file.key)) {
    s.delete(file.key)
    expandedFile.value = s
    return
  }
  s.add(file.key)
  expandedFile.value = s
  if (fileDiff.value[file.key] || fileState.value[file.key] === 'loading') return

  fileState.value = { ...fileState.value, [file.key]: 'loading' }
  try {
    const res = window.electronAPI?.readFile ? await window.electronAPI.readFile(file.abs) : null
    if (!res?.success) {
      fileState.value = { ...fileState.value, [file.key]: 'error' }
      return
    }
    fileDiff.value = {
      ...fileDiff.value,
      [file.key]: buildDiffLines(file.original ?? '', res.content ?? '', file.original !== undefined || file.isNew)
    }
    fileState.value = { ...fileState.value, [file.key]: 'ready' }
  } catch {
    fileState.value = { ...fileState.value, [file.key]: 'error' }
  }
}
</script>

<style scoped>
.task-tree-panel {
  border: 1px solid var(--ct-border);
  border-radius: 10px;
  background: var(--ct-bg-secondary);
  padding: 8px 12px;
}

.tt-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  user-select: none;
}

.tt-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.tt-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ct-accent);
}

.tt-state {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 10px;
  background: var(--ct-bg);
  color: var(--ct-text-secondary);
  border: 1px solid var(--ct-border);
}

.tt-state-running { color: var(--ct-accent); }
.tt-state-completed, .tt-state-completed_with_gaps { color: #2e7d32; }
.tt-state-failed, .tt-state-interrupted, .tt-state-paused { color: #c62828; }

.tt-progress {
  font-size: 12px;
  color: var(--ct-text-muted);
}

.tt-caret {
  font-size: 12px;
  color: var(--ct-text-muted);
}

.tt-header-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.tt-continue-btn {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 8px;
  border: 1px solid var(--ct-accent);
  background: transparent;
  color: var(--ct-accent);
  cursor: pointer;
  white-space: nowrap;
}

.tt-continue-btn:hover {
  background: var(--ct-accent);
  color: #fff;
}

.tt-retry-btn {
  font-size: 11px;
  padding: 0 8px;
  border-radius: 8px;
  border: 1px solid #c62828;
  background: transparent;
  color: #c62828;
  cursor: pointer;
  flex-shrink: 0;
  white-space: nowrap;
}

.tt-retry-btn:hover {
  background: #c62828;
  color: #fff;
}

.tt-body {
  margin-top: 8px;
  max-height: 30vh;
  overflow-y: auto;
}

.tt-empty {
  font-size: 12px;
  color: var(--ct-text-muted);
  padding: 6px 0;
}

.tt-expander {
  margin-left: auto;
  flex-shrink: 0;
  padding-left: 8px;
  font-size: 11px;
  color: var(--ct-text-muted);
}

.tt-detail {
  margin: 2px 0 8px 22px;
  padding: 8px 10px;
  background: var(--ct-bg);
  border-left: 2px solid var(--ct-accent);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tt-detail-item {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.5;
}

.tt-detail-block {
  flex-direction: column;
  gap: 3px;
}

.tt-detail-k {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--ct-text-muted);
}

.tt-detail-v {
  color: var(--ct-text-secondary);
  word-break: break-word;
}

.tt-detail-list {
  margin: 0;
  padding-left: 18px;
  color: var(--ct-text-secondary);
}

.tt-detail .tt-result {
  margin: 0;
}

.tt-row {
  padding: 1px 0;
}

.tt-row-main {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}

.tt-row-main:hover {
  background: var(--ct-bg);
}

.tw-caret {
  width: 12px;
  display: inline-block;
  text-align: center;
  color: var(--ct-text-muted);
  font-size: 11px;
  flex-shrink: 0;
}

.tw-caret.tw-leaf {
  color: var(--ct-border);
}

.tt-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--ct-text-muted);
}

.tt-dot-completed { background: #2e7d32; }
.tt-dot-running { background: var(--ct-accent); }
.tt-dot-failed, .tt-dot-blocked, .tt-dot-interrupted { background: #c62828; }
.tt-dot-paused, .tt-dot-awaiting_approval, .tt-dot-waiting { background: #f9a825; }
.tt-dot-skipped, .tt-dot-cancelled, .tt-dot-pending, .tt-dot-ready { background: var(--ct-text-muted); }

.tt-node-title {
  color: var(--ct-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tt-badge {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--ct-bg);
  color: var(--ct-text-secondary);
  border: 1px solid var(--ct-border);
  flex-shrink: 0;
}

.tt-badge-completed { color: #2e7d32; }
.tt-badge-running { color: var(--ct-accent); }
.tt-badge-failed, .tt-badge-blocked, .tt-badge-interrupted { color: #c62828; }

/* 验收未验证标记：与任务状态分开表达 */
.tt-accept-tag {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 6px;
  flex-shrink: 0;
  background: rgba(249, 168, 37, 0.14);
  color: #b26a00;
}

.tt-assignee {
  font-size: 11px;
  color: var(--ct-text-muted);
  flex-shrink: 0;
}

.tt-tag {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 6px;
  flex-shrink: 0;
}

.tt-tag-write {
  background: rgba(46, 125, 50, 0.12);
  color: #2e7d32;
}

.tt-tag-readonly {
  background: rgba(249, 168, 37, 0.14);
  color: #b26a00;
}

.tt-result {
  margin: 2px 0 6px 26px;
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ct-text-secondary);
  background: var(--ct-bg);
  border-left: 2px solid var(--ct-border);
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 失败类终态缘由 */
.tt-failure {
  margin: 2px 0 0 26px;
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.5;
  color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
  border-left: 2px solid #ef4444;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 节点级成果文件清单 */
.tt-files {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.tt-file {
  border: 1px solid var(--ct-border);
  border-radius: 4px;
  overflow: hidden;
  background: var(--ct-bg-secondary);
}

.tt-file-line {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  cursor: pointer;
  font-size: 12px;
}

.tt-file-line:hover {
  background: var(--ct-bg);
}

.tt-file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ct-text-primary);
  font-family: 'Consolas', 'Monaco', monospace;
}

.tt-file-diff {
  border-top: 1px solid var(--ct-border);
  max-height: 260px;
  overflow: auto;
}

.tt-diff-pre {
  margin: 0;
  padding: 6px 8px;
  font-size: 11px;
  line-height: 1.5;
  font-family: 'Consolas', 'Monaco', monospace;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--ct-text-secondary);
}

.tt-diff-add {
  background: rgba(16, 185, 129, 0.12);
  color: #10b981;
}

.tt-diff-remove {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}

.tt-diff-note {
  color: var(--ct-text-muted);
}

.tt-file-muted {
  padding: 6px 8px;
  font-size: 11px;
  color: var(--ct-text-muted);
  text-align: center;
}
</style>
