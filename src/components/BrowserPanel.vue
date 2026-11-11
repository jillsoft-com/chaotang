<template>
  <div class="bp-panel">
    <!--
      宿主标签条：每个标签都是一个独立的真实页面（独立分区、独立历史）。
      只有一个页面时不显示（新建入口在工具条的 ＋），避免与外层面板 tab 看起来重复；
      开了 2 个及以上才自动出现。
    -->
    <div v-if="embedded && hostState.tabs.length >= 2" class="bp-tabs">
      <button
        v-for="t in hostState.tabs"
        :key="t.id"
        class="bp-tab"
        :class="{ 'is-active': t.id === hostState.activeTabId }"
        :title="t.url || '空白页'"
        @click="selectHostTab(t.id)"
      >
        <span class="bp-tab-title">{{ t.title || '新标签' }}</span>
        <span class="bp-tab-close" title="关闭标签页" @click.stop="closeHostTab(t.id)">✕</span>
      </button>
    </div>

    <!-- 控制条：后退 / 前进 / 刷新 / 地址栏 -->
    <div class="bp-toolbar">
      <button class="bp-btn" :disabled="!canBack || busy || browserView.agentBusy" title="后退" @click="goBack">←</button>
      <button class="bp-btn" :disabled="!canForward || busy || browserView.agentBusy" title="前进" @click="goForward">→</button>
      <button class="bp-btn" :disabled="!pageActive || busy || browserView.agentBusy" title="刷新当前页面" @click="reload">⟳</button>
      <button v-if="embedded" class="bp-btn" :disabled="busy" title="停止加载" @click="stopLoad">■</button>

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
      <button v-if="embedded" class="bp-btn" :disabled="busy" title="新建标签页" @click="newHostTab">＋</button>
      <button class="bp-btn" :disabled="busy" :title="embedded ? '关闭所有标签页（页面仍在内存里，直到实例关闭）' : '关闭浏览器实例（释放内存）'" @click="closeBrowser">✕</button>
    </div>

    <!-- 状态条：标题、占用提示、接管开关 -->
    <div class="bp-status">
      <span class="bp-title" :title="pageUrl">{{ pageTitle || '空白页' }}</span>
      <span v-if="browserView.agentBusy" class="bp-badge bp-badge-agent">
        ⚡ Agent 正在操作{{ browserView.agentLabel ? ` · ${browserView.agentLabel}` : '' }}
      </span>
      <span v-else-if="browserView.manualHold" class="bp-badge bp-badge-hold" title="你在页面上动过手，Agent 的写操作已自动暂停；停止操作约 20 秒后会自动交还 Agent">已接管 · Agent 已暂停</span>
      <span v-else-if="embedded && !hostState.canCapture && hostState.active" class="bp-badge bp-badge-off" :title="hostState.captureHint">
        {{ visibilityLabel }}
      </span>
      <!--
        点击位单独提醒（M8）：拿不到画面不等于输入也停了，反过来也一样 ——
        窗口最小化时键盘和滚动仍是真实事件，只有鼠标点击会退化成 JS 合成。
      -->
      <span
        v-if="clickOffBadge"
        class="bp-badge bp-badge-off"
        :title="hostState.clickHint"
      >{{ clickOffBadge }}</span>
      <!--
        后台承载徽标（M8-b）：面板不可见时页面住在离屏 ghost 孪生视图里，
        Agent 的真点击/输入/截图都在那里照常发生，与前台遮挡态不同。
      -->
      <span
        v-if="hostState.carrier === 'bg'"
        class="bp-badge bp-badge-bg"
        title="面板未显示，页面正在离屏后台运行，Agent 的真点击与截图照常可用；切回浏览器标签即回到前台"
      >🌙 后台运行中</span>
      <!--
        Agent 动作的文本提示（M5）。假鼠标画在独立的透明覆盖窗里（BrowserView 会盖住面板 DOM），
        这里是两道保险：平台不支持透明窗口时至少还有文字，同一段文案也供读屏使用。
      -->
      <span
        v-if="gestureText"
        class="bp-badge bp-badge-gesture"
        :class="{ 'is-syn': gestureSynthetic }"
        aria-live="polite"
        :title="gestureSynthetic ? '窗口不可见，该动作已退化为 JS 合成事件（isTrusted=false）' : 'Agent 刚刚对页面做的操作'"
      >{{ gestureText }}</span>
    </div>

    <div v-if="notice" class="bp-notice" :class="noticeKind">
      <span class="bp-notice-text">{{ notice }}</span>
      <button class="bp-notice-close" title="关闭提示" @click="dismissNotice">✕</button>
    </div>

    <div v-if="!available" class="bp-hint">
      内嵌浏览器需要宿主通道支持：Web 模式下不可用，旧版安装包请重启应用。
    </div>

    <!-- 画面区：这块矩形留给真实页面，下面的文案只在页面没画上来时露出 -->
    <div v-else ref="surfaceRef" class="bp-surface is-embed" :class="{ 'is-locked': browserView.agentBusy }">
      <div class="bp-hole">
        <div v-if="!hostState.active" class="bp-empty">
          <p class="bp-empty-title">🌐 内置浏览器</p>
          <p>在上方地址栏输入网址并回车，Agent 也可以使用浏览器工具（browser_navigate 等）。</p>
          <p class="bp-empty-muted">页面会直接画在这片区域上，可以像平时用浏览器一样点击、输入、滚动。</p>
        </div>
        <div v-else-if="!hostState.canCapture" class="bp-empty">
          <p class="bp-empty-title">{{ visibilityLabel }}</p>
          <p class="bp-empty-muted">{{ hostState.captureHint }}</p>
          <p class="bp-empty-muted">页面仍在正常运行：取内容、执行脚本、按键与滚动都不受影响；只有鼠标点击会退化成 JS 合成事件。</p>
          <button class="bp-btn" @click="showSurfaceNow">显示页面</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { browserView, releaseManualHold } from '@/services/browser/browser-session'
import { browserPolicy, isUrlAllowed, confirmNavigation } from '@/services/browser/browser-policy'
import { GESTURE_FRESH_MS, gestureLabel, latestVisibleGesture } from '@/services/browser/browser-gesture'
import {
  hostState,
  isHostAvailable,
  hostAction,
  observeSurface,
  syncSurface,
  releaseSurface,
  closeAllTabs,
  refreshHostState,
  ensureHostListeners,
  openTab,
  selectTab,
  closeTab,
  setHold
} from '@/services/browser/browser-host-session'

/** 主进程的三态降级文案：面板要说清「为什么看不到画面」而不是默默空着一块 */
const VISIBILITY_LABELS: Record<string, string> = {
  visible: '画面正常',
  detached: '页面未上屏',
  minimized: '窗口已最小化',
  hidden: '窗口被遮挡',
  'zero-size': '面板尺寸过小'
}

/**
 * 宿主通道是否就位。
 * 浏览器自动化只有内嵌宿主一条路，但 Web 模式与旧安装包不携带该通道，
 * 那里preload 里没有 browserHostAction，只能展示提示文案；本组件生命周期内固定，
 * 所以只在 setup 读一次，不做成 computed 去跟随 hostState。
 */
const embedded = isHostAvailable()

const surfaceRef = ref<HTMLElement | null>(null)
const address = ref('')
const addressFocused = ref(false)
const busy = ref(false)
const notice = ref('')
const noticeKind = ref<'info' | 'warn' | 'error'>('info')
/** 最近一次 Agent 动作的文字提示（到点自动消失，见 refreshGestureText） */
const gestureText = ref('')
const gestureSynthetic = ref(false)

const available = computed(() => hostState.available)
// 历史栈来自主进程（真实页面自己会回答 canBack / canForward）
const canBack = computed(() => hostState.canBack)
const canForward = computed(() => hostState.canForward)
const pageActive = computed(() => hostState.active)
const pageUrl = computed(() => hostState.url)
const pageTitle = computed(() => hostState.title)
const visibilityLabel = computed(() => VISIBILITY_LABELS[hostState.visibility] || '画面暂不可用')
/**
 * 鼠标点击不可达时的徽标文案（M8）。
 * 只在 Agent 正在操作且页面确实活着时提示，否则用户自己看着空白面板会莫名其妙。
 */
const clickOffBadge = computed(() => {
  if (!embedded || !hostState.active) return ''
  if (hostState.canClick || !browserView.agentBusy) return ''
  return '点击不是真实事件'
})

let stopObserve: (() => void) | null = null
/** 动作提示的过期定时器 */
let gestureTimer: ReturnType<typeof setTimeout> | null = null
/** 提示条的自动消失定时器（info/warn 与 error 时长不同） */
let noticeTimer: ReturnType<typeof setTimeout> | null = null

function say(text: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
  notice.value = text
  noticeKind.value = kind
  // 每次重新提示都重新计时：旧的错误不该把新的成功也一起吹掉
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { notice.value = ''; noticeTimer = null }, kind === 'error' ? 15000 : 8000)
  if (kind === 'error') ElMessage.error(text)
}

/** 手动关掉提示条（右上角 ✕），同时取消未到点的自动消失计时 */
function dismissNotice(): void {
  notice.value = ''
  if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null }
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
watch(pageUrl, (url) => {
  if (!addressFocused.value) address.value = url && url !== 'about:blank' ? url : ''
})

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
    // 没有标签页时宿主会自动开一个；开好后必须把区域报上去，页面才会真正画上来
    const res = await hostAction('navigate', { url })
    if (!res.success) {
      say(res.error || '页面加载失败', 'error')
      return
    }
    await syncSurface(surfaceRef.value, { force: true })
    address.value = hostState.url || url
    if (res.httpStatus && res.httpStatus >= 400) say(`页面返回 HTTP ${res.httpStatus}`, 'warn')
    if (res.loadError) say(res.loadError, 'warn')
  } finally {
    busy.value = false
  }
}

async function goBack(): Promise<void> {
  busy.value = true
  try {
    const res = await hostAction('back', {})
    if (!res.success) say(res.error || '后退失败', 'error')
    else if (!res.moved) say('没有可后退的历史记录', 'info')
  } finally {
    busy.value = false
  }
}

async function goForward(): Promise<void> {
  busy.value = true
  try {
    const res = await hostAction('forward', {})
    if (!res.success) say(res.error || '前进失败', 'error')
    else if (!res.moved) say('没有可前进的历史记录', 'info')
  } finally {
    busy.value = false
  }
}

async function reload(): Promise<void> {
  busy.value = true
  try {
    const res = await hostAction('reload', {})
    if (!res.success) say(res.error || '刷新失败', 'error')
  } finally {
    busy.value = false
  }
}

/** 内嵌模式专有：中断加载。真实页面自己就能跑，不需要等宿主 */
async function stopLoad(): Promise<void> {
  const res = await hostAction('stop', {})
  if (!res.success) say(res.error || '停止失败', 'error')
}

async function closeBrowser(): Promise<void> {
  busy.value = true
  try {
    const res = await closeAllTabs()
    await refreshHostState()
    address.value = ''
    notice.value = ''
    say(res.success ? '已关闭全部标签页' : (res.error || '关闭失败'), 'info')
  } finally {
    busy.value = false
  }
}

// ============ 内嵌宿主的标签页与区域上报 ============

async function newHostTab(): Promise<void> {
  busy.value = true
  try {
    const res = await openTab()
    if (!res.success) {
      say(res.error || '新建标签页失败', 'error')
      return
    }
    // 活动标签页变了会有人负责把画面挂上来（见 watch(activeTabId)），这里不再重复上报
    address.value = ''
  } finally {
    busy.value = false
  }
}

async function selectHostTab(tabId: string): Promise<void> {
  busy.value = true
  try {
    // 点的是当前标签页：视为「画面没出来，我要它出来」，走带 force 的重挂入口
    if (tabId === hostState.activeTabId) {
      await showSurfaceNow()
      return
    }
    const res = await selectTab(tabId)
    if (!res.success) {
      say(res.error || '切换标签页失败', 'error')
    }
    // 真的换了活动页时由 watch(activeTabId) 负责把画面挂上来，这里不再重复上报
  } finally {
    busy.value = false
  }
}

async function closeHostTab(tabId: string): Promise<void> {
  busy.value = true
  try {
    const res = await closeTab(tabId)
    if (!res.success) say(res.error || '关闭标签页失败', 'error')
  } finally {
    busy.value = false
  }
}

/**
 * 把页面重新画上来了。
 * 尺寸没变但页面换了（或者面板从收起变成展开）时，去抖会认为无需上报，
 * 所以这个入口必须带 force。
 */
async function showSurfaceNow(): Promise<void> {
  const ok = await syncSurface(surfaceRef.value, { force: true })
  if (!ok) {
    say(hostState.lastError || '页面显示失败', 'error')
    return
  }
  if (!hostState.canCapture) say(hostState.captureHint || '画面仍不可用', 'warn')
  else notice.value = ''
}

/**
 * 刷新动作提示。
 * 只认活动标签页的动作（那块矩形显示的就是活动页），并且过一期就不再说；
 * 挂着一个小时前的「已点击」比什么都不标更误导人。
 */
function refreshGestureText(): void {
  const gesture = latestVisibleGesture(hostState.gestures, hostState.activeTabId, Date.now())
  if (!gesture) {
    gestureText.value = ''
    gestureSynthetic.value = false
    if (gestureTimer) { clearTimeout(gestureTimer); gestureTimer = null }
    return
  }
  gestureText.value = gestureLabel(gesture)
  gestureSynthetic.value = gesture.synthetic
  if (gestureTimer) clearTimeout(gestureTimer)
  gestureTimer = setTimeout(refreshGestureText, GESTURE_FRESH_MS)
}

/**
 * 接管锁不再提供面板按钮：主进程会在用户于页面上真实输入时自动上锁（holdSource=user-action），
 * 并于 20 秒空闲后自动交还；面板只负责把锁态徒为“已接管”徽标。
 * 面板销毁时（下方 onBeforeUnmount）仍需主动 setHold(false)，否则主进程会把 Agent 永远锁住。
 */

onMounted(async () => {
  ensureHostListeners()
  await nextTick()
  // 恢复现场：Agent 可能已经把页面开好了（state 动作不会拉起页面）
  await refreshHostState()
  // 恢复现场也包括动作提示：面板收起来的那段时间里 Agent 照样在操作页面
  refreshGestureText()
  address.value = hostState.url && hostState.url !== 'about:blank' ? hostState.url : ''
  if (surfaceRef.value) {
    // 先报区域再开始跟踪。就算此刻一个标签页都没有也得报：
    // boundsKnown 是宿主判定「面板在界面上」的前提，不报的话 Agent 导航完的页面画不上来
    await syncSurface(surfaceRef.value, { force: true })
    stopObserve = observeSurface(surfaceRef.value)
  }
})

onBeforeUnmount(() => {
  if (gestureTimer) {
    clearTimeout(gestureTimer)
    gestureTimer = null
  }
  if (noticeTimer) {
    clearTimeout(noticeTimer)
    noticeTimer = null
  }
  stopObserve?.()
  stopObserve = null
  // 标签切走或面板收起时必须把页面从界面上卸下，否则会盖住当时正在看的那个标签
  void releaseSurface()
  // 锁归主进程：面板不在了就不能再挡 Agent，只清本地标记会把它永远锁住
  if (browserView.manualHold) void setHold(false)
  releaseManualHold()
})

// 宿主请求把浏览器唤到前台（Agent 需要画面）：面板活着的话重新把洞报上去
// 标签栏、整个面板都不在时的切换由 HomeView 响应同一个信号完成
watch(() => hostState.raiseSeq, async () => {
  await nextTick()
  await syncSurface(surfaceRef.value, { force: true })
})

// 活动标签页换了（用户点标签、Agent 调 tab-select、页面弹窗转成新标签）就得让新页面上屏。
// 这是唯一的触发点：主进程在这些动作里会顺手挂载，但只有渲染进程知道占位区此刻的真实矩形，
// 所以统一由这里带 force 补一次上报，标签页按钮自己不再重复发（否则会双份 IPC）。
watch(() => hostState.activeTabId, async () => {
  // 上个标签页的动作提示对新页面没有意义，立即重算（不是每个动作都画得出来）
  refreshGestureText()
  await nextTick()
  await syncSurface(surfaceRef.value, { force: true })
})

// Agent 每做一步输入都推一条 gesture：面板上的文字提示跟着刷新并自己过期
watch(() => hostState.gestureSeq, () => refreshGestureText())

// 主进程拦下来的东西都只能靠事件推过来：面板自己碰不到页面内部的跳转、下载与权限申请
watch(() => hostState.blockedSeq, () => {
  const target = hostState.blockedHost || hostState.blockedUrl || '该请求'
  const text = hostState.blockedKind === 'download'
    ? `下载已被拦下：${target}。需要文件请到浏览器里自己下载。`
    : hostState.blockedKind === 'permission'
      ? `页面申请的「${hostState.blockedDetail || '设备权限'}」已被拒绝：内嵌浏览器不代替你授权摄像头、定位与通知。`
      : hostState.blockedKind === 'request'
        ? `白名单已拦住页面发起的请求：${target}。可在「设置 → 浏览器安全」调整。`
        : `域名白名单已拦住跳转：${target}。可在「设置 → 浏览器安全」调整。`
  say(text, 'warn')
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

.bp-tabs {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  padding: 4px 4px 0;
  border-bottom: 1px solid var(--ct-border);
  overflow-x: auto;
  scrollbar-width: thin;
}

.bp-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 150px;
  border: 1px solid var(--ct-border);
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  background: var(--ct-bg);
  color: var(--ct-text-muted);
  padding: 2px 6px;
  font-size: 11px;
  line-height: 1.5;
  cursor: pointer;
}

.bp-tab.is-active {
  background: var(--ct-bg-tertiary);
  color: var(--ct-text-primary);
  border-color: var(--ct-accent);
}

.bp-tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bp-tab-close {
  flex-shrink: 0;
  opacity: 0.55;
}

.bp-tab-close:hover {
  opacity: 1;
  color: #c62828;
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

.bp-badge-off {
  background: rgba(144, 147, 153, 0.18);
  color: var(--ct-text-muted);
}

/* 后台承载（M8-b）：页面住在离屏 ghost 孪生视图里，用蓝紫色跟遮挡态的灰色区分开 */
.bp-badge-bg {
  background: rgba(114, 46, 209, 0.16);
  color: #5b2d9e;
}

/* 动作提示：真事件用主色，退化（合成）用琥珀色，跟覆盖层里的假鼠标同一套语义 */
.bp-badge-gesture {
  background: rgba(47, 111, 237, 0.14);
  color: #1f56b3;
}

.bp-badge-gesture.is-syn {
  background: rgba(245, 166, 35, 0.2);
  color: #8a5a00;
}

.bp-notice {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 4px 8px;
  font-size: 12px;
  line-height: 1.5;
  border-bottom: 1px solid var(--ct-border);
}

.bp-notice-text {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-all;
}

.bp-notice-close {
  flex: none;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
  line-height: 1.4;
  padding: 0 2px;
  opacity: 0.65;
}

.bp-notice-close:hover {
  opacity: 1;
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

/*
 * 内嵌模式：这块矩形归 BrowserView，容器自用的滚动与缩放都会让上报的区域
 * 和实际看到的位置对不上，所以这里锁住 overflow，把文案层放在它下面。
 */
.bp-surface.is-embed {
  overflow: hidden;
}

.bp-hole {
  position: absolute;
  inset: 0;
  overflow: auto;
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
</style>
