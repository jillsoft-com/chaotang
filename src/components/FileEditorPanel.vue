<template>
  <div class="fe-panel">
    <div class="fe-header">
      <span class="fe-file-icon">{{ fileIcon }}</span>
      <span class="fe-name" :title="filePath">{{ fileName }}</span>
      <span v-if="dirty" class="fe-dirty" title="有未保存的修改">●</span>
      <div class="fe-actions">
        <template v-if="isMarkdown || isSvg">
          <button class="fe-btn" :class="{ active: mode === 'edit' }" @click="mode = 'edit'">编辑</button>
          <button class="fe-btn" :class="{ active: mode === 'preview' }" @click="mode = 'preview'">预览</button>
          <button class="fe-btn" :class="{ active: mode === 'split' }" @click="mode = 'split'">分栏</button>
        </template>
        <button v-else class="fe-btn" :class="{ active: mode === 'edit' }" @click="mode = 'edit'">编辑</button>
        <button v-if="canDiff" class="fe-btn" :class="{ active: mode === 'diff' }" title="查看该文件的改动差异" @click="toggleDiff">Diff</button>
        <button class="fe-btn fe-save" :disabled="!dirty || saving || !loaded" @click="save">
          {{ saving ? '保存中…' : '保存' }}
        </button>
        <button class="fe-btn fe-close" title="关闭" @click="emit('close')">✕</button>
      </div>
    </div>

    <div class="fe-path" :title="filePath">{{ filePath }}</div>

    <div v-if="loading" class="fe-status">读取中…</div>
    <div v-else-if="error" class="fe-status fe-error">⚠ {{ error }}</div>
    <div v-else class="fe-body">
      <template v-if="mode === 'diff'">
        <div class="fe-diff-wrap">
          <div class="fe-diff-bar">
            <label class="fe-diff-baseline">基准
              <select v-model="diffMode" @change="loadDiff">
                <option v-if="hasRoundSnapshot" value="round">本轮改动（执行快照）</option>
                <option value="uncommitted">未提交（工作树+暂存区 vs HEAD）</option>
                <option value="staged">仅暂存区（git diff --cached）</option>
                <option value="unstaged">仅工作区（git diff）</option>
                <option value="last">最近一次提交（HEAD^ → HEAD）</option>
              </select>
            </label>
            <span class="fe-diff-stat">{{ diffStatText }}</span>
          </div>
          <div v-if="diffNote" class="fe-diff-note">{{ diffNote }}</div>
          <div v-if="diffLoading" class="fe-status">加载 diff…</div>
          <div v-else-if="diffError" class="fe-status fe-error">⚠ {{ diffError }}</div>
          <pre v-else-if="diffHasContent" class="fe-diff-pre"><span
            v-for="(ln, i) in diffLines" :key="i" :class="diffLineClass(ln)"
          >{{ ln }}
</span></pre>
          <div v-else class="fe-status">✓ 该文件相对所选基准无改动</div>
        </div>
      </template>
      <template v-else>
        <textarea
          v-if="mode === 'edit' || mode === 'split'"
          v-model="editText"
          class="fe-editor"
          spellcheck="false"
          @keydown.ctrl.s.prevent="save"
          @keydown.meta.s.prevent="save"
        ></textarea>
        <div
          v-if="isMarkdown && (mode === 'preview' || mode === 'split')"
          class="fe-preview markdown-body"
          v-html="previewHtml"
        ></div>
        <!-- SVG 图像预览：data URL 经 <img> 渲染，内嵌脚本在 img 上下文不执行 -->
        <div
          v-if="isSvg && (mode === 'preview' || mode === 'split')"
          class="fe-svg-preview"
        >
          <img v-if="editText" :src="svgDataUrl" class="fe-svg-img" :alt="fileName" />
          <div v-else class="fe-status">（空文件）</div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { renderSafeMarkdown } from '@/utils/sanitize-markdown'
import { toUnifiedDiff } from '@/utils/line-diff'
import type { FileDiffRequest } from '@/types'

const props = defineProps<{ filePath: string; rootDir?: string; roundDiff?: FileDiffRequest | null }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const editText = ref('')
const savedText = ref('')
const loading = ref(false)
const saving = ref(false)
const loaded = ref(false)
const error = ref('')
const mode = ref<'edit' | 'preview' | 'split' | 'diff'>('edit')

// ============ Git Diff 模式状态 ============
const diffText = ref('')
const diffLoading = ref(false)
const diffError = ref('')
const diffStatus = ref('')
const diffHasContent = ref(false)
const diffNote = ref('')
type GitDiffMode = 'uncommitted' | 'staged' | 'unstaged' | 'last'
const diffMode = ref<GitDiffMode | 'round'>('uncommitted')

/** 本轮快照能否直接算 diff：正文被裁剪掉时只能回退 git 基准 */
const hasRoundSnapshot = computed(() => {
  const r = props.roundDiff
  if (!r || r.trimmed) return false
  return typeof r.newContent === 'string' || typeof r.oldContent === 'string'
})

const canDiff = computed(() => hasRoundSnapshot.value || (!!props.rootDir && !!window.electronAPI?.gitFileDiff))

const diffLines = computed(() => diffText.value.split('\n'))

const diffStatText = computed(() => {
  if (diffError.value) return ''
  if (diffLoading.value) return '读取中…'
  if (diffStatus.value === 'round') {
    const r = props.roundDiff
    if (!r) return ''
    const verb = r.status === 'created' ? '本轮新建' : r.status === 'deleted' ? '本轮删除' : '本轮修改'
    return `${verb} +${r.linesAdded || 0} -${r.linesRemoved || 0}`
  }
  switch (diffStatus.value) {
    case 'modified': return '有改动'
    case 'untracked': return '未跟踪新文件（全部为新增）'
    case 'unmodified': return '无改动'
    case 'notgit': return '非 Git 仓库'
    default: return ''
  }
})

const fileName = computed(() => {
  const p = props.filePath || ''
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i >= 0 ? p.slice(i + 1) : p
})

const ext = computed(() => {
  const n = fileName.value
  return n.includes('.') ? n.slice(n.lastIndexOf('.') + 1).toLowerCase() : ''
})

const isMarkdown = computed(() => ext.value === 'md' || ext.value === 'markdown')

const isSvg = computed(() => ext.value === 'svg')

// SVG 文本转 data URL：编辑时分栏可实时刷新预览
const svgDataUrl = computed(() => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(editText.value))

const dirty = computed(() => loaded.value && editText.value !== savedText.value)

const previewHtml = computed(() => renderSafeMarkdown(editText.value))

const fileIcon = computed(() => {
  if (isMarkdown.value) return '📝'
  const map: Record<string, string> = {
    js: '📜', ts: '📜', tsx: '📜', jsx: '📜', vue: '💚', json: '🧩', html: '🌐',
    css: '🎨', scss: '🎨', py: '🐍', go: '🔷', rs: '🦀', java: '☕', svg: '🖼️'
  }
  return map[ext.value] || '📄'
})

async function load(): Promise<void> {
  if (!props.filePath) return
  diffText.value = ''
  diffError.value = ''
  diffStatus.value = ''
  diffHasContent.value = false
  diffNote.value = ''
  if (!window.electronAPI?.readFile) {
    error.value = '需在 Electron 环境运行'
    loaded.value = false
    return
  }
  loading.value = true
  error.value = ''
  loaded.value = false
  mode.value = isMarkdown.value || isSvg.value ? 'preview' : 'edit'
  try {
    const res = await window.electronAPI.readFile(props.filePath)
    if (res.success && typeof res.content === 'string') {
      editText.value = res.content
      savedText.value = res.content
      loaded.value = true
    } else {
      error.value = res.error || '无法读取该文件（可能是二进制/媒体文件）'
    }
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  if (!dirty.value || saving.value) return
  if (!window.electronAPI?.writeFile) {
    error.value = '写入不可用'
    return
  }
  saving.value = true
  try {
    const res = await window.electronAPI.writeFile(props.filePath, editText.value)
    if (res.success) {
      savedText.value = editText.value
      ElMessage.success(`已保存 ${fileName.value}`)
    } else {
      ElMessage.error(`保存失败：${res.error || '未知错误'}`)
    }
  } catch (e: any) {
    ElMessage.error(`保存失败：${e?.message || e}`)
  } finally {
    saving.value = false
  }
}

/** 本轮快照直接出 unified 文本：不依赖 git，也不碰磁盘现状 */
function applyRoundDiff(): void {
  const r = props.roundDiff
  diffLoading.value = false
  diffError.value = ''
  diffStatus.value = 'round'
  diffText.value = r ? toUnifiedDiff(r.oldContent ?? '', r.newContent ?? '', fileName.value) : ''
  diffHasContent.value = diffText.value !== ''
  diffNote.value = r?.drift
    ? 'ℹ 本轮快照生成后该文件又被外部修改，下面展示的是当时的差异；要看磁盘现状请切未提交基准'
    : ''
}

/** 拉取 diff：round 基准用本地快照算，其余基准走 git */
async function loadDiff(): Promise<void> {
  if (diffMode.value === 'round') {
    if (hasRoundSnapshot.value) {
      applyRoundDiff()
      return
    }
    // 正文被裁剪的历史归档：只能退 git，并说明退的原因
    if (!props.rootDir || !window.electronAPI?.gitFileDiff) {
      diffLoading.value = false
      diffError.value = '本轮快照正文已超出落盘上限被裁剪，且当前环境不可用 git 基准，无法展示差异'
      diffText.value = ''
      diffHasContent.value = false
      return
    }
    diffNote.value = '本轮快照正文已超出落盘上限被裁剪，改按 git 未提交基准展示'
    diffMode.value = 'uncommitted'
  }
  // 上面的分支已排掉或改写了 round，此处必为 git 基准
  await loadGitDiff(diffMode.value)
}

/** 拉取当前文件相对所选 git 基准的 unified diff */
async function loadGitDiff(gitMode: GitDiffMode): Promise<void> {
  if (!props.rootDir || !window.electronAPI?.gitFileDiff) return
  diffLoading.value = true
  diffError.value = ''
  try {
    const res = await window.electronAPI.gitFileDiff({
      filePath: props.filePath,
      cwd: props.rootDir,
      mode: gitMode
    })
    diffStatus.value = res.status || ''
    if (!res.success) {
      diffError.value = res.error || '无法获取 diff'
      diffText.value = ''
      diffHasContent.value = false
    } else {
      diffText.value = res.diff || ''
      diffHasContent.value = !!res.hasChanges
    }
  } catch (e: any) {
    diffError.value = e?.message || String(e)
  } finally {
    diffLoading.value = false
  }
}

/** Diff 开关：进入时拉取，再次点击回到文本模式 */
function toggleDiff(): void {
  if (mode.value === 'diff') {
    mode.value = isMarkdown.value || isSvg.value ? 'preview' : 'edit'
  } else {
    mode.value = 'diff'
    // 有本轮快照时默认看“本轮改了什么”，没有则保留上次的 git 基准选择
    if (hasRoundSnapshot.value) diffMode.value = 'round'
    else if (diffMode.value === 'round') diffMode.value = 'uncommitted'
    loadDiff()
  }
}

/** 按行首特征给 unified diff 着色 */
function diffLineClass(line: string): string {
  if (line.startsWith('@@')) return 'diff-hunk'
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-meta'
  if (/^(diff |index |new file|deleted file|similarity |rename |copy )/.test(line)) return 'diff-meta'
  if (line.startsWith('+')) return 'diff-add'
  if (line.startsWith('-')) return 'diff-del'
  return 'diff-ctx'
}

// 切换文件时重新载入
watch(() => props.filePath, () => { load() }, { immediate: true })

// 从会话改动清单点开：带着本轮快照就直接进 diff 视图（seq 递增，同文件重复点也能刷新）
watch(() => props.roundDiff?.seq, () => {
  if (!props.roundDiff) return
  mode.value = 'diff'
  diffMode.value = hasRoundSnapshot.value ? 'round' : 'uncommitted'
  loadDiff()
})
</script>

<style scoped>
.fe-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  border: 1px solid var(--ct-border);
  border-radius: 8px;
  background: var(--ct-bg);
  overflow: hidden;
}

.fe-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ct-border);
  background: var(--ct-bg-secondary);
}

.fe-file-icon {
  flex-shrink: 0;
}

.fe-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--ct-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fe-dirty {
  color: #e6a23c;
  font-size: 12px;
  flex-shrink: 0;
}

.fe-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.fe-btn {
  border: 1px solid var(--ct-border);
  background: var(--ct-bg);
  color: var(--ct-text-secondary);
  border-radius: 5px;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}

.fe-btn:hover:not(:disabled) {
  border-color: var(--ct-accent);
  color: var(--ct-accent);
}

.fe-btn.active {
  background: var(--ct-accent);
  border-color: var(--ct-accent);
  color: #fff;
}

.fe-save:disabled {
  opacity: 0.45;
  cursor: default;
}

.fe-close {
  padding: 2px 6px;
}

.fe-path {
  padding: 3px 10px;
  font-size: 11px;
  color: var(--ct-text-muted);
  border-bottom: 1px solid var(--ct-border);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fe-status {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ct-text-muted);
  font-size: 13px;
  padding: 20px;
}

.fe-error {
  color: #c62828;
}

.fe-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.fe-editor {
  flex: 1;
  min-width: 0;
  border: none;
  resize: none;
  padding: 12px;
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 13px;
  line-height: 1.6;
  tab-size: 2;
  background: var(--ct-bg);
  color: var(--ct-text-primary);
  outline: none;
}

.fe-preview {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 12px 16px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--ct-text-primary);
  word-break: break-word;
}

.fe-body .fe-editor + .fe-preview {
  border-left: 1px solid var(--ct-border);
}

/* SVG 图像预览：棋盘格背景便于看清透明区域，分栏时与编辑器列分隔 */
.fe-svg-preview {
  flex: 1;
  min-width: 0;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background:
    linear-gradient(45deg, var(--ct-bg-secondary) 25%, transparent 25%),
    linear-gradient(-45deg, var(--ct-bg-secondary) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--ct-bg-secondary) 75%),
    linear-gradient(-45deg, transparent 75%, var(--ct-bg-secondary) 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, -10px 0;
}

.fe-body .fe-editor + .fe-svg-preview {
  border-left: 1px solid var(--ct-border);
}

.fe-svg-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

/* Markdown 预览样式 */
.fe-preview :deep(h1),
.fe-preview :deep(h2),
.fe-preview :deep(h3),
.fe-preview :deep(h4) {
  margin: 14px 0 8px;
  font-weight: 600;
  color: var(--ct-text-primary);
}

.fe-preview :deep(h1) { font-size: 22px; border-bottom: 1px solid var(--ct-border); padding-bottom: 6px; }
.fe-preview :deep(h2) { font-size: 18px; }
.fe-preview :deep(h3) { font-size: 16px; }

.fe-preview :deep(p) { margin: 8px 0; }

.fe-preview :deep(a) { color: var(--ct-accent); text-decoration: none; }
.fe-preview :deep(a:hover) { text-decoration: underline; }

.fe-preview :deep(ul),
.fe-preview :deep(ol) { margin: 8px 0; padding-left: 24px; }

.fe-preview :deep(li) { margin: 3px 0; }

.fe-preview :deep(code) {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12.5px;
  background: var(--ct-bg-secondary);
  padding: 1px 5px;
  border-radius: 4px;
}

.fe-preview :deep(pre) {
  background: var(--ct-bg-secondary);
  border: 1px solid var(--ct-border);
  border-radius: 6px;
  padding: 12px;
  overflow-x: auto;
  margin: 10px 0;
}

.fe-preview :deep(pre code) {
  background: none;
  padding: 0;
  font-size: 12.5px;
}

.fe-preview :deep(blockquote) {
  margin: 10px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--ct-accent);
  color: var(--ct-text-secondary);
  background: var(--ct-bg-secondary);
}

.fe-preview :deep(hr) {
  border: none;
  border-top: 1px solid var(--ct-border);
  margin: 14px 0;
}

.fe-preview :deep(table) {
  border-collapse: collapse;
  margin: 10px 0;
  width: 100%;
}

.fe-preview :deep(th),
.fe-preview :deep(td) {
  border: 1px solid var(--ct-border);
  padding: 6px 10px;
  text-align: left;
}

.fe-preview :deep(th) {
  background: var(--ct-bg-secondary);
  font-weight: 600;
}

.fe-preview :deep(img) {
  max-width: 100%;
}

/* Git Diff 视图 */
.fe-diff-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.fe-diff-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--ct-border);
  background: var(--ct-bg-secondary);
  font-size: 12px;
}

.fe-diff-baseline {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ct-text-secondary);
}

.fe-diff-baseline select {
  background: var(--ct-bg);
  color: var(--ct-text-primary);
  border: 1px solid var(--ct-border);
  border-radius: 5px;
  padding: 2px 6px;
  font-size: 12px;
  cursor: pointer;
}

.fe-diff-stat {
  margin-left: auto;
  color: var(--ct-text-muted);
}

/* 快照漂移 / 正文被裁剪时的如实说明 */
.fe-diff-note {
  padding: 5px 10px;
  border-bottom: 1px solid var(--ct-border);
  background: rgba(230, 162, 60, 0.1);
  color: var(--ct-text-secondary);
  font-size: 11.5px;
  line-height: 1.5;
}

.fe-diff-pre {
  flex: 1;
  margin: 0;
  overflow: auto;
  padding: 8px 0;
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.5;
}

.fe-diff-pre span {
  display: block;
  padding: 0 12px;
  white-space: pre-wrap;
  word-break: break-all;
}

.fe-diff-pre .diff-add {
  background: rgba(46, 160, 67, 0.16);
  color: #7ee787;
}

.fe-diff-pre .diff-del {
  background: rgba(248, 81, 73, 0.16);
  color: #ffa198;
}

.fe-diff-pre .diff-hunk {
  background: rgba(56, 139, 253, 0.12);
  color: #79c0ff;
  font-weight: 600;
}

.fe-diff-pre .diff-meta {
  color: var(--ct-text-muted);
  font-weight: 600;
}

.fe-diff-pre .diff-ctx {
  color: var(--ct-text-secondary);
}
</style>
