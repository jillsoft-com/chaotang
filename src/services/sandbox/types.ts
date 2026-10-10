/**
 * Sandbox 沙箱配置类型定义
 */

/** 沙箱配置 */
export interface SandboxConfig {
  /** 是否启用沙箱隔离 */
  enabled: boolean
  /** 是否阻断子进程网络访问 */
  blockNetwork: boolean
  /** 子进程最大内存（MB） */
  maxMemoryMB: number
  /** 最大超时时间（ms） */
  maxTimeout: number
}

/** 沙箱执行结果 */
export interface SandboxResult {
  success: boolean
  exitCode: number
  stdout: string
  stderr: string
  timedOut?: boolean
  sandboxed?: boolean
}

/** 默认沙箱配置 */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: true,
  blockNetwork: false,
  maxMemoryMB: 512,
  maxTimeout: 120000
}
