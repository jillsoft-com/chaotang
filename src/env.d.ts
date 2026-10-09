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
}

interface Window {
  electronAPI?: ElectronAPI
}
