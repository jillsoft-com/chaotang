const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  version: process.versions.electron,
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
  showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options)
})
