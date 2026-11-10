<template>
  <div class="ft-panel">
    <div class="ft-toolbar">
      <span class="ft-root" :title="rootDir" @click="revealRoot">{{ rootDir ? baseName(rootDir) : '未设置目录' }}</span>
      <button class="ft-refresh" :disabled="loading" title="重新读取目录，观察最新构建产物" @click="refresh">
        {{ loading ? '读取中…' : '⟳ 刷新' }}
      </button>
    </div>

    <div v-if="!rootDir" class="ft-hint">
      未设置工作目录，无法浏览工程文件。请在首页选择工作目录。
    </div>
    <div v-else class="ft-body">
      <div v-if="error" class="ft-error">⚠ {{ error }}</div>
      <div v-else-if="rows.length === 0 && !loading" class="ft-empty">目录为空</div>

      <div
        v-for="row in rows"
        :key="row.path"
        class="ft-row"
        :style="{ paddingLeft: `${row.depth * 14 + 6}px` }"
      >
        <span
          v-if="row.type === 'directory'"
          class="ft-caret"
          @click="toggleDir(row.path)"
        >{{ loadingPaths.has(row.path) ? '…' : (expanded.has(row.path) ? '▾' : '▸') }}</span>
        <span v-else class="ft-caret ft-caret-leaf">·</span>

        <span class="ft-icon">{{ iconFor(row) }}</span>

        <span
          class="ft-name"
          :class="{ 'ft-name-dir': row.type === 'directory', 'ft-name-active': row.path === selectedPath }"
          :title="row.path"
          @click="row.type === 'directory' ? toggleDir(row.path) : emit('select-file', row.path)"
        >{{ row.name }}</span>

        <span v-if="row.type === 'file'" class="ft-size">{{ formatSize(row.size) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'

interface DirEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size: number
}

interface FsRow {
  name: string
  path: string
  type: 'file' | 'directory'
  size: number
  depth: number
}

const props = defineProps<{ rootDir: string; selectedPath?: string }>()
const emit = defineEmits<{ (e: 'select-file', path: string): void }>()

// 已加载目录的子项缓存：dirPath -> 排序后的条目
const childrenOf = ref<Record<string, DirEntry[]>>({})
// 展开的目录集合
const expanded = ref<Set<string>>(new Set())
// 正在读取的目录集合
const loadingPaths = ref<Set<string>>(new Set())
const error = ref('')

const loading = computed(() => loadingPaths.value.size > 0)

/** 依据根路径风格选择分隔符（Windows 反斜杠 / *nix 正斜杠） */
function joinPath(base: string, name: string): string {
  if (base.endsWith('\\') || base.endsWith('/')) return base + name
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return base + sep + name
}

function baseName(p: string): string {
  if (!p) return ''
  const n = p.replace(/[\\/]+$/, '')
  const i = Math.max(n.lastIndexOf('\\'), n.lastIndexOf('/'))
  return i >= 0 ? n.slice(i + 1) : n
}

function formatSize(sz: number): string {
  if (!sz || sz <= 0) return ''
  if (sz < 1024) return sz + ' B'
  if (sz < 1048576) return (sz / 1024).toFixed(1) + ' KB'
  return (sz / 1048576).toFixed(1) + ' MB'
}

function iconFor(row: FsRow): string {
  if (row.type === 'directory') return expanded.value.has(row.path) ? '📂' : '📁'
  const ext = row.name.includes('.') ? row.name.slice(row.name.lastIndexOf('.') + 1).toLowerCase() : ''
  const map: Record<string, string> = {
    js: '📜', ts: '📜', tsx: '📜', jsx: '📜', vue: '💚', json: '🧩', md: '📝',
    html: '🌐', css: '🎨', scss: '🎨', less: '🎨', py: '🐍', go: '🔷', rs: '🦀',
    java: '☕', sh: '⚙️', bat: '⚙️', ps1: '⚙️', yml: '⚙️', yaml: '⚙️', toml: '⚙️',
    lock: '🔒', svg: '🖼️', txt: '📃'
  }
  return map[ext] || '📄'
}

async function loadDir(dirPath: string, force = false): Promise<void> {
  if (!dirPath) return
  if (!force && childrenOf.value[dirPath]) return
  if (!window.electronAPI?.readDirectory) {
    error.value = '文件浏览不可用（需在 Electron 环境运行）'
    return
  }
  loadingPaths.value = new Set([...loadingPaths.value, dirPath])
  if (dirPath === props.rootDir) error.value = ''
  try {
    const res = await window.electronAPI.readDirectory(dirPath)
    if (res.success && res.items) {
      const entries: DirEntry[] = res.items.map(it => ({
        name: it.name,
        path: joinPath(dirPath, it.name),
        type: it.type,
        size: it.size
      }))
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
      })
      childrenOf.value = { ...childrenOf.value, [dirPath]: entries }
    } else {
      error.value = res.error || `读取失败：${dirPath}`
      childrenOf.value = { ...childrenOf.value, [dirPath]: [] }
    }
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    const next = new Set(loadingPaths.value)
    next.delete(dirPath)
    loadingPaths.value = next
  }
}

async function toggleDir(dirPath: string): Promise<void> {
  if (!childrenOf.value[dirPath]) await loadDir(dirPath)
  const s = new Set(expanded.value)
  if (s.has(dirPath)) s.delete(dirPath)
  else s.add(dirPath)
  expanded.value = s
}

/** 刷新：重载根目录及所有已展开目录，捕捉 Agent 新建/改动的文件 */
async function refresh(): Promise<void> {
  const dirs = [props.rootDir, ...Array.from(expanded.value)].filter(Boolean)
  const nextChildren = { ...childrenOf.value }
  for (const d of dirs) delete nextChildren[d]
  childrenOf.value = nextChildren
  for (const d of dirs) await loadDir(d, true)
}

function revealRoot(): void {
  if (props.rootDir) expanded.value = new Set([...expanded.value, props.rootDir])
}

const rows = computed<FsRow[]>(() => {
  const out: FsRow[] = []
  const root = props.rootDir
  if (!root || !expanded.value.has(root)) return out
  const walk = (dirPath: string, depth: number) => {
    const kids = childrenOf.value[dirPath] || []
    for (const k of kids) {
      out.push({ name: k.name, path: k.path, type: k.type, size: k.size, depth })
      if (k.type === 'directory' && expanded.value.has(k.path)) walk(k.path, depth + 1)
    }
  }
  walk(root, 0)
  return out
})

// 根目录变化时重置并自动展开、加载
watch(() => props.rootDir, (dir) => {
  childrenOf.value = {}
  error.value = ''
  if (dir) {
    expanded.value = new Set([dir])
    loadDir(dir, true)
  } else {
    expanded.value = new Set()
  }
}, { immediate: true })
</script>

<style scoped>
.ft-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-size: 13px;
  color: var(--ct-text-primary);
}

.ft-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 6px 8px;
  border-bottom: 1px solid var(--ct-border);
  margin-bottom: 4px;
}

.ft-root {
  font-weight: 600;
  color: var(--ct-accent);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.ft-refresh {
  flex-shrink: 0;
  border: 1px solid var(--ct-border);
  background: var(--ct-bg);
  color: var(--ct-text-secondary);
  border-radius: 6px;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}

.ft-refresh:hover:not(:disabled) {
  border-color: var(--ct-accent);
  color: var(--ct-accent);
}

.ft-refresh:disabled {
  opacity: 0.6;
  cursor: default;
}

.ft-hint,
.ft-empty,
.ft-error {
  padding: 12px 8px;
  color: var(--ct-text-muted);
  font-size: 12px;
  line-height: 1.6;
}

.ft-error {
  color: #c62828;
}

.ft-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.ft-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  border-radius: 5px;
  white-space: nowrap;
}

.ft-row:hover {
  background: var(--ct-bg-tertiary);
}

.ft-caret {
  width: 12px;
  flex-shrink: 0;
  text-align: center;
  color: var(--ct-text-muted);
  cursor: pointer;
  font-size: 11px;
}

.ft-caret-leaf {
  cursor: default;
  color: var(--ct-border);
}

.ft-icon {
  flex-shrink: 0;
  width: 16px;
  text-align: center;
}

.ft-name {
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  color: var(--ct-text-primary);
}

.ft-name-dir {
  color: var(--ct-text-secondary);
  font-weight: 500;
}

.ft-name:hover {
  color: var(--ct-accent);
}

.ft-name-active {
  color: var(--ct-accent);
  font-weight: 600;
}

.ft-size {
  margin-left: auto;
  flex-shrink: 0;
  padding-left: 8px;
  font-size: 11px;
  color: var(--ct-text-muted);
}
</style>
