<template>
  <div v-if="files.length > 0" class="cfc-wrap" @mouseleave="open = false">
    <!-- 悬浮清单：路径 + 增删行数，点文件名在右侧面板看 diff -->
    <div v-if="open" class="cfc-card">
      <div class="cfc-card-title">{{ files.length }} 个文件已修改</div>
      <ul class="cfc-list">
        <li
          v-for="f in files"
          :key="f.path"
          class="cfc-item"
          :class="{ 'is-active': f.path === activePath }"
          :title="f.path"
          @click="pick(f)"
        >
          <span class="cfc-item-path">{{ shorten(f.path) }}</span>
          <span class="cfc-item-stats">
            <span class="cfc-added">+{{ f.linesAdded }}</span>
            <span class="cfc-removed">-{{ f.linesRemoved }}</span>
          </span>
        </li>
      </ul>
      <button class="cfc-panel-link" @click="emit('open-panel')">📦 打开交付审阅（含验收与撤销）</button>
    </div>

    <button class="cfc-chip" :class="{ 'is-open': open }" @click="toggle">
      <span class="cfc-chip-icon">📝</span>
      <span class="cfc-chip-text">{{ files.length }} 个文件已修改</span>
      <span class="cfc-added">+{{ totalAdded }}</span>
      <span class="cfc-removed">-{{ totalRemoved }}</span>
      <span class="cfc-chip-chev">{{ open ? '▾' : '▸' }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { DeliveryReport, FileChange } from '@/services/agent/delivery-report'

const props = defineProps<{
  report: DeliveryReport
  /** 右侧面板当前打开的文件路径，用于高亮清单里对应的那一行 */
  activePath?: string
}>()

const emit = defineEmits<{
  (e: 'open-file', file: FileChange): void
  (e: 'open-panel'): void
}>()

const open = ref(false)

// 只保留真正有增删记录的文件：正文被裁剪的历史归档仍会保留行数统计，仍可点开走 git 基准
const files = computed<FileChange[]>(() => props.report?.changedFiles || [])

const totalAdded = computed(() => files.value.reduce((s, f) => s + (f.linesAdded || 0), 0))
const totalRemoved = computed(() => files.value.reduce((s, f) => s + (f.linesRemoved || 0), 0))

/** 路径过长时保留头部（项目名/目录层级更有辨识度），尾部用省略号，完整路径放 title */
function shorten(path: string): string {
  const flat = path.replace(/\\/g, '/')
  return flat.length > 46 ? flat.slice(0, 45) + '…' : flat
}

function toggle() {
  open.value = !open.value
}

function pick(f: FileChange) {
  emit('open-file', f)
  open.value = false
}
</script>

<style scoped>
.cfc-wrap {
  position: relative;
  display: flex;
  justify-content: center;
  padding: 4px 0 8px;
}

/* 胶囊按钮 */
.cfc-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid var(--ct-border);
  border-radius: 999px;
  background: var(--ct-bg-secondary);
  color: var(--ct-text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.cfc-chip:hover,
.cfc-chip.is-open {
  border-color: var(--ct-accent);
  background: var(--ct-bg-tertiary);
}

.cfc-chip-icon {
  font-size: 13px;
}

.cfc-chip-text {
  color: var(--ct-text-primary);
}

.cfc-chip-chev {
  font-size: 10px;
  color: var(--ct-text-muted);
}

/* 悬浮清单 */
.cfc-card {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  min-width: 320px;
  max-width: min(560px, 90%);
  margin-bottom: 6px;
  padding: 10px;
  border: 1px solid var(--ct-border);
  border-radius: 10px;
  background: var(--ct-bg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}

.cfc-card-title {
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ct-text-primary);
}

.cfc-list {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 260px;
  overflow-y: auto;
}

.cfc-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
}

.cfc-item:hover {
  background: var(--ct-bg-tertiary);
}

.cfc-item.is-active {
  background: var(--ct-bg-secondary);
  outline: 1px solid var(--ct-accent);
}

.cfc-item-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--ct-text-primary);
}

.cfc-item-stats {
  display: inline-flex;
  gap: 8px;
  flex: 0 0 auto;
  font-size: 12px;
}

.cfc-added {
  color: #10b981;
}

.cfc-removed {
  color: #ef4444;
}

.cfc-panel-link {
  width: 100%;
  margin-top: 8px;
  padding: 5px 8px;
  border: none;
  border-top: 1px solid var(--ct-border);
  background: transparent;
  color: var(--ct-text-muted);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.cfc-panel-link:hover {
  color: var(--ct-accent);
}
</style>
