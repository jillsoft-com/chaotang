/**
 * 验收状态机 — 强制编码验收
 *
 * 核心原则：节点完成必须代表程序核验通过；模型声称完成不能代替验收。
 *
 * 三条路径（自主引擎、任务调度器、普通会话）统一调用本模块的函数，
 * 不各自实现验收逻辑。
 *
 * 设计依据：编码能力硬化路线图 Phase 2。
 */

// ============ 类型 ============

export type GateState = 'pending' | 'running' | 'passed' | 'failed' | 'unverified'

export interface CheckRecord {
  kind: 'test' | 'typecheck' | 'build' | 'user_requirement'
  command?: string
  cwd?: string
  exitCode?: number
  timedOut?: boolean
  status: GateState
  summary: string
  startedAt?: number
  finishedAt?: number
}

export interface AcceptancePlan {
  checks: CheckRecord[]
  overallState: GateState
}

/** 命令执行器接口 — 由调用方注入 */
export interface CommandExecutor {
  execute(command: string, cwd?: string, timeoutMs?: number): Promise<{
    exitCode: number
    stdout: string
    stderr: string
    timedOut: boolean
  }>
  /** P0-fix: 可选的文件写入能力（用于安全传入 commit message 等） */
  writeFile?(path: string, content: string): Promise<{ success: boolean }>
  /** P1-fix: 可选的文件读取能力（返回内容与 SHA-256，用于统一哈希读取路径） */
  readFile?(path: string): Promise<{ success: boolean; content?: string; sha256?: string }>
}

/** 验收配置 */
export interface AcceptanceConfig {
  /** 单条检查超时（默认 120s） */
  checkTimeoutMs?: number
  /** 是否包含用户自定义验收条件 */
  includeUserRequirements?: boolean
}

const DEFAULT_ACCEPTANCE_CONFIG: Required<AcceptanceConfig> = {
  checkTimeoutMs: 120_000,
  includeUserRequirements: true
}

// ============ 命令推断 ============

/** package.json 脚本名到检查类型的映射 */
const SCRIPT_KIND_MAP: Record<string, CheckRecord['kind']> = {
  build: 'build',
  typecheck: 'typecheck',
  'type-check': 'typecheck',
  'type_check': 'typecheck',
  tsc: 'typecheck',
  test: 'test',
  'test:unit': 'test',
  'test:e2e': 'test',
  lint: 'build' // lint 归入 build 类
}

/** 按优先级排序的脚本名列表 */
const PRIORITY_SCRIPTS = [
  'build', 'typecheck', 'type-check', 'type_check', 'tsc',
  'test', 'test:unit', 'test:e2e',
  'lint'
]

/**
 * 检测 package.json 中的可用检查命令
 */
function detectPackageJsonChecks(scripts: Record<string, string>): CheckRecord[] {
  const checks: CheckRecord[] = []
  const seen = new Set<CheckRecord['kind']>()

  for (const name of PRIORITY_SCRIPTS) {
    if (scripts[name]) {
      const kind = SCRIPT_KIND_MAP[name] || 'build'
      // 同类型只取优先级最高的
      if (!seen.has(kind)) {
        seen.add(kind)
        checks.push({
          kind,
          command: `npm run ${name}`,
          status: 'pending',
          summary: `${name}: ${scripts[name]}`
        })
      }
    }
  }

  return checks
}

/**
 * 根据工作目录推断检查命令
 *
 * 检测顺序：
 * 1. package.json scripts → build/test/lint
 * 2. tsconfig.json → typecheck (tsc --noEmit)
 * 3. Cargo.toml → cargo test / cargo build
 * 4. go.mod → go test / go build
 * 5. requirements.txt / pyproject.toml → pytest
 * 6. 无可用检查 → unverified
 */
export async function buildAcceptancePlan(
  workingDir: string,
  changedFiles: string[],
  executor: CommandExecutor,
  _config?: Partial<AcceptanceConfig>
): Promise<AcceptancePlan> {
  const checks: CheckRecord[] = []

  if (changedFiles.length === 0) {
    return { checks: [], overallState: 'unverified' }
  }

  try {
    // 1. 检测 package.json
    const pkgResult = await executor.execute(
      'cat package.json',
      workingDir,
      5000
    )
    if (pkgResult.exitCode === 0 && pkgResult.stdout.trim()) {
      try {
        const pkg = JSON.parse(pkgResult.stdout.trim())
        if (pkg.scripts && typeof pkg.scripts === 'object') {
          checks.push(...detectPackageJsonChecks(pkg.scripts))
        }
      } catch { /* JSON 解析失败，跳过 */ }
    }

    // 2. 检测 tsconfig.json（仅当没有 typecheck 检查时）
    if (!checks.some(c => c.kind === 'typecheck')) {
      const tsconfigResult = await executor.execute(
        'test -f tsconfig.json && echo exists',
        workingDir,
        3000
      )
      if (tsconfigResult.stdout.trim() === 'exists') {
        // 检查是否有 tsc 可用
        const tscResult = await executor.execute(
          'npx tsc --version',
          workingDir,
          10000
        )
        if (tscResult.exitCode === 0) {
          checks.push({
            kind: 'typecheck',
            command: 'npx tsc --noEmit',
            status: 'pending',
            summary: 'TypeScript 类型检查'
          })
        }
      }
    }

    // 3. 检测 Cargo.toml (Rust)
    if (checks.length === 0) {
      const cargoResult = await executor.execute(
        'test -f Cargo.toml && echo exists',
        workingDir,
        3000
      )
      if (cargoResult.stdout.trim() === 'exists') {
        checks.push({
          kind: 'build',
          command: 'cargo build',
          status: 'pending',
          summary: 'Rust 编译检查'
        })
        checks.push({
          kind: 'test',
          command: 'cargo test',
          status: 'pending',
          summary: 'Rust 单元测试'
        })
      }
    }

    // 4. 检测 go.mod (Go)
    if (checks.length === 0) {
      const goResult = await executor.execute(
        'test -f go.mod && echo exists',
        workingDir,
        3000
      )
      if (goResult.stdout.trim() === 'exists') {
        checks.push({
          kind: 'build',
          command: 'go build ./...',
          status: 'pending',
          summary: 'Go 编译检查'
        })
        checks.push({
          kind: 'test',
          command: 'go test ./...',
          status: 'pending',
          summary: 'Go 单元测试'
        })
      }
    }

    // 5. 检测 Python 项目
    if (checks.length === 0) {
      const pyResult = await executor.execute(
        'test -f requirements.txt -o -f pyproject.toml -o -f setup.py && echo exists',
        workingDir,
        3000
      )
      if (pyResult.stdout.trim() === 'exists') {
        const pytestResult = await executor.execute(
          'python -m pytest --version',
          workingDir,
          5000
        )
        if (pytestResult.exitCode === 0) {
          checks.push({
            kind: 'test',
            command: 'python -m pytest',
            status: 'pending',
            summary: 'Python 单元测试'
          })
        }
      }
    }
  } catch {
    // 文件系统读取失败，返回空计划
  }

  // 无可用检查 → unverified
  if (checks.length === 0) {
    return { checks: [], overallState: 'unverified' }
  }

  return {
    checks,
    overallState: 'pending'
  }
}

// ============ 执行检查 ============

/**
 * 执行验收计划中的所有检查
 *
 * 按顺序执行每条检查，记录真实退出码。
 * 某条失败不阻塞后续检查（全部跑完以收集完整诊断）。
 */
export async function runAcceptanceChecks(
  plan: AcceptancePlan,
  executor: CommandExecutor,
  workingDir: string,
  config?: Partial<AcceptanceConfig>
): Promise<AcceptancePlan> {
  const cfg = { ...DEFAULT_ACCEPTANCE_CONFIG, ...config }

  if (plan.checks.length === 0) {
    return { ...plan, overallState: 'unverified' }
  }

  // 深拷贝 checks 避免修改原对象
  const result: AcceptancePlan = {
    checks: plan.checks.map(c => ({ ...c })),
    overallState: 'running'
  }

  for (const check of result.checks) {
    if (!check.command) {
      check.status = 'failed'
      check.summary = '无检查命令'
      continue
    }

    check.status = 'running'
    check.startedAt = Date.now()
    check.cwd = workingDir

    try {
      const execResult = await executor.execute(
        check.command,
        workingDir,
        cfg.checkTimeoutMs
      )

      check.exitCode = execResult.exitCode
      check.timedOut = execResult.timedOut
      check.finishedAt = Date.now()

      if (execResult.timedOut) {
        check.status = 'failed'
        check.summary = `检查超时 (${cfg.checkTimeoutMs}ms)`
      } else if (execResult.exitCode === 0) {
        check.status = 'passed'
        check.summary = '通过'
      } else {
        check.status = 'failed'
        // 截取关键输出作为摘要（最后 500 字符）
        const output = (execResult.stderr || execResult.stdout || '').trim()
        check.summary = output.length > 500
          ? '...(截断)\n' + output.slice(-500)
          : output || `退出码 ${execResult.exitCode}`
      }
    } catch (err) {
      check.status = 'failed'
      check.exitCode = -1
      check.finishedAt = Date.now()
      check.summary = err instanceof Error ? err.message : String(err)
    }
  }

  // 综合判定
  result.overallState = evaluateGate(result)
  return result
}

// ============ 综合判定 ============

/**
 * 综合判定验收状态
 *
 * - 全部 passed → passed
 * - 任一 failed → failed
 * - 无检查 → unverified
 * - 有 running/pending → running
 */
export function evaluateGate(plan: AcceptancePlan): GateState {
  if (plan.checks.length === 0) {
    return 'unverified'
  }

  const statuses = plan.checks.map(c => c.status)

  if (statuses.some(s => s === 'running' || s === 'pending')) {
    return 'running'
  }

  if (statuses.every(s => s === 'passed')) {
    return 'passed'
  }

  if (statuses.some(s => s === 'failed')) {
    return 'failed'
  }

  return 'unverified'
}

// ============ 便捷函数 ============

/**
 * 一步完成验收：构建计划 → 执行检查 → 返回结果
 *
 * 供调度器、自主引擎、普通会话三条路径统一调用。
 */
export async function runAcceptance(
  workingDir: string,
  changedFiles: string[],
  executor: CommandExecutor,
  config?: Partial<AcceptanceConfig>
): Promise<AcceptancePlan> {
  const plan = await buildAcceptancePlan(workingDir, changedFiles, executor, config)

  if (plan.overallState === 'unverified' || plan.checks.length === 0) {
    return plan
  }

  return runAcceptanceChecks(plan, executor, workingDir, config)
}

/**
 * 从工具调用结果中提取成功写入的文件路径
 *
 * 供三条路径统一使用来收集 changedFiles。
 */
export function collectChangedFiles(
  toolCalls: Array<{
    functionName: string
    status: string
    arguments?: Record<string, any>
  }>
): string[] {
  const writeTools = new Set(['write_file', 'search_replace', 'create_directory'])
  const files: string[] = []

  for (const tc of toolCalls) {
    if (tc.status === 'success' && writeTools.has(tc.functionName)) {
      const path = tc.arguments?.path
      if (path && typeof path === 'string') {
        files.push(path)
      }
    }
  }

  // 去重
  return [...new Set(files)]
}

// ============ 有界修复循环（P0-C） ============

/** 修复循环配置 */
export interface RepairConfig {
  /** 最大修复次数（默认 3） */
  maxRepairs: number
  /** 同一失败无新证据时不重试（默认 true） */
  requireNewEvidence: boolean
}

export const DEFAULT_REPAIR_CONFIG: Required<RepairConfig> = {
  maxRepairs: 3,
  requireNewEvidence: true
}

/** 修复循环结果 */
export interface RepairResult {
  /** 最终验收结果 */
  acceptance: AcceptancePlan
  /** 使用的修复次数 */
  repairsUsed: number
}

/**
 * 从验收计划中提取诊断信息（用于注入到 LLM 消息中）
 */
export function extractRepairDiagnostics(plan: AcceptancePlan): string {
  const failedChecks = plan.checks.filter(c => c.status === 'failed')
  if (failedChecks.length === 0) return ''

  const lines: string[] = [
    '\u274c \u9a8c\u6536\u68c0\u67e5\u672a\u901a\u8fc7\uff0c\u8bf7\u5206\u6790\u4ee5\u4e0b\u9519\u8bef\u5e76\u4fee\u590d\uff1a'
  ]

  for (const check of failedChecks) {
    lines.push(`\n### [${check.kind}] ${check.command || '\u672a\u77e5\u547d\u4ee4'}`)
    if (check.exitCode !== undefined) {
      lines.push(`\u9000\u51fa\u7801: ${check.exitCode}`)
    }
    if (check.summary && check.summary !== '通过') {
      // 截取关键输出（最多 1000 字符）
      const output = check.summary.length > 1000
        ? check.summary.slice(-1000)
        : check.summary
      lines.push(`\u8f93\u51fa:\n${output}`)
    }
  }

  lines.push('\n\u8bf7\u4fee\u590d\u4ee5\u4e0a\u95ee\u9898\u540e\u91cd\u65b0\u63d0\u4ea4\u3002')
  return lines.join('\n')
}

/**
 * 检查两次失败之间是否有新证据
 *
 * 比较两次验收的失败检查的摘要，如果完全相同则认为无新证据。
 */
export function hasNewEvidence(
  prevPlan: AcceptancePlan,
  currentPlan: AcceptancePlan
): boolean {
  const prevFailed = prevPlan.checks.filter(c => c.status === 'failed')
  const currFailed = currentPlan.checks.filter(c => c.status === 'failed')

  // 失败数量不同 → 有新证据
  if (prevFailed.length !== currFailed.length) return true

  // 比较每条失败的摘要
  const prevSummaries = new Set(prevFailed.map(c => `${c.kind}:${c.command}:${c.summary.slice(0, 200)}`))
  for (const check of currFailed) {
    const key = `${check.kind}:${check.command}:${check.summary.slice(0, 200)}`
    if (!prevSummaries.has(key)) return true
  }

  return false
}

// ============ 恢复校验（P1-C） ============

/** 文件基线校验结果状态 */
export type FileBaselineStatus = 'write_landed' | 'write_lost' | 'conflict'

/** 文件基线记录 */
export interface FileBaselineEntry {
  beforeSha256: string
  afterSha256?: string
}

/** 单个文件的校验结果 */
export interface FileValidationResult {
  path: string
  status: FileBaselineStatus
  currentSha256: string
  beforeSha256: string
  afterSha256?: string
}

/**
 * 校验文件基线
 *
 * 三种情况：
 * - currentSha === afterSha256 → write_landed（写入已落盘，可重跑验收）
 * - currentSha === beforeSha256 → write_lost（写入未落盘/已撤销，需重新编辑）
 * - 两者均不等 → conflict（外部修改冲突，暂停并展示）
 *
 * @param readFileWithHash 读取文件内容及其 SHA-256 的异步函数（由调用方注入）
 *   返回 null 表示文件不存在。
 */
export async function validateFileBaselines(
  baselines: Record<string, FileBaselineEntry>,
  readFileWithHash: (path: string) => Promise<{ content: string; sha256: string } | null>
): Promise<FileValidationResult[]> {
  const results: FileValidationResult[] = []

  for (const [path, entry] of Object.entries(baselines)) {
    const fileData = await readFileWithHash(path)
    if (fileData === null) {
      // 文件不存在视为冲突
      results.push({
        path,
        status: 'conflict',
        currentSha256: '',
        beforeSha256: entry.beforeSha256,
        afterSha256: entry.afterSha256
      })
      continue
    }

    const currentSha = fileData.sha256

    let status: FileBaselineStatus
    if (entry.afterSha256 && currentSha === entry.afterSha256) {
      status = 'write_landed'
    } else if (currentSha === entry.beforeSha256) {
      status = 'write_lost'
    } else {
      status = 'conflict'
    }

    results.push({
      path,
      status,
      currentSha256: currentSha,
      beforeSha256: entry.beforeSha256,
      afterSha256: entry.afterSha256
    })
  }

  return results
}
