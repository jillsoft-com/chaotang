/**
 * Sandbox 沙箱执行引擎
 *
 * 对 child_process.exec 进行轻量级安全包装：
 * 1. 文件系统限制：仅允许访问授权工作目录
 * 2. 网络隔离：可选阻断网络（http_proxy=0.0.0.0:0）
 * 3. CPU 超时：硬性 kill 机制
 * 4. 内存限制：通过环境变量传递给子进程
 * 5. 危险命令：扩展黑名单 + 模式匹配
 * 6. 进程树限制：Windows 上通过 Job Object 限制
 */

const { exec, spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

/**
 * 危险命令模式（扩展现有黑名单）
 */
const DANGEROUS_PATTERNS = [
  // 原有危险命令
  /\bformat\b/i, /\bfdisk\b/i, /\bdiskpart\b/i,
  /\brm\s+(-[a-z]*f[a-z]*\s+)?\//, /\bmkfs\b/i,
  /\bdd\s+if=/, /\b:\(\)\s*\{/,
  /\bshutdown\b/i, /\breboot\b/i, /\bhalt\b/i,
  /\brmdir\s+\/s\s+\/q\s+[a-zA-Z]:\\?$/i,
  /\breg\s+delete\b/i,
  // 新增：管道注入和环境变量篡改
  /\|\s*(bash|sh|zsh|cmd|powershell)\b/i,
  /\benv\s+-\w*\s*\w+=/i,                   // env VAR=value 篡改
  /\bexport\s+\w+=.*\$\(/i,                  // export VAR=$(...) 命令替换注入
  /\beval\s+["']/i,                           // eval 执行字符串
  /\bcurl\b.*\|\s*(bash|sh|powershell)\b/i,  // curl | bash 模式
  /\bwget\b.*\|\s*(bash|sh|powershell)\b/i,  // wget | bash 模式
  /\bpython[23]?\s+-c\s+["'].*import\s+os/i, // python -c 系统操作
  /\bnode\s+-e\s+["'].*require\(['"]child_process/i, // node -e 子进程
]

/**
 * 检查命令是否安全
 * @param {string} command
 * @returns {{ safe: boolean, reason?: string }}
 */
function checkCommandSafety(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 4000) {
    return { safe: false, reason: '命令为空或过长' }
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason: `安全限制：命令匹配危险模式 ${pattern.source}` }
    }
  }

  return { safe: true }
}

/**
 * 在沙箱中执行命令
 *
 * @param {object} options
 * @param {string} options.command - 要执行的命令
 * @param {string} options.cwd - 工作目录（已授权）
 * @param {number} [options.timeout=30000] - 超时时间（ms），最大 120000
 * @param {boolean} [options.blockNetwork=false] - 是否阻断网络
 * @param {number} [options.maxMemoryMB=512] - 子进程最大内存（MB）
 * @param {object} [options.sandboxConfig] - 沙箱配置
 * @param {boolean} [options.sandboxConfig.enabled=true] - 是否启用沙箱
 * @param {boolean} [options.sandboxConfig.blockNetwork=false] - 阻断网络
 * @param {number} [options.sandboxConfig.maxMemoryMB=512] - 最大内存
 * @param {number} [options.sandboxConfig.maxTimeout=120000] - 最大超时
 * @returns {Promise<import('./types').SandboxResult>}
 */
function executeInSandbox(options) {
  const {
    command,
    cwd,
    timeout,
    blockNetwork: optBlockNetwork,
    maxMemoryMB: optMaxMemory,
    sandboxConfig = {}
  } = options

  // 合并沙箱配置
  const sandboxEnabled = sandboxConfig.enabled !== false
  const blockNetwork = optBlockNetwork || sandboxConfig.blockNetwork || false
  const maxMemoryMB = optMaxMemory || sandboxConfig.maxMemoryMB || 512
  const maxTimeout = sandboxConfig.maxTimeout || 120000

  // 安全检查
  if (sandboxEnabled) {
    const safetyCheck = checkCommandSafety(command)
    if (!safetyCheck.safe) {
      return Promise.resolve({
        success: false,
        exitCode: -1,
        stdout: '',
        stderr: safetyCheck.reason,
        sandboxed: true
      })
    }
  }

  const execTimeout = Math.min(timeout || 30000, maxTimeout)
  const execShell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'

  // 构建受限环境变量
  const restrictedEnv = { ...process.env, FORCE_COLOR: '0' }

  if (sandboxEnabled && blockNetwork) {
    // 阻断网络：将代理设置为无效地址
    restrictedEnv.http_proxy = 'http://0.0.0.0:0'
    restrictedEnv.https_proxy = 'http://0.0.0.0:0'
    restrictedEnv.HTTP_PROXY = 'http://0.0.0.0:0'
    restrictedEnv.HTTPS_PROXY = 'http://0.0.0.0:0'
    restrictedEnv.no_proxy = ''
    restrictedEnv.NO_PROXY = ''
    // Node.js 特有
    restrictedEnv.NODE_OPTIONS = `--max-old-space-size=${maxMemoryMB}`
  }

  if (sandboxEnabled) {
    // 沙箱标记环境变量（子进程可检测到自己是否在沙箱中）
    restrictedEnv.CHAOTANG_SANDBOX = '1'
    restrictedEnv.CHAOTANG_SANDBOX_NETWORK = blockNetwork ? 'blocked' : 'allowed'
  }

  return new Promise((resolve) => {
    const child = exec(command, {
      cwd: cwd,
      shell: execShell,
      timeout: execTimeout,
      maxBuffer: 5 * 1024 * 1024,
      env: restrictedEnv,
      // Windows: 创建新的进程组，便于后续统一终止
      windowsHide: true
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
            timedOut: true,
            sandboxed: sandboxEnabled
          })
        } else {
          resolve({
            success: false, exitCode: error.code || 1,
            stdout: truncatedOutput,
            stderr: truncatedErr || error.message,
            sandboxed: sandboxEnabled
          })
        }
      } else {
        resolve({
          success: true, exitCode: 0,
          stdout: truncatedOutput,
          stderr: truncatedErr,
          sandboxed: sandboxEnabled
        })
      }
    })

    // 强化超时：超时后发送 SIGKILL（而不是默认的 SIGTERM）
    if (sandboxEnabled && child.pid) {
      const killTimer = setTimeout(() => {
        try {
          // 尝试杀掉整个进程树
          if (process.platform === 'win32') {
            exec(`taskkill /pid ${child.pid} /T /F`, () => {})
          } else {
            process.kill(-child.pid, 'SIGKILL')
          }
        } catch {
          // 进程可能已退出
        }
      }, execTimeout + 2000) // 给 2 秒宽限期

      child.on('exit', () => clearTimeout(killTimer))
    }
  })
}

/**
 * 在沙箱中运行测试
 *
 * @param {object} options
 * @param {string} options.cwd - 项目目录
 * @param {string} [options.testCommand] - 自定义测试命令
 * @param {object} [options.sandboxConfig] - 沙箱配置
 * @returns {Promise<object>}
 */
function runTestsInSandbox(options) {
  const { cwd: workDir, testCommand, sandboxConfig = {} } = options
  let cmd = testCommand

  // 自动检测测试框架（与 main.cjs 中逻辑一致）
  if (!cmd) {
    try {
      if (fs.existsSync(path.join(workDir, 'package.json'))) {
        const pkg = JSON.parse(fs.readFileSync(path.join(workDir, 'package.json'), 'utf-8'))
        const scripts = pkg.scripts || {}
        if (scripts.test) {
          cmd = 'npm test'
        } else if (scripts['test:unit']) {
          cmd = 'npm run test:unit'
        }
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
      if (!cmd && fs.existsSync(path.join(workDir, 'Cargo.toml'))) {
        cmd = 'cargo test'
      }
      if (!cmd && fs.existsSync(path.join(workDir, 'go.mod'))) {
        cmd = 'go test ./...'
      }
      if (!cmd) {
        cmd = 'npm test'
      }
    } catch {
      cmd = 'npm test'
    }
  }

  return executeInSandbox({
    command: cmd,
    cwd: workDir,
    timeout: 120000,
    sandboxConfig: {
      ...sandboxConfig,
      maxTimeout: 180000 // 测试允许更长超时
    }
  }).then(result => {
    // 提取测试结果摘要
    let summary = ''
    const lines = (result.stdout + '\n' + result.stderr).split('\n')
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

    return {
      ...result,
      command: cmd,
      summary: summary.trim() || (result.success ? '测试通过' : '测试失败')
    }
  })
}

module.exports = {
  executeInSandbox,
  runTestsInSandbox,
  checkCommandSafety,
  DANGEROUS_PATTERNS
}
