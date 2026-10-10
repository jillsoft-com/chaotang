/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface ElectronAPI {
  platform: string
  version: string
  loadApiKeys: () => Promise<Record<string, string>>
  saveApiKeys: (keys: Record<string, string>) => Promise<boolean>
  readFile: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>
  writeFile: (filePath: string, content: string) => Promise<{ success: boolean; path?: string; size?: number; error?: string }>
  createDirectory: (dirPath: string) => Promise<{ success: boolean; path?: string; error?: string }>
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
  }) => Promise<{ canceled: boolean; filePaths: string[]; error?: string }>

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

  // 浏览器自动化
  browserAction: (params: {
    action: 'navigate' | 'screenshot' | 'snapshot' | 'click' | 'type' | 'evaluate' | 'close'
    params?: Record<string, any>
  }) => Promise<{
    success: boolean
    error?: string
    title?: string
    url?: string
    data?: string
    type?: string
    accessibilityTree?: string
    truncated?: boolean
    result?: any
    message?: string
  }>

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
