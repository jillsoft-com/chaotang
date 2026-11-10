<template>
  <div class="bp-panel">
    <!-- 控制条：后退 / 前进 / 刷新 / 地址栏 -->
    <div class="bp-toolbar">
      <button class="bp-btn" :disabled="!canBack || busy || browserView.agentBusy" title="后退" @click="goBack">←</button>
      <button class="bp-btn" :disabled="!canForward || busy || browserView.agentBusy" title="前进" @click="goForward">→</button>
      <button class="bp-btn" :disabled="!browserView.active || busy || browserView.agentBusy" title="刷新当前页面" @click="reload">⟳</button>

      <input
        v-model="address"
        class="bp-address"
        type="text"
        spellcheck="false"
        placeholder="输入网址后回车，如 https://example.com"
        :disabled="busy || browserView.agentBusy"
        @focus="addressFocused = true"
        @blur="addressFocused = false"
        @keydown.enter.prevent="navigate(address)"
      />
      <button class="bp-btn bp-btn-go" :disabled="busy || browserView.agentBusy" title="前往" @click="navigate(address)">前往</button>
      <button class="bp-btn" :disabled="busy" title="关闭浏览器实例（释放内存）" @click="closeBrowser">✕</button>
    </div>

    <!-- 状态条：标题、占用提示、接管开关 -->
    <div class="bp-status">
      <span class="bp-title" :title="browserView.url">{{ browserView.title || '空白页' }}</span>
      <span v-if="browserView.agentBusy" class="bp-badge bp-badge-agent">
        ⚡ Agent 正在操作{{ browserView.agentLabel ? ` · ${browserView.agentLabel}` : '' }}
      </span>
      <span v-else-if="browserView.manualHold" class="bp-badge bp-badge-hold">已接管 · Agent 已暂停</span>
      <button
        class="bp-btn bp-btn-hold"
        :class="{ 'is-on': browserView.manualHold }"
        :disabled="browserView.agentBusy"
        :title="browserView.manualHold ? '退出接管，允许 Agent 继续操作页面' : '接管页面：Agent 的浏览器操作将自动等待'"
        @click="toggleHold"
      >{{ browserView.manualHold ? '退出接管' : '接管' }}</button>
      <button class="bp-btn" :disabled="busy" title="立即重新截取画面" @click="capture()">⟳ 取帧</button>
    </div>

    <div v-if="notice" class="bp-notice" :class="noticeKind">{{ notice }}</div>

    <div v-if="!available" class="bp-hint">
      浏览器面板需在 Electron 桌面版使用（Web 模式下 Playwright 不可用）。
    </div>

    <!-- 画面：截图流轮询，点击与滚轮会换算成页面坐标 -->
    <div v-else ref="surfaceRef" class="bp-surface" :class="{ 'is-locked': browserView.agentBusy }">
      <img
        v-if="browserView.image"
        ref="imgRef"
        class="bp-image"
        :src="browserView.image"
        alt="页面画面"
        draggable="false"
        @click="onSurfaceClick"
        @wheel.prevent="onWheel"
      />
      <div v-else class="bp-empty">
        <p class="bp-empty-title">🌐 内置浏览器</p>
        <p>在上方地址栏输入网址并回车，Agent 也可以使用浏览器工具（browser_navigate 等）。</p>
        <p class="bp-empty-muted">
          画面来自 headless Chromium 的截图轮询：Agent 空闲时每 1.5 秒一帧，正在操作时每 0.4 秒一帧。
        </p>
        <p class="bp-empty-muted">首次使用需安装浏览器内核：<code>npx playwright install chromium</code></p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { browserAction } from '@/services/browser/browser-manager'
import {
  browserView,
  runBrowserAction,
  resetBrowserView,
  releaseManualHold,
  canGoBack,
  canGoForward
} from '@/services/browser/browser-session'
import { browserPolicy, isUrlAllowed, confirmNavigation } from '@/services/browser/browser-policy'

/** 取帧节流：Agent 操作时密集，空闲时稀疏 */
const FRAME_MS_AGENT = 400
const FRAME_MS_IDLE = 1500
/** 轮询心跳（实际取帧由上面的间隔约束） */
const TICK_MS = 300
/** 视口同步的最小变化量，避免抖动 */
const VIEWPORT_MIN_DELTA = 12

const surfaceRef = ref<HTMLElement | null>(null)
const imgRef = ref<HTMLImageElement | null>(null)
const address = ref('')
const addressFocused = ref(false)
const busy = ref(false)
const notice = ref('')
const noticeKind = ref<'info' | 'warn' | 'error'>('info')

const available = computed(() => !!window.electronAPI?.browserAction)
const canBack = computed(() => canGoBack())
const canForward = computed(() => canGoForward())

let timer: ReturnType<typeof setInterval> | null = null
let lastFrameAt = 0
let resizeObserver: ResizeObserver | null = null
let resizeTimer: ReturnType<typeof setTimeout> | null = null

function say(text: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
  notice.value = text
  noticeKind.value = kind
  if (kind === 'error') ElMessage.error(text)
}

/** 地址栏归一化：无协议时补 https，识别搜索词交给必应 */
function normalizeAddress(raw: string): string {
  const text = String(raw || '').trim()
  if (!text) return ''
  if (/^https?:\/\//i.test(text)) return text
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text) || text.startsWith('localhost')) {
    return `https://${text}`
  }
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`
}

// Agent 在别处导航了 → 地址栏跟随（用户正在输入时不打断）
watch(() => browserView.url, (url) => {
  if (!addressFocused.value) address.value = url && url !== 'about:blank' ? url : ''
})

async function syncViewport(): Promise<void> {
  const el = surfaceRef.value
  if (!el || el.clientWidth < 100) return
  const width = Math.max(320, Math.min(3840, Math.round(el.clientWidth)))
  const height = Math.max(240, Math.min(2160, Math.round(Math.max(el.clientHeight, 240))))
  if (Math.abs(width - browserView.viewport.width) < VIEWPORT_MIN_DELTA
    && Math.abs(height - browserView.viewport.height) < VIEWPORT_MIN_DELTA) return
  const res = await browserAction('viewport', { width, height })
  if (res.success && res.viewport) browserView.viewport = res.viewport
}

/** 取一帧画面；force 为 true 时忽略节流 */
async function capture(force = false): Promise<void> {
  if (!available.value || busy.value) return
  const gap = browserView.agentBusy ? FRAME_MS_AGENT : FRAME_MS_IDLE
  if (!force && Date.now() - lastFrameAt < gap) return
  lastFrameAt = Date.now()
  try {
    const res = await runBrowserAction('screenshot', { type: 'jpeg', quality: 70 })
    if (res.success && res.data) {
      browserView.image = `data:image/${res.type || 'jpeg'};base64,${res.data}`
      if (res.viewport) browserView.viewport = res.viewport
      if (!addressFocused.value) address.value = browserView.url || ''
      notice.value = ''
    } else if (res.error && !res.error.startsWith('DOMAIN_BLOCKED')) {
      say(res.error, 'error')
    }
  } catch (e: any) {
    say(`画面获取失败：${e?.message || e}`, 'error')
  }
}

async function navigate(raw: string): Promise<void> {
  const url = normalizeAddress(raw)
  if (!url) return
  if (!isUrlAllowed(browserPolicy, url)) {
    const host = url.replace(/^https?:\/\//, '').split('/')[0]
    say(`域名白名单已开启，${host} 不在允许列表中。可在「设置 → 浏览器安全」调整。`, 'warn')
    return
  }
  if (!(await confirmNavigation(url, 'manual'))) {
    say('已取消访问', 'info')
    return
  }
  busy.value = true
  try {
    await syncViewport()
    const res = await runBrowserAction('navigate', { url })
    if (!res.success) {
      say(res.error || '页面加载失败', 'error')
      return
    }
    address.value = browserView.url || url
    await capture(true)
    if (res.httpStatus && res.httpStatus >= 400) say(`页面返回 HTTP ${res.httpStatus}`, 'warn')
  } finally {
    busy.value = false
  }
}

async function goBack(): Promise<void> {
  busy.value = true
  try {
    const res = await runBrowserAction('back', {}, true)
    if (!res.success) say(res.error || '后退失败', 'error')
    else if (!res.moved) say('没有可后退的历史记录', 'info')
    await capture(true)
  } finally {
    busy.value = false
  }
}

async function goForward(): Promise<void> {
  busy.value = true
  try {
    const res = await runBrowserAction('forward', {}, true)
    if (!res.success) say(res.error || '前进失败', 'error')
    else if (!res.moved) say('没有可前进的历史记录', 'info')
    await capture(true)
  } finally {
    busy.value = false
  }
}

async function reload(): Promise<void> {
  busy.value = true
  try {
    const res = await runBrowserAction('reload', {})
    if (!res.success) say(res.error || '刷新失败', 'error')
    await capture(true)
  } finally {
    busy.value = false
  }
}

async function closeBrowser(): Promise<void> {
  busy.value = true
  try {
    const res = await resetBrowserView()
    address.value = ''
    notice.value = ''
    say(res.success ? '浏览器实例已关闭' : (res.error || '关闭失败'), 'info')
  } finally {
    busy.value = false
  }
}

function toggleHold(): void {
  browserView.manualHold = !browserView.manualHold
  say(
    browserView.manualHold
      ? '已接管页面：Agent 的浏览器操作会自动等待你退出接管'
      : '已退出接管：Agent 可以继续操作页面',
    'info'
  )
}

/** 画面坐标 → 视口坐标（截图按容器宽度等比展示，故用比例换算） */
function toPagePoint(e: MouseEvent): { x: number; y: number } | null {
  const img = imgRef.value
  if (!img) return null
  const rect = img.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  const x = Math.round((e.clientX - rect.left) / rect.width * browserView.viewport.width)
  const y = Math.round((e.clientY - rect.top) / rect.height * browserView.viewport.height)
  if (x < 0 || y < 0 || x > browserView.viewport.width || y > browserView.viewport.height) return null
  return { x, y }
}

async function onSurfaceClick(e: MouseEvent): Promise<void> {
  if (browserView.agentBusy) {
    say('Agent 正在操作页面，已忽略本次点击（可先点「接管」让它暂停）', 'warn')
    return
  }
  const point = toPagePoint(e)
  if (!point) return
  const res = await runBrowserAction('mouse-click', point)
  if (!res.success) say(res.error || '点击失败', 'error')
  // 点击后立刻取帧，页面变化要马上看得见
  await capture(true)
}

async function onWheel(e: WheelEvent): Promise<void> {
  if (browserView.agentBusy) return
  const deltaY = Math.max(-600, Math.min(600, Math.round(e.deltaY)))
  if (!deltaY) return
  await runBrowserAction('mouse-wheel', { deltaY })
  await capture(true)
}

function startTimer(): void {
  stopTimer()
  timer = setInterval(() => {
    if (document.hidden || !browserView.active) return
    void capture()
  }, TICK_MS)
}

function stopTimer(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function handleResize(): void {
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    // 页面不存在时不同步视口，避免仅仅是拖拽面板就拉起 Chromium
    if (!browserView.active) return
    void (async () => {
      await syncViewport()
      await capture(true)
    })()
  }, 260)
}

onMounted(async () => {
  if (!available.value) return
  startTimer()
  await nextTick()
  // 恢复现场：Agent 可能已经把页面开好了（state 不会拉起 Chromium）
  const res = await runBrowserAction('state', {})
  if (res.success && res.active) {
    address.value = browserView.url || ''
    await syncViewport()
    await capture(true)
  } else {
    // 还没有页面：不主动启动内核，等用户导航或 Agent 打开页面时再说
    browserView.active = false
  }
  if (surfaceRef.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(surfaceRef.value)
  }
})

onBeforeUnmount(() => {
  stopTimer()
  resizeObserver?.disconnect()
  resizeObserver = null
  if (resizeTimer) clearTimeout(resizeTimer)
  // 面板关闭后不能继续挡住 Agent
  releaseManualHold()
})

// 白名单变化时提示一次，避免用户以为按钮坏了
watch(() => browserPolicy.allowlistEnabled, (on) => {
  if (on) say('域名白名单已开启，仅允许访问列表内站点', 'info')
})
</script>

<style scoped>
.bp-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-size: 12px;
  color: var(--ct-text-primary);
}

.bp-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px;
  border-bottom: 1px solid var(--ct-border);
}

.bp-btn {
  flex-shrink: 0;
  border: 1px solid var(--ct-border);
  background: var(--ct-bg);
  color: var(--ct-text-secondary);
  border-radius: 6px;
  padding: 2px 8px;
  font-size: 12px;
  line-height: 1.6;
  cursor: pointer;
}

.bp-btn:hover:not(:disabled) {
  border-color: var(--ct-accent);
  color: var(--ct-accent);
}

.bp-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.bp-btn-go {
  font-weight: 600;
}

.bp-btn-hold.is-on {
  border-color: var(--ct-accent);
  color: #fff;
  background: var(--ct-accent);
}

.bp-address {
  flex: 1;
  min-width: 80px;
  border: 1px solid var(--ct-border);
  border-radius: 6px;
  background: var(--ct-bg);
  color: var(--ct-text-primary);
  padding: 3px 8px;
  font-size: 12px;
  outline: none;
}

.bp-address:focus {
  border-color: var(--ct-accent);
}

.bp-status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-bottom: 1px solid var(--ct-border);
  color: var(--ct-text-muted);
}

.bp-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ct-text-secondary);
}

.bp-badge {
  flex-shrink: 0;
  border-radius: 8px;
  padding: 1px 6px;
  font-size: 11px;
}

.bp-badge-agent {
  background: rgba(240, 173, 78, 0.18);
  color: #b26a00;
}

.bp-badge-hold {
  background: rgba(64, 158, 255, 0.16);
  color: var(--ct-accent);
}

.bp-notice {
  padding: 4px 8px;
  font-size: 12px;
  line-height: 1.5;
  border-bottom: 1px solid var(--ct-border);
  white-space: pre-wrap;
  word-break: break-all;
}

.bp-notice.info {
  color: var(--ct-text-muted);
}

.bp-notice.warn {
  color: #b26a00;
}

.bp-notice.error {
  color: #c62828;
}

.bp-hint {
  padding: 16px 10px;
  color: var(--ct-text-muted);
  line-height: 1.7;
}

.bp-surface {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--ct-bg-tertiary);
  position: relative;
}

.bp-surface.is-locked {
  outline: 2px solid rgba(240, 173, 78, 0.5);
  outline-offset: -2px;
}

.bp-image {
  display: block;
  width: 100%;
  height: auto;
  cursor: pointer;
  user-select: none;
}

.bp-surface.is-locked .bp-image {
  cursor: not-allowed;
}

.bp-empty {
  padding: 20px 16px;
  line-height: 1.8;
  color: var(--ct-text-secondary);
}

.bp-empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ct-accent);
}

.bp-empty-muted {
  color: var(--ct-text-muted);
  font-size: 11px;
}

.bp-empty code {
  background: var(--ct-bg);
  padding: 1px 5px;
  border-radius: 4px;
  border: 1px solid var(--ct-border);
}
</style>
