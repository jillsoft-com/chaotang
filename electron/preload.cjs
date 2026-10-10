const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  version: process.versions.electron,
  loadApiKeys: () => ipcRenderer.invoke('load-api-keys'),
  saveApiKeys: (keys) => ipcRenderer.invoke('save-api-keys', keys),
  // 文件操作通道
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  createDirectory: (dirPath) => ipcRenderer.invoke('create-directory', dirPath),
  readDirectory: (dirPath) => ipcRenderer.invoke('read-directory', dirPath),
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
  // 浏览器自动化通道
  browserAction: (params) => ipcRenderer.invoke('browser-action', params),
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
