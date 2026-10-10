const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron')
const path = require('path')
const { pathToFileURL } = require('url')
const fs = require('fs')
const { exec } = require('child_process')
const { resolveWithinRoot } = require('./workspace-access.cjs')
const { executeInSandbox, runTestsInSandbox, checkCommandSafety } = require('./sandbox.cjs')
const isDev = process.env.NODE_ENV === 'development'

let mainWindow = null
const authorizedRoots = new Map()

function getAuthorizedRoot(event) {
  const root = authorizedRoots.get(event.sender.id)
  if (!root) throw new Error('请先在首页选择工作目录')
  return root
}

function resolveAuthorizedPath(event, input) {
  return resolveWithinRoot(getAuthorizedRoot(event), input)
}

async function approveCommand(event, command, cwd) {
  if (typeof command !== 'string' || !command.trim() || command.length > 4000) {
    throw new Error('命令为空或过长')
  }
  const workDir = resolveAuthorizedPath(event, cwd || '.')
  if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
    throw new Error('工作目录不存在')
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '确认执行命令',
    message: '朝堂请求执行本地命令',
    detail: `工作目录：${workDir}\n\n命令：${command}\n\n命令仍可能访问工作目录以外的文件。仅在信任此命令时批准。`,
    buttons: ['拒绝', '批准执行'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  if (response !== 1) throw new Error('用户拒绝执行命令')
  return workDir
}

async function approveWrite(target, description) {
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

  // IPC: 只访问用户明确选择的工作目录
  ipcMain.handle('read-file', async (event, filePath) => {
    try {
      filePath = resolveAuthorizedPath(event, filePath)
      // 安全检查：屏蔽二进制/媒体文件
      const blockedExts = [
        // 图片
        '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg', '.tiff', '.psd',
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
        // 文档
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'
      ]
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
      return { success: true, content }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // IPC: 写入已授权的工作目录
  ipcMain.handle('write-file', async (event, filePath, content) => {
    try {
      filePath = resolveAuthorizedPath(event, filePath)
      // 安全检查：屏蔽二进制/媒体文件
      const blockedExts = [
        '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg', '.tiff', '.psd',
        '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.flv', '.wav', '.flac', '.ogg', '.webm',
        '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz',
        '.exe', '.dll', '.so', '.dylib', '.o', '.obj', '.class', '.pyc', '.wasm',
        '.db', '.sqlite', '.sqlite3', '.mdb',
        '.ttf', '.otf', '.woff', '.woff2', '.eot',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'
      ]
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

  // IPC: 打开目录选择对话框
  ipcMain.handle('show-open-dialog', async (event) => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择朝堂工作目录',
        properties: ['openDirectory']
      })
      if (!result.canceled && result.filePaths.length === 1) {
        authorizedRoots.set(event.sender.id, fs.realpathSync(result.filePaths[0]))
      }
      return result
    } catch (error) {
      return { canceled: true, filePaths: [], error: error.message }
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
        '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
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
          await browserPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
          const title = await browserPage.title()
          return { success: true, title, url: browserPage.url() }
        }
        case 'screenshot': {
          const buffer = await browserPage.screenshot({
            fullPage: params.fullPage || false,
            type: params.type || 'png'
          })
          return { success: true, data: buffer.toString('base64'), type: params.type || 'png' }
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
    let allowed = false
    try {
      const destination = new URL(navigationUrl)
      allowed = isDev
        ? destination.origin === 'http://localhost:3000'
        : destination.protocol === 'file:' &&
          destination.pathname === new URL(pathToFileURL(path.join(__dirname, '../dist/index.html')).href).pathname
      if (!allowed && (destination.protocol === 'https:' || destination.protocol === 'mailto:')) {
        shell.openExternal(navigationUrl)
      }
    } catch { /* 无效地址一律禁止 */ }
    if (!allowed) {
      event.preventDefault()
    }
  })
})
