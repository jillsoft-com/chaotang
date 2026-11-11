/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

// ============ 内嵌浏览器宿主（M2）============

/** 页面当前能不能拿到画面：由主进程按挂载/窗口/尺寸三态判定 */
type BrowserHostVisibility = 'visible' | 'detached' | 'minimized' | 'hidden' | 'zero-size'

interface BrowserHostTabInfo {
  id: string
  url: string
  title: string
  partition: string
  active: boolean
  mounted: boolean
}

/** state 与 browser-state 广播共用的面板状态体 */
interface BrowserHostState {
  active: boolean
  tabId: string | null
  url: string
  title: string
  httpStatus: number
  loadError: string
  blockedUrl: string
  viewport: { width: number; height: number }
  visibility: BrowserHostVisibility
  /**
   * 承载位置（M8-b）：'fg'=前台正常视图；'bg'=面板不可见时把标签页搬进离屏 ghost 孪生视图里跑。
   * 与 visibility 正交：bg 期间 visibility 仍是主窗口判出来的遮挡态，但真点击/截图照旧可用。
   */
  carrier: 'fg' | 'bg'
  /** 当前是否处于离屏后台承载（carrier==='bg' 的便捷镜像） */
  offscreen: boolean
  canCapture: boolean
  captureHint: string
  /**
   * 四位能力各自一个位（真事件矩阵探针实测）：拿不到画面不等于输入也停了。
   * 键盘不依赖前台状态，滚动只要求挂载且有尺寸，鼠标按下/抬起还要窗口没被藏起来。
   */
  canClick: boolean
  canWheel: boolean
  canKey: boolean
  /** canClick=false 时的原因，面板用它解释「为什么这一步可能不是真实点击」 */
  clickHint: string
  /** 历史栈可用性由主进程的 webContents 照实回答，面板不再自己记 */
  canBack: boolean
  canForward: boolean
  /** 渲染进程最近一次上报 bounds/detach 的结果：false 表示用户明确收起了面板 */
  panelVisible: boolean | null
  autoRaise: boolean
  /** 接管锁：由主进程持有，面板只是镜像；Agent 的写操作在锁上期间被拦住 */
  manualHold: boolean
  /** 锁的来路：panel=用户按的接管按钮，user-action/input=用户实际操作了页面 */
  holdSource: string
  policy: { allowlistEnabled?: boolean; allowlist?: string[]; strictAllowlist?: boolean }
  tabs: BrowserHostTabInfo[]
}

interface BrowserHostResult extends Partial<BrowserHostState> {
  success: boolean
  error?: string
  message?: string
  moved?: boolean
  data?: string
  type?: string
  result?: any
  accessibilityTree?: string
  truncated?: boolean
  frameUrl?: string
  tabs?: BrowserHostTabInfo[]
  manualHold?: boolean
  holdSource?: string
  autoRaise?: boolean
  /** 真事件拿不到合成层时退化为 JS 合成事件，此标记与 warning 一起给模型 */
  fallback?: boolean
  warning?: string
  hint?: string
  /** 只是暂时拿不到画面（窗口被遮挡、刚重挂载），调用方可以重试而不是当作失败 */
  retryable?: boolean
}

interface ElectronAPI {
  platform: string
  version: string
  loadApiKeys: () => Promise<Record<string, string>>
  saveApiKeys: (keys: Record<string, string>) => Promise<boolean>
  storeGet: (key: string) => Promise<string | null>
  storeGetAll: () => Promise<Record<string, string>>
  storeSet: (key: string, value: string) => Promise<boolean>
  storeDelete: (key: string) => Promise<boolean>
  storeSetSync: (key: string, value: string) => void
  storeDeleteSync: (key: string) => void
  storeGetPath: () => Promise<string>
  readFile: (filePath: string) => Promise<{ success: boolean; content?: string; sha256?: string; error?: string }>
  writeFile: (filePath: string, content: string) => Promise<{ success: boolean; path?: string; size?: number; error?: string }>
  patchFile: (filePath: string, patches: Array<{ oldText: string; newText: string; replaceAll?: boolean }>, expectedSha256?: string) => Promise<{
    success: boolean
    path?: string
    sha256?: string
    patchesApplied?: number
    matchCounts?: number[]
    currentSha256?: string
    errorCode?: 'FILE_NOT_FOUND' | 'VERSION_MISMATCH' | 'NOT_FOUND' | 'NOT_UNIQUE'
    patchIndex?: number
    matchCount?: number
    error?: string
  }>
  revertFile: (filePath: string, oldContent: string, expectedSha256: string) => Promise<{
    success: boolean
    path?: string
    sha256?: string
    reverted?: boolean
    currentSha256?: string
    errorCode?: 'FILE_NOT_FOUND' | 'VERSION_MISMATCH' | 'MISSING_VERSION' | 'VERSION_MISMATCH_AFTER_APPROVAL'
    error?: string
  }>
  createDirectory: (dirPath: string) => Promise<{ success: boolean; path?: string; error?: string }>
  authorizeWorkspace: (dirPath: string) => Promise<{ success: boolean; root?: string; error?: string }>
  readDirectory: (dirPath: string) => Promise<{
    success: boolean
    path?: string
    count?: number
    truncated?: boolean
    items?: Array<{ name: string; type: 'file' | 'directory'; size: number; modified: string | null }>
    error?: string
  }>
  readDocument: (filePath: string) => Promise<{
    success: boolean
    content?: string
    metadata?: Record<string, any>
    error?: string
  }>
  gitFileDiff: (params: { filePath: string; cwd?: string; mode?: 'uncommitted' | 'staged' | 'unstaged' | 'last' }) => Promise<{
    success: boolean
    status?: 'modified' | 'unmodified' | 'untracked' | 'notgit' | 'error'
    diff?: string
    hasChanges?: boolean
    path?: string
    truncated?: boolean
    error?: string
  }>
  executeCommand: (params: {
    command: string
    cwd?: string
    shell?: string
    timeout?: number
  }) => Promise<{
    success: boolean
    exitCode: number
    stdout: string
    stderr: string
    timedOut?: boolean
    sandboxed?: boolean
  }>
  searchCode: (params: {
    pattern: string
    directory: string
    filePattern?: string
    maxResults?: number
    isRegex?: boolean
  }) => Promise<{
    success: boolean
    pattern: string
    directory: string
    filesScanned: number
    matchCount: number
    truncated: boolean
    results: Array<{ file: string; line: number; content: string }>
    error?: string
  }>
  runTests: (params: {
    cwd?: string
    testCommand?: string
    framework?: string
  }) => Promise<{
    success: boolean
    exitCode: number
    command: string
    stdout: string
    stderr: string
    summary: string
    timedOut?: boolean
  }>
  showOpenDialog: (options: {
    properties?: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles'>
    title?: string
    defaultPath?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }) => Promise<{ canceled: boolean; filePaths: string[]; fileToken?: string; error?: string }>
  showSaveDialog: (options: {
    title?: string
    defaultPath?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }) => Promise<{ canceled: boolean; filePath?: string; fileToken?: string; error?: string }>

  // 沙箱配置
  getSandboxConfig: () => Promise<{
    enabled: boolean
    blockNetwork: boolean
    maxMemoryMB: number
    maxTimeout: number
  }>
  saveSandboxConfig: (config: {
    enabled?: boolean
    blockNetwork?: boolean
    maxMemoryMB?: number
    maxTimeout?: number
  }) => Promise<boolean>

  // 插件系统
  scanPlugins: () => Promise<string[]>
  readPlugin: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>
  getPluginDir: () => Promise<string>
  openPluginDir: () => Promise<boolean>

  // 附件
  readAttachment: (filePath: string) => Promise<{
    success: boolean
    content?: string
    fileName?: string
    fileSize?: number
    fileType?: string
    error?: string
  }>

  // 任意文件读写（对话框授权的一次性令牌机制）
  readArbitraryFile: (filePath: string, token: string) => Promise<{ success: boolean; content?: string; error?: string }>
  writeArbitraryFile: (filePath: string, content: string, token: string) => Promise<{ success: boolean; path?: string; size?: number; error?: string }>

  // 内嵌浏览器宿主：浏览器自动化只走这一条（旧的 Playwright browser-action 通道已在 M7 删除）
  browserHostAction: (params: {
    action:
      | 'tab-list' | 'tab-open' | 'tab-select' | 'tab-close'
      | 'navigate' | 'back' | 'forward' | 'reload' | 'stop' | 'state'
      | 'set-policy' | 'set-hold' | 'set-bounds' | 'detach' | 'attach' | 'set-auto-raise'
      | 'viewport' | 'screenshot' | 'snapshot' | 'query' | 'evaluate'
      | 'click' | 'mouse-click' | 'hover' | 'type' | 'keyboard'
      | 'scroll' | 'mouse-wheel' | 'frame-evaluate' | 'close'
    params?: Record<string, any>
    /**
     * 调用方身份：'agent'（模型）或 'user'（面板），缺省按 'user' 算。
     * 主进程的接管锁只拦 Agent 的写操作，用户的按钮必须照常用；
     * 控制面动作（策略/接管锁/面板区域）只接受 'user'。
     */
    actor?: 'agent' | 'user'
  }) => Promise<BrowserHostResult>
  onBrowserState: (callback: (state: BrowserHostState) => void) => () => void
  onBrowserRaise: (callback: (data: { reason: string; tabId?: string }) => void) => () => void
  onBrowserBlocked: (callback: (data: {
    tabId?: string
    /** 权限申请不带地址（当时连要去哪里都没问成），下载与请求才有 */
    url?: string
    host?: string
    /** 拦下的是哪一类：导航 / 子资源请求 / 下载 / 权限申请 */
    kind?: 'navigation' | 'request' | 'download' | 'permission'
    reason?: string
    resourceType?: string
    permission?: string
    filename?: string
  }) => void) => () => void
  /** 接管锁变化：面板上的锁状态以此为准，不再只看自己那个按钮 */
  onBrowserHold: (callback: (data: { on: boolean; source?: string }) => void) => () => void
  onBrowserGesture: (callback: (data: {
    tabId?: string
    /** 填写动作只带坐标与字数，正文永远不进事件（表单里可能是密码） */
    type: 'click' | 'hover' | 'key' | 'wheel' | 'type'
    x?: number
    y?: number
    key?: string
    deltaX?: number
    deltaY?: number
    length?: number
    /** true = 窗口遮挡时退化成 JS 合成事件，覆盖层据此画成示意态 */
    synthetic?: boolean
  }) => void) => () => void
  onBrowserTabOpened: (callback: (data: { tabId: string; url: string; fromTabId?: string }) => void) => () => void

  // 企业微信 Webhook
  sendWebhook: (params: {
    webhookUrl: string
    message: string
    msgType?: 'text' | 'markdown'
  }) => Promise<{ success: boolean; message?: string; error?: string }>
  startWebhookServer: (params: {
    port?: number
  }) => Promise<{ success: boolean; port?: number; message?: string; error?: string }>
  stopWebhookServer: () => Promise<{ success: boolean; message?: string }>
  onWebhookMessage: (callback: (data: any) => void) => () => void
}

interface Window {
  electronAPI?: ElectronAPI
}
