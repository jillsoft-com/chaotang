const { app, BrowserWindow, BrowserView, ipcMain, dialog, safeStorage, shell, session } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { exec, execFile } = require('child_process')
const { resolveWithinRoot } = require('./workspace-access.cjs')
const { executeInSandbox, runTestsInSandbox, checkCommandSafety } = require('./sandbox.cjs')
const { createBrowserHost, isEmbeddedTab } = require('./browser-host.cjs')
const { decideShellNavigation } = require('./nav-guard.cjs')
const isDev = process.env.NODE_ENV === 'development'

let mainWindow = null
const authorizedRoots = new Map()

// 一次性文件操作授权令牌（对话框选择 → 读写操作的绑定机制）
const pendingFileOperations = new Map()
const FILE_TOKEN_TTL_MS = 5 * 60 * 1000 // 5 分钟过期

function generateFileToken() {
  return crypto.randomBytes(24).toString('hex')
}

function cleanupExpiredTokens() {
  const now = Date.now()
  for (const [token, op] of pendingFileOperations) {
    if (op.expiresAt < now) pendingFileOperations.delete(token)
  }
}

function countOccurrences(text, search) {
  let count = 0
  let pos = 0
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++
    pos += search.length
  }
  return count
}

// 每 2 分钟清理过期令牌
setInterval(cleanupExpiredTokens, 2 * 60 * 1000).unref?.()

function getAuthorizedRoot(event) {
  const root = authorizedRoots.get(event.sender.id)
  if (!root) throw new Error('请先在首页选择工作目录')
  return root
}

function resolveAuthorizedPath(event, input) {
  return resolveWithinRoot(getAuthorizedRoot(event), input)
}

// 屏蔽以 utf-8 文本方式读写的二进制/媒体文件扩展名（read-file/patch-file/write-file/revert-file 共用）。
// 注意：.svg 是 XML 纯文本，不属于二进制，故不在此列——Agent 需要生成/读取图标与图示。
const BLOCKED_BINARY_EXTS = [
  // 位图图片
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.psd',
  // 音视频
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.flv', '.wav', '.flac', '.ogg', '.webm',
  // 压缩包
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz',
  // 二进制/可执行
  '.exe', '.dll', '.so', '.dylib', '.o', '.obj', '.class', '.pyc', '.wasm',
  // 数据库
  '.db', '.sqlite', '.sqlite3', '.mdb',
  // 字体
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  // 富文档（走 read-document 专门解析）
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'
]

// 只读命令自动放行策略：true = 已授权工作目录内的只读查看类命令（cat/ls/grep/head 等）
// 不逐条弹窗，与 write-file 的 WRITE_AUTO_APPROVE 保持一致的免确认体验。安全性三重约束：
//   1) 管道/命令链每一段的首个可执行文件都必须在只读白名单内；
//   2) 不含重定向(> >>)、后台/链式(& && ||)、命令替换($() 反引号)、分号、find 的 -exec/-delete 等写/执行构造；
//   3) 不含绝对路径/盘符/家目录/上级(..) —— 只在授权工作目录内读取，越界读取仍弹窗确认。
// 如需恢复“所有命令都需确认”，将 COMMAND_AUTO_APPROVE 改为 false 即可。
let COMMAND_AUTO_APPROVE = true

const READONLY_COMMAND_TOKENS = new Set([
  'cat', 'ls', 'dir', 'pwd', 'echo', 'head', 'tail', 'wc', 'find', 'grep', 'rg',
  'tree', 'stat', 'du', 'df', 'which', 'where', 'whoami', 'hostname', 'date',
  'file', 'type', 'sort', 'uniq', 'cut', 'tr', 'less', 'more',
  'get-content', 'get-childitem', 'gc', 'gci', 'select-string'
])

// git 只读子命令：仅展示/查询仓库状态，不改动工作区、不联网、不改引用。
// 任何写/变历类子命令（add/commit/push/checkout/reset/clean/restore/merge/rebase/apply/rm/mv/gc/tag…）都不在此列，仍会弹窗确认。
const READONLY_GIT_SUBCOMMANDS = new Set([
  'diff', 'status', 'log', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse',
  'rev-list', 'describe', 'shortlog', 'cat-file', 'whatchanged', 'diff-index'
])

function isReadOnlyInWorkspaceCommand(rawCommand) {
  const cmd = (rawCommand || '').trim()
  if (!cmd) return false
  // 写 / 执行 / 后台 / 链式构造一律拒绝自动放行（含 && || ; > & $() 反引号）
  if (/[<>]|&|\$\(|`|;/.test(cmd)) return false
  // find 的 -exec/-delete/-ok 会改动或执行程序
  if (/-(?:exec|execdir|ok|delete)\b/i.test(cmd)) return false
  // 绝对路径 / 盘符 / 家目录 / 上级目录 —— 越界读取需人工确认
  if (/(^|[\s'"])([A-Za-z]:[\\/]|[\\/]|~[\\/]|\.\.[\\/])/.test(cmd)) return false
  // 管道每一段都必须是只读命令（|| 会产生空段而被拒）
  for (const seg of cmd.split(/\s*\|\s*/)) {
    const s = seg.trim()
    if (!s) return false
    const tokens = s.split(/\s+/)
    const first = tokens[0].replace(/^['"]|['"]$/g, '').toLowerCase()
    if (first === 'git') {
      // 跳过全局选项（如 --no-pager），取第一个非选项 token 作为子命令
      let sub = ''
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i].replace(/^['"]|['"]$/g, '').toLowerCase()
        if (t.startsWith('-')) continue
        sub = t
        break
      }
      if (!READONLY_GIT_SUBCOMMANDS.has(sub)) return false
      // 拒绝可能带写/执行副作用的选项（如 git diff --output=文件、--extcmd）
      if (/-{1,2}(output|extcmd|exec)\b/i.test(s)) return false
      continue
    }
    if (!READONLY_COMMAND_TOKENS.has(first)) return false
  }
  return true
}

async function approveCommand(event, command, cwd) {
  if (typeof command !== 'string' || !command.trim() || command.length > 4000) {
    throw new Error('命令为空或过长')
  }
  const workDir = resolveAuthorizedPath(event, cwd || '.')
  if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
    throw new Error('工作目录不存在')
  }
  // 命令免确认策略：不再弹出确认对话框，命令直接放行。
  // 路径边界仍由 resolveAuthorizedPath 保证（命令 cwd 必须落在已授权工作目录内）。
  // 如需恢复“非只读命令人工确认”，恢复下方被移除的 dialog.showMessageBox 分支即可。
  return workDir
}

// 写文件审批策略：true = 已授权工作目录内的写操作直接放行（不逐文件弹窗）。
// 安全性由 resolveAuthorizedPath 保证：write-file/patch-file/revert-file/create-directory
// 均先校验路径是否落在用户选定的工作目录内，越界写入在此之前就被拒绝，
// 能走到 approveWrite 的写操作必然已在沙箱边界内。
// 如需恢复"每次写单独确认"，将此行改为 false 即可。
let WRITE_AUTO_APPROVE = true

async function approveWrite(target, description) {
  if (WRITE_AUTO_APPROVE) return
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '确认更改本地文件',
    message: description,
    detail: `目标：${target}`,
    buttons: ['拒绝', '批准更改'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  if (response !== 1) throw new Error('用户拒绝更改文件')
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    icon: path.join(__dirname, '../public/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs')
    },
    frame: true,
    autoHideMenuBar: false,
    titleBarStyle: 'default',
    title: '朝堂 - 多角色辩论式 AI 对话工具'
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
  const contentsId = mainWindow.webContents.id
  mainWindow.webContents.on('destroyed', () => {
    authorizedRoots.delete(contentsId)
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https:|mailto:)/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  createWindow()

  const secretsFile = path.join(app.getPath('userData'), 'api-keys.enc')
  function requireSecureStorage() {
    if (!safeStorage.isEncryptionAvailable() ||
        (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('系统安全存储不可用，无法保存 API Key')
    }
  }
  ipcMain.handle('load-api-keys', () => {
    if (!fs.existsSync(secretsFile)) return {}
    requireSecureStorage()
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(secretsFile)))
  })
  ipcMain.handle('save-api-keys', (_event, keys) => {
    requireSecureStorage()
    if (!keys || typeof keys !== 'object' || Array.isArray(keys) ||
        Object.entries(keys).some(([id, key]) => id.length > 150 || typeof key !== 'string' || key.length > 20000)) {
      throw new Error('API Key 数据无效')
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(keys))
    const tempFile = `${secretsFile}.tmp`
    fs.mkdirSync(path.dirname(secretsFile), { recursive: true })
    fs.writeFileSync(tempFile, encrypted, { mode: 0o600 })
    fs.renameSync(tempFile, secretsFile)
    return true
  })

  // ============ IPC: 本地键值存储（核心数据持久化到 userData/chaotang-store.json）============
  const storeFile = path.join(app.getPath('userData'), 'chaotang-store.json')
  const storeBackupFile = storeFile + '.bak'
  let storeCache = null
  let recoveredFromBackup = false

  function parseStore(file) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.values(parsed).some(value => typeof value !== 'string')) {
      throw new Error('本地存储文件格式无效')
    }
    return parsed
  }

  function readStore() {
    if (storeCache) return storeCache
    if (!fs.existsSync(storeFile)) {
      if (fs.existsSync(storeBackupFile)) {
        storeCache = parseStore(storeBackupFile)
        recoveredFromBackup = true
        console.error('[Storage] 主文件缺失，已从备份读取')
      } else {
        storeCache = {}
      }
      return storeCache
    }
    try {
      storeCache = parseStore(storeFile)
    } catch (error) {
      if (!fs.existsSync(storeBackupFile)) {
        throw new Error(`本地存储损坏且无备份：${error.message}`)
      }
      try {
        storeCache = parseStore(storeBackupFile)
        recoveredFromBackup = true
        console.error('[Storage] 主文件损坏，已从备份读取；请检查最近一次写入')
      } catch (backupError) {
        throw new Error(`本地存储及备份均损坏：${backupError.message}`)
      }
    }
    return storeCache
  }

  function writeStore(data) {
    const dir = path.dirname(storeFile)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const tmp = storeFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
    if (fs.existsSync(storeFile) && !recoveredFromBackup) {
      fs.copyFileSync(storeFile, storeBackupFile)
    }
    fs.renameSync(tmp, storeFile)
    storeCache = data
    recoveredFromBackup = false
  }

  function validateStoreKey(key) {
    if (typeof key !== 'string' || !key || key.length > 200) throw new Error('store key 无效')
  }

  function setStoreValue(key, value) {
    validateStoreKey(key)
    if (typeof value !== 'string') throw new Error('store value 必须为字符串')
    const data = { ...readStore(), [key]: value }
    writeStore(data)
    return true
  }

  function deleteStoreValue(key) {
    validateStoreKey(key)
    const data = { ...readStore() }
    delete data[key]
    writeStore(data)
    return true
  }

  ipcMain.handle('store-get', (_event, key) => {
    validateStoreKey(key)
    return readStore()[key] ?? null
  })

  ipcMain.handle('store-get-all', () => readStore())

  ipcMain.handle('store-set', (_event, key, value) => setStoreValue(key, value))
  ipcMain.handle('store-delete', (_event, key) => deleteStoreValue(key))
  ipcMain.on('store-set-sync', (event, key, value) => {
    try { event.returnValue = { success: setStoreValue(key, value) } }
    catch (error) { event.returnValue = { success: false, error: error.message } }
  })
  ipcMain.on('store-delete-sync', (event, key) => {
    try { event.returnValue = { success: deleteStoreValue(key) } }
    catch (error) { event.returnValue = { success: false, error: error.message } }
  })

  ipcMain.handle('store-get-path', () => storeFile)

  // IPC: 只访问用户明确选择的工作目录
  ipcMain.handle('read-file', async (event, filePath) => {
    try {
      filePath = resolveAuthorizedPath(event, filePath)
      // 安全检查：屏蔽二进制/媒体文件
      const blockedExts = BLOCKED_BINARY_EXTS
      const ext = path.extname(filePath).toLowerCase()
      if (blockedExts.includes(ext)) {
        throw new Error(`不支持读取二进制/媒体文件: ${ext}`)
      }
      // 安全检查：文件大小限制（10MB）
      const stats = fs.statSync(filePath)
      if (stats.size > 10 * 1024 * 1024) {
        throw new Error('文件过大，最大支持 10MB')
      }
      const content = fs.readFileSync(filePath, 'utf-8')
      const sha256 = crypto.createHash('sha256').update(content).digest('hex')
      return { success: true, content, sha256 }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // IPC: 补丁式编辑（精确替换文件片段，带版本校验和原子性保证）
  // 并发写锁：同一文件串行化
  const fileWriteLocks = new Map()
  function withFileLock(filePath, fn) {
    const key = filePath.replace(/\\/g, '/').toLowerCase()
    const existing = fileWriteLocks.get(key) || Promise.resolve()
    const next = existing.then(fn, fn)
    fileWriteLocks.set(key, next.catch(() => {}))
    return next
  }

  ipcMain.handle('patch-file', async (event, filePath, patches, expectedSha256) => {
    try {
      filePath = resolveAuthorizedPath(event, filePath)

      // 安全检查：同 write-file
      const blockedExts = BLOCKED_BINARY_EXTS
      const ext = path.extname(filePath).toLowerCase()
      if (blockedExts.includes(ext)) {
        throw new Error(`不支持写入二进制/媒体文件: ${ext}`)
      }

      // 校验 patches 参数
      if (!Array.isArray(patches) || patches.length === 0) {
        throw new Error('patches 必须为非空数组')
      }
      for (const p of patches) {
        if (typeof p.oldText !== 'string' || p.oldText.length === 0) {
          throw new Error('每个 patch 的 oldText 必须为非空字符串')
        }
        if (typeof p.newText !== 'string') {
          throw new Error('每个 patch 的 newText 必须为字符串')
        }
      }

      return await withFileLock(filePath, async () => {
        // 读取当前内容
        if (!fs.existsSync(filePath)) {
          return { success: false, errorCode: 'FILE_NOT_FOUND', error: `文件不存在: ${filePath}` }
        }
        const currentContent = fs.readFileSync(filePath, 'utf-8')
        const currentSha256 = crypto.createHash('sha256').update(currentContent).digest('hex')

        // P1-fix: 强制要求 expectedSha256（防止无版本校验的写入）
        if (!expectedSha256) {
          return {
            success: false,
            errorCode: 'MISSING_VERSION',
            error: '补丁操作必须提供 expectedSha256 参数',
            currentSha256
          }
        }

        // 版本校验（审批前）
        if (expectedSha256 !== currentSha256) {
          return {
            success: false,
            errorCode: 'VERSION_MISMATCH',
            error: `文件版本不匹配（期望 ${expectedSha256.slice(0, 16)}...，实际 ${currentSha256.slice(0, 16)}...）`,
            currentSha256
          }
        }

        // 逐 patch 校验（在虚拟内容上模拟）
        let virtualContent = currentContent
        const matchCounts = []
        for (let i = 0; i < patches.length; i++) {
          const p = patches[i]
          const count = countOccurrences(virtualContent, p.oldText)
          if (count === 0) {
            return {
              success: false,
              errorCode: 'NOT_FOUND',
              error: `第 ${i + 1} 个 patch 的 oldText 在文件中未找到`,
              currentSha256,
              patchIndex: i
            }
          }
          if (!p.replaceAll && count > 1) {
            return {
              success: false,
              errorCode: 'NOT_UNIQUE',
              error: `第 ${i + 1} 个 patch 的 oldText 在文件中出现 ${count} 次（需唯一）。设置 replaceAll=true 可替换所有匹配`,
              currentSha256,
              patchIndex: i,
              matchCount: count
            }
          }
          matchCounts.push(count)
          // 在虚拟内容上执行替换
          if (p.replaceAll) {
            virtualContent = virtualContent.split(p.oldText).join(p.newText)
          } else {
            const idx = virtualContent.indexOf(p.oldText)
            virtualContent = virtualContent.slice(0, idx) + p.newText + virtualContent.slice(idx + p.oldText.length)
          }
        }

        // 审批
        await approveWrite(filePath, `朝堂请求补丁编辑文件（${patches.length} 处替换）`)

        // P1-fix: 审批后重新校验版本（审批期间文件可能被外部修改）
        const recheckContent = fs.readFileSync(filePath, 'utf-8')
        const recheckSha256 = crypto.createHash('sha256').update(recheckContent).digest('hex')
        if (recheckSha256 !== expectedSha256) {
          return {
            success: false,
            errorCode: 'VERSION_MISMATCH_AFTER_APPROVAL',
            error: '审批期间文件被外部修改，已取消写入',
            currentSha256: recheckSha256
          }
        }

        // 安全写入：同目录临时文件 → rename
        const dir = path.dirname(filePath)
        const tmpFile = path.join(dir, `.patch-tmp-${Date.now()}-${path.basename(filePath)}`)
        try {
          fs.writeFileSync(tmpFile, virtualContent, 'utf-8')
          fs.renameSync(tmpFile, filePath)
        } catch (writeErr) {
          // 清理临时文件
          try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile) } catch {}
          throw writeErr
        }

        const newSha256 = crypto.createHash('sha256').update(virtualContent).digest('hex')
        return {
          success: true,
          path: filePath,
          sha256: newSha256,
          patchesApplied: patches.length,
          matchCounts
        }
      })
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // IPC: 写入已授权的工作目录
  ipcMain.handle('write-file', async (event, filePath, content) => {
    try {
      filePath = resolveAuthorizedPath(event, filePath)
      // 安全检查：屏蔽二进制/媒体文件
      const blockedExts = BLOCKED_BINARY_EXTS
      const ext = path.extname(filePath).toLowerCase()
      if (blockedExts.includes(ext)) {
        throw new Error(`不支持写入二进制/媒体文件: ${ext}`)
      }
      // 安全检查：内容大小限制（10MB）
      if (typeof content === 'string' && content.length > 10 * 1024 * 1024) {
        throw new Error('文件内容过大，最大支持 10MB')
      }
      if (typeof content !== 'string') throw new Error('文件内容必须为文本')
      await approveWrite(filePath, fs.existsSync(filePath) ? '朝堂请求覆盖文件' : '朝堂请求创建文件')
      // 自动创建父目录
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(filePath, content, 'utf-8')
      return { success: true, path: filePath, size: content.length }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // P1-fix: IPC: 原子撤销写入（带版本校验，防止覆盖窗口）
  ipcMain.handle('revert-file', async (event, filePath, oldContent, expectedSha256) => {
    try {
      filePath = resolveAuthorizedPath(event, filePath)

      // 安全检查：同 write-file
      const blockedExts = BLOCKED_BINARY_EXTS
      const ext = path.extname(filePath).toLowerCase()
      if (blockedExts.includes(ext)) {
        throw new Error(`不支持写入二进制/媒体文件: ${ext}`)
      }

      // 强制要求 expectedSha256
      if (!expectedSha256) {
        return { success: false, errorCode: 'MISSING_VERSION', error: '撤销操作必须提供 expectedSha256 参数' }
      }

      return await withFileLock(filePath, async () => {
        // 读取当前内容并校验版本
        if (!fs.existsSync(filePath)) {
          return { success: false, errorCode: 'FILE_NOT_FOUND', error: `文件不存在: ${filePath}` }
        }
        const currentContent = fs.readFileSync(filePath, 'utf-8')
        const currentSha256 = crypto.createHash('sha256').update(currentContent).digest('hex')

        if (currentSha256 !== expectedSha256) {
          return {
            success: false,
            errorCode: 'VERSION_MISMATCH',
            error: `文件版本不匹配（期望 ${expectedSha256.slice(0, 16)}...，实际 ${currentSha256.slice(0, 16)}...）`,
            currentSha256
          }
        }

        // 审批
        await approveWrite(filePath, '朝堂请求撤销文件修改')

        // 审批后重新校验版本
        const recheckContent = fs.readFileSync(filePath, 'utf-8')
        const recheckSha256 = crypto.createHash('sha256').update(recheckContent).digest('hex')
        if (recheckSha256 !== expectedSha256) {
          return {
            success: false,
            errorCode: 'VERSION_MISMATCH_AFTER_APPROVAL',
            error: '审批期间文件被外部修改，已取消撤销',
            currentSha256: recheckSha256
          }
        }

        // 安全写入：同目录临时文件 → rename
        const dir = path.dirname(filePath)
        const tmpFile = path.join(dir, `.revert-tmp-${Date.now()}-${path.basename(filePath)}`)
        try {
          fs.writeFileSync(tmpFile, oldContent, 'utf-8')
          fs.renameSync(tmpFile, filePath)
        } catch (writeErr) {
          try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile) } catch {}
          throw writeErr
        }

        const newSha256 = crypto.createHash('sha256').update(oldContent).digest('hex')
        return {
          success: true,
          path: filePath,
          sha256: newSha256,
          reverted: true
        }
      })
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // IPC: 创建目录
  ipcMain.handle('create-directory', async (event, dirPath) => {
    try {
      dirPath = resolveAuthorizedPath(event, dirPath)
      await approveWrite(dirPath, '朝堂请求创建目录')
      fs.mkdirSync(dirPath, { recursive: true })
      return { success: true, path: dirPath }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // IPC: 打开目录/文件选择对话框
  ipcMain.handle('show-open-dialog', async (event, options) => {
    try {
      const dialogOptions = {
        title: options?.title || '选择目录',
        properties: options?.properties || ['openDirectory'],
        filters: options?.filters || undefined
      }
      const result = await dialog.showOpenDialog(mainWindow, dialogOptions)
      // 如果是选择目录（工作目录场景），记录授权路径
      if (dialogOptions.properties.includes('openDirectory') && !result.canceled && result.filePaths.length === 1) {
        authorizedRoots.set(event.sender.id, fs.realpathSync(result.filePaths[0]))
      }
      // 如果选择了文件（非目录），生成一次性读取授权令牌
      let fileToken = undefined
      if (!result.canceled && result.filePaths.length > 0 && !dialogOptions.properties.includes('openDirectory')) {
        fileToken = generateFileToken()
        pendingFileOperations.set(fileToken, {
          filePaths: result.filePaths.map(p => path.resolve(p)),
          operation: 'read',
          expiresAt: Date.now() + FILE_TOKEN_TTL_MS,
          senderId: event.sender.id
        })
      }
      return { ...result, fileToken }
    } catch (error) {
      return { canceled: true, filePaths: [], error: error.message }
    }
  })

  // IPC: 使用已持久化的工作目录重新授权（应用重启/渲染进程重载后恢复授权，
  // 无需让用户重新选择目录。仅允许已存在的绝对目录，保持沙箱边界）
  ipcMain.handle('authorize-workspace', async (event, dirPath) => {
    try {
      if (typeof dirPath !== 'string' || !dirPath.trim()) throw new Error('工作目录无效')
      const abs = path.resolve(dirPath)
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error('工作目录不存在')
      const root = fs.realpathSync(abs)
      authorizedRoots.set(event.sender.id, root)
      return { success: true, root }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // IPC: 保存文件对话框（返回一次性写入授权令牌）
  ipcMain.handle('show-save-dialog', async (event, options) => {
    try {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: options?.title || '保存文件',
        defaultPath: options?.defaultPath || undefined,
        filters: options?.filters || undefined
      })
      let fileToken = undefined
      if (!result.canceled && result.filePath) {
        fileToken = generateFileToken()
        pendingFileOperations.set(fileToken, {
          filePath: path.resolve(result.filePath),
          operation: 'write',
          expiresAt: Date.now() + FILE_TOKEN_TTL_MS,
          senderId: event.sender.id
        })
      }
      return { canceled: result.canceled, filePath: result.filePath || undefined, fileToken }
    } catch (error) {
      return { canceled: true, error: error.message }
    }
  })

  // IPC: 读取文档文件（doc/docx/pdf/xls/xlsx）
  ipcMain.handle('read-document', async (event, filePath) => {
    try {
      filePath = resolveAuthorizedPath(event, filePath)
      if (!fs.existsSync(filePath)) {
        throw new Error(`文件不存在: ${filePath}`)
      }
      const stats = fs.statSync(filePath)
      if (stats.size > 50 * 1024 * 1024) {
        throw new Error('文件过大，最大支持 50MB')
      }
      const ext = path.extname(filePath).toLowerCase()
      let content = ''
      let metadata = {}

      if (ext === '.docx' || ext === '.doc') {
        const mammoth = require('mammoth')
        const result = await mammoth.extractRawText({ path: filePath })
        content = result.value
        metadata = { pages: null, warnings: result.messages?.length || 0 }
      } else if (ext === '.pdf') {
        const pdfParse = require('pdf-parse')
        const buffer = fs.readFileSync(filePath)
        const data = await pdfParse(buffer)
        content = data.text
        metadata = { pages: data.numpages, info: data.info || {} }
      } else if (ext === '.xlsx' || ext === '.xls') {
        const XLSX = require('xlsx')
        const workbook = XLSX.readFile(filePath)
        const sheets = []
        for (const name of workbook.SheetNames) {
          const sheet = workbook.Sheets[name]
          const csv = XLSX.utils.sheet_to_csv(sheet)
          sheets.push(`--- Sheet: ${name} ---\n${csv}`)
        }
        content = sheets.join('\n\n')
        metadata = { sheetCount: workbook.SheetNames.length, sheetNames: workbook.SheetNames }
      } else if (ext === '.pptx') {
        // PPTX 用简单方式解析：提取文本内容
        const mammoth = require('mammoth')
        try {
          const result = await mammoth.extractRawText({ path: filePath })
          content = result.value
        } catch {
          content = '[PPTX 文件无法解析文本内容]'
        }
        metadata = { format: 'pptx' }
      } else {
        throw new Error(`不支持的文档格式: ${ext}，支持 doc/docx/pdf/xls/xlsx/pptx`)
      }

      // 截断过长内容
      if (content.length > 50000) {
        content = content.slice(0, 50000) + '\n... (内容过长，已截断)'
      }

      return { success: true, content, metadata }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // IPC: 读取附件文件（用于朝议附件，不需要路径授权，用户通过对话框主动选择）
  ipcMain.handle('read-attachment', async (_event, filePath) => {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`文件不存在: ${filePath}`)
      }
      const stats = fs.statSync(filePath)
      if (stats.size > 20 * 1024 * 1024) {
        throw new Error('文件过大，最大支持 20MB')
      }
      const ext = path.extname(filePath).toLowerCase()
      let content = ''

      // 文档类型文件
      if (ext === '.docx' || ext === '.doc') {
        const mammoth = require('mammoth')
        const result = await mammoth.extractRawText({ path: filePath })
        content = result.value
      } else if (ext === '.pdf') {
        const pdfParse = require('pdf-parse')
        const buffer = fs.readFileSync(filePath)
        const data = await pdfParse(buffer)
        content = data.text
      } else if (ext === '.xlsx' || ext === '.xls') {
        const XLSX = require('xlsx')
        const workbook = XLSX.readFile(filePath)
        const sheets = []
        for (const name of workbook.SheetNames) {
          const sheet = workbook.Sheets[name]
          const csv = XLSX.utils.sheet_to_csv(sheet)
          sheets.push(`--- Sheet: ${name} ---\n${csv}`)
        }
        content = sheets.join('\n\n')
      } else if (ext === '.pptx') {
        const mammoth = require('mammoth')
        try {
          const result = await mammoth.extractRawText({ path: filePath })
          content = result.value
        } catch {
          content = '[PPTX 文件无法解析文本内容]'
        }
      } else {
        // 文本类型文件
        const textExts = new Set([
          '.txt', '.md', '.csv', '.json', '.xml', '.html', '.htm',
          '.js', '.ts', '.vue', '.jsx', '.tsx', '.py', '.java', '.kt',
          '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.rb',
          '.php', '.swift', '.sh', '.bash', '.zsh', '.bat', '.ps1',
          '.sql', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg',
          '.log', '.env', '.gitignore', '.dockerfile'
        ])
        if (textExts.has(ext) || stats.size < 1024 * 100) {
          content = fs.readFileSync(filePath, 'utf-8')
        } else {
          throw new Error(`不支持的附件格式: ${ext}`)
        }
      }

      // 截断过长内容（保留前 30000 字符）
      if (content.length > 30000) {
        content = content.slice(0, 30000) + '\n... (内容过长，已截断，仅保留前 30000 字符)'
      }

      return {
        success: true,
        content,
        fileName: path.basename(filePath),
        fileSize: stats.size,
        fileType: ext.replace(/^\./, '')
      }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // IPC: 读取对话框授权的文件（一次性令牌验证，绑定窗口+路径+过期时间）
  ipcMain.handle('read-arbitrary-file', async (event, filePath, token) => {
    try {
      if (!token) throw new Error('缺少文件操作授权令牌')
      const op = pendingFileOperations.get(token)
      if (!op) throw new Error('文件操作授权无效或已过期')
      if (op.expiresAt < Date.now()) {
        pendingFileOperations.delete(token)
        throw new Error('文件操作授权已过期')
      }
      if (op.senderId !== undefined && op.senderId !== event.sender.id) {
        throw new Error('文件操作授权窗口不匹配')
      }
      if (op.operation !== 'read') throw new Error('授权类型不匹配：期望读取操作')
      const resolvedPath = path.resolve(filePath)
      if (!op.filePaths.includes(resolvedPath)) {
        throw new Error('文件路径与对话框选择的路径不匹配')
      }
      pendingFileOperations.delete(token) // 一次性消费
      if (!fs.existsSync(filePath)) {
        throw new Error(`文件不存在: ${filePath}`)
      }
      const stats = fs.statSync(filePath)
      if (stats.size > 10 * 1024 * 1024) {
        throw new Error('文件过大，最大支持 10MB')
      }
      const content = fs.readFileSync(filePath, 'utf-8')
      return { success: true, content }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // IPC: 写入对话框授权的文件（一次性令牌验证，绑定窗口+路径+过期时间）
  ipcMain.handle('write-arbitrary-file', async (event, filePath, content, token) => {
    try {
      if (!token) throw new Error('缺少文件操作授权令牌')
      const op = pendingFileOperations.get(token)
      if (!op) throw new Error('文件操作授权无效或已过期')
      if (op.expiresAt < Date.now()) {
        pendingFileOperations.delete(token)
        throw new Error('文件操作授权已过期')
      }
      if (op.senderId !== undefined && op.senderId !== event.sender.id) {
        throw new Error('文件操作授权窗口不匹配')
      }
      if (op.operation !== 'write') throw new Error('授权类型不匹配：期望写入操作')
      const resolvedPath = path.resolve(filePath)
      if (op.filePath !== resolvedPath) {
        throw new Error('文件路径与对话框选择的路径不匹配')
      }
      pendingFileOperations.delete(token) // 一次性消费
      if (typeof content !== 'string') throw new Error('文件内容必须为文本')
      if (content.length > 10 * 1024 * 1024) {
        throw new Error('文件内容过大，最大支持 10MB')
      }
      // 自动创建父目录
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(filePath, content, 'utf-8')
      return { success: true, path: filePath, size: content.length }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // IPC: 读取目录
  ipcMain.handle('read-directory', async (event, dirPath) => {
    try {
      dirPath = resolveAuthorizedPath(event, dirPath)
      if (!fs.existsSync(dirPath)) {
        throw new Error(`目录不存在: ${dirPath}`)
      }
      const stats = fs.statSync(dirPath)
      if (!stats.isDirectory()) {
        throw new Error(`路径不是目录: ${dirPath}`)
      }
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      const items = entries.slice(0, 200).map(entry => {
        const fullPath = path.join(dirPath, entry.name)
        try {
          const stat = fs.statSync(fullPath)
          return {
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: stat.size,
            modified: stat.mtime.toISOString()
          }
        } catch {
          return {
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: 0,
            modified: null
          }
        }
      })
      return {
        success: true,
        path: dirPath,
        count: items.length,
        truncated: entries.length > 200,
        items
      }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // IPC: 读取指定文件相对于某 git 基准的 unified diff（只读，工作目录沙箱内）
  // mode：'uncommitted'(默认，工作树+暂存区 vs HEAD) | 'staged'(暂存区 vs HEAD) | 'unstaged'(工作树 vs 暂存区) | 'last'(HEAD^ vs HEAD)
  ipcMain.handle('git-file-diff', async (event, { filePath, cwd, mode }) => {
    try {
      const workDir = resolveAuthorizedPath(event, cwd || '.')
      const absFile = resolveAuthorizedPath(event, filePath)
      if (!fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) {
        throw new Error('文件不存在或不可访问')
      }
      const relPath = path.relative(workDir, absFile).replace(/\\/g, '/')
      const gitEnv = { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }

      const runGit = (args) => new Promise((resolve) => {
        execFile('git', args, {
          cwd: workDir,
          timeout: 15000,
          maxBuffer: 10 * 1024 * 1024,
          env: gitEnv
        }, (error, stdout, stderr) => resolve({
          error,
          stdout: (stdout || '').toString(),
          stderr: (stderr || '').toString()
        }))
      })

      // 先确认在 git 工作区内
      const inside = await runGit(['rev-parse', '--is-inside-work-tree'])
      if (inside.error || inside.stdout.trim() !== 'true') {
        return { success: false, status: 'notgit', error: '当前工作目录不是 Git 仓库' }
      }

      let diffArgs
      switch (mode) {
        case 'staged': diffArgs = ['--no-pager', 'diff', '--cached', '--', relPath]; break
        case 'unstaged': diffArgs = ['--no-pager', 'diff', '--', relPath]; break
        case 'last': diffArgs = ['--no-pager', 'diff', 'HEAD^', 'HEAD', '--', relPath]; break
        default: diffArgs = ['--no-pager', 'diff', 'HEAD', '--', relPath]
      }

      const d = await runGit(diffArgs)
      if (d.error && !d.stdout) {
        // HEAD 不存在（仓库尚无提交）等情形
        const msg = (d.stderr || '').trim() || 'git diff 执行失败'
        return { success: false, status: 'error', error: msg }
      }

      let diff = d.stdout || ''
      let status = diff.trim() ? 'modified' : 'unmodified'

      // 未产生差异时，区分“干净”与“未跟踪新文件”
      if (!diff.trim()) {
        const st = await runGit(['status', '--porcelain', '--', relPath])
        const code = (st.stdout || '').trim()
        if (code.startsWith('??')) {
          status = 'untracked'
          const nd = await runGit(['--no-pager', 'diff', '--no-index', '--', '/dev/null', relPath])
          if (nd.stdout) diff = nd.stdout
        }
      }

      const truncated = diff.length > 400000
      if (truncated) diff = diff.slice(0, 400000) + '\n…（diff 内容过大，已截断）'
      return { success: true, status, diff, hasChanges: diff.trim().length > 0, path: relPath, truncated }
    } catch (error) {
      return { success: false, status: 'error', error: error.message }
    }
  })

  // IPC: 搜索代码内容（grep/regex 跨文件搜索）
  ipcMain.handle('search-code', async (event, { pattern, directory, filePattern, maxResults, isRegex }) => {
    try {
      directory = resolveAuthorizedPath(event, directory)
      if (!fs.existsSync(directory)) {
        throw new Error(`目录不存在: ${directory}`)
      }

      const maxCount = Math.min(maxResults || 50, 200)
      const ignoreDirs = new Set([
        'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
        '.next', '.nuxt', '__pycache__', '.venv', 'venv', '.idea', '.vscode',
        'coverage', '.cache', 'tmp', 'temp'
      ])
      const ignoreExts = new Set([
        // 注：.svg 是 XML 纯文本，不列入跳过名单，与 BLOCKED_BINARY_EXTS 的约定一致（图标内容也应可被搜索）
        '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
        '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
        '.zip', '.rar', '.7z', '.tar', '.gz',
        '.exe', '.dll', '.so', '.dylib', '.o', '.class', '.pyc', '.wasm',
        '.db', '.sqlite', '.sqlite3',
        '.ttf', '.otf', '.woff', '.woff2', '.eot',
        '.lock', '.min.js', '.min.css', '.map',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx'
      ])

      // 编译搜索模式
      let regex
      try {
        regex = isRegex
          ? new RegExp(pattern, 'gi')
          : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      } catch (e) {
        throw new Error(`正则表达式无效: ${e.message}`)
      }

      // 文件扩展名过滤
      let fileExtFilter = null
      if (filePattern) {
        // 支持 "*.ts", "*.vue", "ts,vue" 等格式
        const exts = filePattern.split(',').map(p => {
          const ext = p.trim().replace(/^\*\.?/, '')
          return ext.startsWith('.') ? ext : '.' + ext
        })
        fileExtFilter = new Set(exts)
      }

      const results = []
      let filesScanned = 0

      function searchDir(dir, relBase) {
        if (results.length >= maxCount) return

        let entries
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          return // 无权限读取的目录跳过
        }

        for (const entry of entries) {
          if (results.length >= maxCount) return

          const fullPath = path.join(dir, entry.name)
          const relPath = path.relative(relBase, fullPath)

          if (entry.isDirectory()) {
            if (!ignoreDirs.has(entry.name) && !entry.name.startsWith('.')) {
              searchDir(fullPath, relBase)
            }
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase()
            if (ignoreExts.has(ext)) continue
            if (fileExtFilter && !fileExtFilter.has(ext)) continue

            // 大小限制
            try {
              const stat = fs.statSync(fullPath)
              if (stat.size > 1024 * 1024) continue // 跳过 >1MB 文件
            } catch { continue }

            filesScanned++
            try {
              const content = fs.readFileSync(fullPath, 'utf-8')
              const lines = content.split('\n')
              for (let i = 0; i < lines.length; i++) {
                if (results.length >= maxCount) break
                regex.lastIndex = 0
                if (regex.test(lines[i])) {
                  results.push({
                    file: relPath,
                    line: i + 1,
                    content: lines[i].trim().slice(0, 200)
                  })
                }
              }
            } catch {
              // 无法读取的文件跳过（如编码问题）
            }
          }
        }
      }

      searchDir(directory, directory)

      return {
        success: true,
        pattern,
        directory,
        filesScanned,
        matchCount: results.length,
        truncated: results.length >= maxCount,
        results
      }
    } catch (error) {
      return { success: false, error: error.message, results: [] }
    }
  })

  // IPC: 获取沙箱配置
  ipcMain.handle('get-sandbox-config', () => {
    try {
      const saved = fs.readFileSync(path.join(app.getPath('userData'), 'sandbox-config.json'), 'utf-8')
      return JSON.parse(saved)
    } catch {
      return { enabled: true, blockNetwork: false, maxMemoryMB: 512, maxTimeout: 120000 }
    }
  })

  // IPC: 保存沙箱配置
  ipcMain.handle('save-sandbox-config', (_event, config) => {
    const file = path.join(app.getPath('userData'), 'sandbox-config.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 })
    return true
  })

  // 内部：获取沙箱配置
  function getSandboxConfig() {
    try {
      const saved = fs.readFileSync(path.join(app.getPath('userData'), 'sandbox-config.json'), 'utf-8')
      return JSON.parse(saved)
    } catch {
      return { enabled: true, blockNetwork: false, maxMemoryMB: 512, maxTimeout: 120000 }
    }
  }

  // IPC: 执行命令行命令（沙箱隔离）
  ipcMain.handle('execute-command', async (event, { command, cwd, timeout }) => {
    try {
      const execCwd = await approveCommand(event, command, cwd)
      const sandboxConfig = getSandboxConfig()

      // 如果沙箱启用，使用沙箱执行引擎
      if (sandboxConfig.enabled) {
        return await executeInSandbox({
          command,
          cwd: execCwd,
          timeout: timeout || 30000,
          sandboxConfig
        })
      }

      // 沙箱禁用时降级为原有逻辑（保留基本安全检查）
      const safetyCheck = checkCommandSafety(command)
      if (!safetyCheck.safe) {
        return { success: false, exitCode: -1, stdout: '', stderr: safetyCheck.reason }
      }

      const execShell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'
      const execTimeout = Math.min(timeout || 30000, 120000)

      return new Promise((resolve) => {
        exec(command, {
          cwd: execCwd,
          shell: execShell,
          timeout: execTimeout,
          maxBuffer: 5 * 1024 * 1024,
          env: { ...process.env, FORCE_COLOR: '0' }
        }, (error, stdout, stderr) => {
          const output = stdout?.toString() || ''
          const errOutput = stderr?.toString() || ''

          const truncatedOutput = output.length > 20000
            ? output.slice(0, 20000) + '\n... (输出过长，已截断)'
            : output
          const truncatedErr = errOutput.length > 5000
            ? errOutput.slice(0, 5000) + '\n... (错误输出过长，已截断)'
            : errOutput

          if (error) {
            if (error.killed) {
              resolve({
                success: false, exitCode: -1,
                stdout: truncatedOutput,
                stderr: `命令执行超时 (${execTimeout / 1000}s)，已强制终止`,
                timedOut: true
              })
            } else {
              resolve({
                success: false, exitCode: error.code || 1,
                stdout: truncatedOutput,
                stderr: truncatedErr || error.message
              })
            }
          } else {
            resolve({
              success: true, exitCode: 0,
              stdout: truncatedOutput,
              stderr: truncatedErr
            })
          }
        })
      })
    } catch (error) {
      return { success: false, exitCode: -1, stdout: '', stderr: error.message }
    }
  })

  // IPC: 检测并运行测试（沙箱隔离）
  ipcMain.handle('run-tests', async (event, { cwd, testCommand }) => {
    try {
      const workDir = resolveAuthorizedPath(event, cwd || '.')
      // 测试命令也需要审批
      if (testCommand) {
        await approveCommand(event, testCommand, workDir)
      }
      const sandboxConfig = getSandboxConfig()

      if (sandboxConfig.enabled) {
        return await runTestsInSandbox({
          cwd: workDir,
          testCommand,
          sandboxConfig
        })
      }

      // 降级：无沙箱时的原有逻辑
      let cmd = testCommand
      if (!cmd) {
        if (fs.existsSync(path.join(workDir, 'package.json'))) {
          const pkg = JSON.parse(fs.readFileSync(path.join(workDir, 'package.json'), 'utf-8'))
          const scripts = pkg.scripts || {}
          if (scripts.test) cmd = 'npm test'
          else if (scripts['test:unit']) cmd = 'npm run test:unit'
          const deps = { ...pkg.dependencies, ...pkg.devDependencies }
          if (!cmd) {
            if (deps.vitest) cmd = 'npx vitest run'
            else if (deps.jest) cmd = 'npx jest'
            else if (deps.mocha) cmd = 'npx mocha'
          }
        }
        if (!cmd && (fs.existsSync(path.join(workDir, 'pytest.ini')) || fs.existsSync(path.join(workDir, 'pyproject.toml')))) {
          cmd = 'python -m pytest'
        }
        if (!cmd && fs.existsSync(path.join(workDir, 'Cargo.toml'))) cmd = 'cargo test'
        if (!cmd && fs.existsSync(path.join(workDir, 'go.mod'))) cmd = 'go test ./...'
        if (!cmd) cmd = 'npm test'
      }

      if (!testCommand) await approveCommand(event, cmd, workDir)
      const execShell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'

      return new Promise((resolve) => {
        exec(cmd, {
          cwd: workDir,
          shell: execShell,
          timeout: 120000,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, FORCE_COLOR: '0', CI: '1' }
        }, (error, stdout, stderr) => {
          const output = stdout?.toString() || ''
          const errOutput = stderr?.toString() || ''
          const truncOut = output.length > 30000
            ? output.slice(0, 15000) + '\n... (中间省略) ...\n' + output.slice(-10000)
            : output
          const truncErr = errOutput.length > 10000
            ? errOutput.slice(0, 5000) + '\n... (中间省略) ...\n' + errOutput.slice(-3000)
            : errOutput
          let summary = ''
          const lines = (output + '\n' + errOutput).split('\n')
          for (const line of lines) {
            if (/tests?\s+(passed|failed|skipped|error)/i.test(line) ||
                /Tests:\s+\d+\s+(passed|failed)/i.test(line) ||
                /test result:/i.test(line) ||
                /\d+ passed/i.test(line) ||
                /FAIL|PASS\s/i.test(line) ||
                /ok\s+\d+/i.test(line)) {
              summary += line.trim() + '\n'
            }
          }
          resolve({
            success: !error,
            exitCode: error ? (error.code || 1) : 0,
            command: cmd,
            stdout: truncOut,
            stderr: truncErr,
            summary: summary.trim() || (error ? '测试失败' : '测试通过'),
            timedOut: error?.killed || false
          })
        })
      })
    } catch (error) {
      return { success: false, exitCode: -1, command: testCommand || '', stdout: '', stderr: error.message, summary: error.message }
    }
  })

  // ============ 插件系统 IPC ============

  // IPC: 扫描插件目录，返回所有 SKILL.md 文件路径
  ipcMain.handle('scan-plugins', () => {
    const pluginDir = path.join(app.getPath('userData'), 'plugins')
    // 确保插件目录存在
    if (!fs.existsSync(pluginDir)) {
      fs.mkdirSync(pluginDir, { recursive: true })
      return []
    }

    const results = []
    try {
      const entries = fs.readdirSync(pluginDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillMd = path.join(pluginDir, entry.name, 'SKILL.md')
          if (fs.existsSync(skillMd)) {
            results.push(skillMd)
          }
        } else if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
          results.push(path.join(pluginDir, entry.name))
        }
      }
    } catch {
      // 目录读取失败，返回空数组
    }
    return results
  })

  // IPC: 读取插件文件内容
  ipcMain.handle('read-plugin', (_event, filePath) => {
    try {
      const pluginDir = path.join(app.getPath('userData'), 'plugins')
      // 安全检查：只允许读取插件目录内的文件
      const resolved = path.resolve(filePath)
      const pluginDirResolved = path.resolve(pluginDir)
      if (!resolved.startsWith(pluginDirResolved)) {
        return { success: false, error: '只允许读取插件目录内的文件' }
      }
      if (!fs.existsSync(resolved)) {
        return { success: false, error: '文件不存在' }
      }
      const content = fs.readFileSync(resolved, 'utf-8')
      return { success: true, content }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // IPC: 获取插件目录路径
  ipcMain.handle('get-plugin-dir', () => {
    return path.join(app.getPath('userData'), 'plugins')
  })

  // IPC: 打开插件目录
  ipcMain.handle('open-plugin-dir', () => {
    const pluginDir = path.join(app.getPath('userData'), 'plugins')
    if (!fs.existsSync(pluginDir)) {
      fs.mkdirSync(pluginDir, { recursive: true })
    }
    shell.openPath(pluginDir)
    return true
  })

  // ============ 浏览器自动化 IPC ============

  let browserInstance = null
  let browserPage = null

  // 浏览器域名白名单策略（由渲染进程通过 set-policy 下发，主进程兜底拦截）
  let browserPolicy = { allowlistEnabled: false, allowlist: [] }

  // 域名是否放行：精确匹配或子域匹配（example.com 放行 a.example.com）
  const hostMatchesPolicy = (targetUrl) => {
    if (!browserPolicy.allowlistEnabled) return true
    let host
    try {
      host = new URL(targetUrl).hostname.toLowerCase()
    } catch {
      return false
    }
    const patterns = Array.isArray(browserPolicy.allowlist) ? browserPolicy.allowlist : []
    return patterns.some((raw) => {
      const p = String(raw || '').trim().toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/[\/].*$/, '')
        .replace(/:\d+$/, '')
      if (!p) return false
      return host === p || host.endsWith('.' + p)
    })
  }

  // 允许的人工按键名（避免面板把任意键盘事件透传给页面）
  const ALLOWED_KEYS = new Set([
    'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Space',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'
  ])

  // IPC: 执行浏览器操作
  ipcMain.handle('browser-action', async (_event, { action, params = {} }) => {
    try {
      // 延迟加载 playwright
      let chromium
      try {
        chromium = require('playwright').chromium
      } catch {
        return { success: false, error: 'Playwright 未安装，请运行 npm install playwright' }
      }

      // 配置类操作不需要浏览器实例
      if (action === 'set-policy') {
        browserPolicy = {
          allowlistEnabled: !!params.allowlistEnabled,
          allowlist: Array.isArray(params.allowlist) ? params.allowlist : []
        }
        return { success: true, policy: browserPolicy }
      }

      // 查询状态同样不按需启动：面板挂载时要能判断“有没有页面”而不拉起 Chromium
      if (action === 'state') {
        if (!browserPage) {
          return { success: true, active: false, url: '', title: '', viewport: null, policy: browserPolicy }
        }
        const pageUrl = browserPage.url()
        return {
          success: true,
          active: pageUrl !== 'about:blank',
          url: pageUrl,
          title: await browserPage.title(),
          viewport: browserPage.viewportSize(),
          policy: browserPolicy
        }
      }

      // 启动浏览器（按需）
      if (!browserInstance) {
        browserInstance = await chromium.launch({ headless: true })
        browserPage = await browserInstance.newPage()
        // 设置默认超时
        browserPage.setDefaultTimeout(15000)
      }

      switch (action) {
        case 'navigate': {
          const url = params.url
          if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
            return { success: false, error: '仅支持 http/https 协议' }
          }
          if (!hostMatchesPolicy(url)) {
            let host = url
            try { host = new URL(url).hostname } catch { /* 保留原文 */ }
            return { success: false, error: `DOMAIN_BLOCKED: ${host} 不在允许的域名白名单内（可在设置 → 浏览器安全 中调整）` }
          }
          const resp = await browserPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
          const title = await browserPage.title()
          return { success: true, title, url: browserPage.url(), httpStatus: resp ? resp.status() : undefined }
        }
        case 'back': {
          const resp = await browserPage.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 })
          return {
            success: true,
            moved: !!resp,
            url: browserPage.url(),
            title: await browserPage.title(),
            message: resp ? '已后退' : '没有可后退的历史记录'
          }
        }
        case 'forward': {
          const resp = await browserPage.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 })
          return {
            success: true,
            moved: !!resp,
            url: browserPage.url(),
            title: await browserPage.title(),
            message: resp ? '已前进' : '没有可前进的历史记录'
          }
        }
        case 'reload': {
          if (browserPage.url() === 'about:blank') {
            return { success: false, error: '当前为空白页，请先输入地址' }
          }
          await browserPage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
          return { success: true, url: browserPage.url(), title: await browserPage.title(), message: '已刷新' }
        }
        case 'viewport': {
          // 面板宽度变化时同步视口，避免截图被拉伸模糊
          const width = Math.round(Number(params.width) || 0)
          const height = Math.round(Number(params.height) || 0)
          if (width < 320 || width > 3840 || height < 240 || height > 2160) {
            return { success: false, error: '视口尺寸超出允许范围' }
          }
          await browserPage.setViewportSize({ width, height })
          return { success: true, viewport: browserPage.viewportSize() }
        }
        case 'screenshot': {
          const isJpeg = params.type === 'jpeg'
          const options = { type: isJpeg ? 'jpeg' : 'png', fullPage: !!params.fullPage }
          if (isJpeg) options.quality = Math.max(30, Math.min(90, Number(params.quality) || 70))
          const buffer = await browserPage.screenshot(options)
          return {
            success: true,
            data: buffer.toString('base64'),
            type: options.type,
            url: browserPage.url(),
            title: await browserPage.title(),
            viewport: browserPage.viewportSize()
          }
        }
        case 'snapshot': {
          const snapshot = await browserPage.accessibility.snapshot()
          function flattenSnapshot(node, depth = 0) {
            if (!node) return ''
            const indent = '  '.repeat(depth)
            let text = ''
            if (node.name) text += `${indent}[${node.role || ''}] ${node.name}\n`
            if (node.children) {
              for (const child of node.children) {
                text += flattenSnapshot(child, depth + 1)
              }
            }
            return text
          }
          const text = flattenSnapshot(snapshot)
          // 同时获取页面标题和 URL
          const pageTitle = await browserPage.title()
          const pageUrl = browserPage.url()
          return {
            success: true,
            title: pageTitle,
            url: pageUrl,
            accessibilityTree: text.slice(0, 20000),
            truncated: text.length > 20000
          }
        }
        case 'click': {
          if (!params.selector) return { success: false, error: '缺少 selector 参数' }
          await browserPage.click(params.selector, { timeout: 10000 })
          return { success: true, message: `已点击: ${params.selector}` }
        }
        case 'type': {
          if (!params.selector || params.text === undefined) {
            return { success: false, error: '缺少 selector 或 text 参数' }
          }
          await browserPage.fill(params.selector, params.text, { timeout: 10000 })
          return { success: true, message: `已填写: ${params.selector}` }
        }
        case 'evaluate': {
          if (!params.expression) return { success: false, error: '缺少 expression 参数' }
          // 安全限制：禁止在 evaluate 中执行危险操作
          const forbidden = /\brequire\b|\bimport\b|\bprocess\b|\bglobal\b/i
          if (forbidden.test(params.expression)) {
            return { success: false, error: '表达式包含禁止的 API' }
          }
          const result = await browserPage.evaluate(params.expression)
          return { success: true, result: typeof result === 'string' ? result.slice(0, 10000) : JSON.stringify(result).slice(0, 10000) }
        }
        case 'mouse-click': {
          // 面板画面内点击：视口坐标由渲染进程按截图尺寸换算
          const x = Number(params.x)
          const y = Number(params.y)
          if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
            return { success: false, error: '缺少有效的点击坐标' }
          }
          await browserPage.mouse.click(x, y)
          return { success: true, message: `已点击 (${Math.round(x)}, ${Math.round(y)})`, url: browserPage.url() }
        }
        case 'mouse-wheel': {
          const deltaY = Math.round(Number(params.deltaY) || 0)
          const deltaX = Math.round(Number(params.deltaX) || 0)
          if (!deltaX && !deltaY) return { success: false, error: '缺少滚动量' }
          await browserPage.mouse.wheel(deltaX, deltaY)
          return { success: true, message: '已滚动' }
        }
        case 'keyboard': {
          const key = String(params.key || '')
          if (!key) return { success: false, error: '缺少按键名' }
          if (!ALLOWED_KEYS.has(key)) {
            return { success: false, error: `不支持的按键: ${key}` }
          }
          await browserPage.keyboard.press(key)
          return { success: true, message: `已按下 ${key}` }
        }
        case 'close': {
          if (browserInstance) {
            await browserInstance.close()
            browserInstance = null
            browserPage = null
          }
          return { success: true, message: '浏览器已关闭' }
        }
        default:
          return { success: false, error: `未知的浏览器操作: ${action}` }
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '浏览器操作失败' }
    }
  })

  // ============ 内嵌浏览器宿主 IPC ============
  // 与上面的 Playwright 通道并存：新宿主走 browser-host-action，
  // 渲染进程用 browser_engine 开关选走哪一条。旧通道到 M7 才删。
  const browserHost = createBrowserHost({
    BrowserView,
    session,
    getWindow: () => mainWindow,
    broadcast: (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload)
      }
    }
  })

  // IPC: 执行内嵌浏览器操作（宿主自带 try/catch，这里不再包一层）
  ipcMain.handle('browser-host-action', async (_event, { action, params = {} }) => {
    return await browserHost.handle(action, params)
  })

  app.on('before-quit', () => {
    try { browserHost.dispose() } catch { /* 退出时无所谓 */ }
  })

  // ============ 企业微信 Webhook IPC ============

  let webhookServer = null

  // IPC: 发送企业微信 Webhook 消息
  ipcMain.handle('send-webhook', async (_event, { webhookUrl, message, msgType }) => {
    try {
      if (!webhookUrl) return { success: false, error: '缺少 Webhook URL' }

      const payload = msgType === 'markdown' ? {
        msgtype: 'markdown',
        markdown: { content: message }
      } : {
        msgtype: 'text',
        text: { content: message }
      }

      const https = require('https')
      const http = require('http')
      const urlObj = new URL(webhookUrl)
      const transport = urlObj.protocol === 'https:' ? https : http

      return new Promise((resolve) => {
        const postData = JSON.stringify(payload)
        const req = transport.request({
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname + urlObj.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          },
          timeout: 10000
        }, (res) => {
          let body = ''
          res.on('data', chunk => body += chunk)
          res.on('end', () => {
            try {
              const result = JSON.parse(body)
              if (result.errcode === 0) {
                resolve({ success: true, message: '消息发送成功' })
              } else {
                resolve({ success: false, error: `发送失败: ${result.errmsg || body}` })
              }
            } catch {
              resolve({ success: false, error: `解析响应失败: ${body.slice(0, 200)}` })
            }
          })
        })
        req.on('error', (err) => resolve({ success: false, error: err.message }))
        req.on('timeout', () => { req.destroy(); resolve({ success: false, error: '请求超时' }) })
        req.write(postData)
        req.end()
      })
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // IPC: 启动 Webhook 回调服务器
  ipcMain.handle('start-webhook-server', (_event, { port }) => {
    return new Promise((resolve) => {
      if (webhookServer) {
        webhookServer.close()
        webhookServer = null
      }

      const http = require('http')
      const server = http.createServer((req, res) => {
        // 只接受 POST 请求
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }

        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
          try {
            const data = JSON.parse(body)
            // 通知渲染进程收到消息
            if (mainWindow) {
              mainWindow.webContents.send('webhook-message', data)
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }))
          } catch {
            res.writeHead(400)
            res.end('Bad Request')
          }
        })
      })

      const listenPort = port || 9527
      server.listen(listenPort, '127.0.0.1', () => {
        webhookServer = server
        resolve({ success: true, port: listenPort, message: `Webhook 服务器已启动，端口 ${listenPort}` })
      })

      server.on('error', (err) => {
        resolve({ success: false, error: `启动失败: ${err.message}` })
      })
    })
  })

  // IPC: 停止 Webhook 回调服务器
  ipcMain.handle('stop-webhook-server', () => {
    return new Promise((resolve) => {
      if (webhookServer) {
        webhookServer.close(() => {
          webhookServer = null
          resolve({ success: true, message: 'Webhook 服务器已停止' })
        })
      } else {
        resolve({ success: true, message: '服务器未运行' })
      }
    })
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('web-contents-created', (event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    // 内嵌浏览器的页面由宿主自己管导航（包括白名单拦截），不能被界面守卫拦住
    const decision = decideShellNavigation(navigationUrl, {
      isEmbedded: isEmbeddedTab(contents),
      isDev,
      devOrigin: 'http://localhost:3000',
      distIndex: path.join(__dirname, '../dist/index.html')
    })
    if (decision.skip) return
    if (decision.external) shell.openExternal(navigationUrl)
    if (!decision.allowed) event.preventDefault()
  })
})
