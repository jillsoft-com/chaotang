const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  version: process.versions.electron,
  loadApiKeys: () => ipcRenderer.invoke('load-api-keys'),
  saveApiKeys: (keys) => ipcRenderer.invoke('save-api-keys', keys),
  // 本地键值存储通道
  storeGet: (key) => ipcRenderer.invoke('store-get', key),
  storeGetAll: () => ipcRenderer.invoke('store-get-all'),
  storeSet: (key, value) => ipcRenderer.invoke('store-set', key, value),
  storeDelete: (key) => ipcRenderer.invoke('store-delete', key),
  storeSetSync: (key, value) => {
    const result = ipcRenderer.sendSync('store-set-sync', key, value)
    if (!result?.success) throw new Error(result?.error || '本地存储写入失败')
  },
  storeDeleteSync: (key) => {
    const result = ipcRenderer.sendSync('store-delete-sync', key)
    if (!result?.success) throw new Error(result?.error || '本地存储删除失败')
  },
  storeGetPath: () => ipcRenderer.invoke('store-get-path'),
  // 文件操作通道
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  patchFile: (filePath, patches, expectedSha256) => ipcRenderer.invoke('patch-file', filePath, patches, expectedSha256),
  revertFile: (filePath, oldContent, expectedSha256) => ipcRenderer.invoke('revert-file', filePath, oldContent, expectedSha256),
  createDirectory: (dirPath) => ipcRenderer.invoke('create-directory', dirPath),
  readDirectory: (dirPath) => ipcRenderer.invoke('read-directory', dirPath),
  // git 只读 diff（供工程面板展示文件相对基准的 unified diff）
  gitFileDiff: (params) => ipcRenderer.invoke('git-file-diff', params),
  // 用已持久化的工作目录重新授权（重启/重载后恢复，无需重新选择）
  authorizeWorkspace: (dirPath) => ipcRenderer.invoke('authorize-workspace', dirPath),
  // 文档解析通道
  readDocument: (filePath) => ipcRenderer.invoke('read-document', filePath),
  // 命令行执行通道
  executeCommand: (params) => ipcRenderer.invoke('execute-command', params),
  // 代码搜索通道
  searchCode: (params) => ipcRenderer.invoke('search-code', params),
  // 测试执行通道
  runTests: (params) => ipcRenderer.invoke('run-tests', params),
  // 对话框通道
  showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
  // 沙箱配置通道
  getSandboxConfig: () => ipcRenderer.invoke('get-sandbox-config'),
  saveSandboxConfig: (config) => ipcRenderer.invoke('save-sandbox-config', config),
  // 插件系统通道
  scanPlugins: () => ipcRenderer.invoke('scan-plugins'),
  readPlugin: (filePath) => ipcRenderer.invoke('read-plugin', filePath),
  getPluginDir: () => ipcRenderer.invoke('get-plugin-dir'),
  openPluginDir: () => ipcRenderer.invoke('open-plugin-dir'),
  // 附件通道
  readAttachment: (filePath) => ipcRenderer.invoke('read-attachment', filePath),
  // 任意文件读写通道（对话框授权的一次性令牌机制）
  readArbitraryFile: (filePath, token) => ipcRenderer.invoke('read-arbitrary-file', filePath, token),
  writeArbitraryFile: (filePath, content, token) => ipcRenderer.invoke('write-arbitrary-file', filePath, content, token),
  // 内嵌浏览器宿主通道：浏览器自动化只走这一条（旧的 browser-action 随 Playwright 一起删了）
  browserHostAction: (params) => ipcRenderer.invoke('browser-host-action', params),
  // 宿主主动推给面板的事件：返回卸载函数，沿用 onWebhookMessage 的写法
  onBrowserState: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('browser-state', handler)
    return () => ipcRenderer.removeListener('browser-state', handler)
  },
  onBrowserRaise: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('browser-raise', handler)
    return () => ipcRenderer.removeListener('browser-raise', handler)
  },
  onBrowserBlocked: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('browser-blocked', handler)
    return () => ipcRenderer.removeListener('browser-blocked', handler)
  },
  // 接管锁变化：锁由主进程持有，面板上的按钮状态是这个事件的镜像
  onBrowserHold: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('browser-hold', handler)
    return () => ipcRenderer.removeListener('browser-hold', handler)
  },
  onBrowserGesture: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('browser-gesture', handler)
    return () => ipcRenderer.removeListener('browser-gesture', handler)
  },
  onBrowserTabOpened: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('browser-tab-opened', handler)
    return () => ipcRenderer.removeListener('browser-tab-opened', handler)
  },
  // 企业微信 Webhook 通道
  sendWebhook: (params) => ipcRenderer.invoke('send-webhook', params),
  startWebhookServer: (params) => ipcRenderer.invoke('start-webhook-server', params),
  stopWebhookServer: () => ipcRenderer.invoke('stop-webhook-server'),
  onWebhookMessage: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('webhook-message', handler)
    return () => ipcRenderer.removeListener('webhook-message', handler)
  }
})
