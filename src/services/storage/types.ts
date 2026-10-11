/**
 * 存储后端接口
 *
 * 为任务树快照、朝议历史和事件日志提供统一的存储抽象。
 * 业务代码不直接依赖 localStorage 的大对象读写。
 *
 * 设计依据：朝堂任务树运行时改进说明 R3。
 */

export interface StorageBackend {
  /** 读取值 */
  get(key: string): Promise<string | null>

  /** 写入值 */
  set(key: string, value: string): Promise<void>

  /** 删除键 */
  delete(key: string): Promise<void>

  /** 列出匹配前缀的所有键 */
  keys(prefix?: string): Promise<string[]>

  /** 估算存储大小（字节） */
  size(): Promise<number>

  /** 后端名称（用于日志） */
  readonly name: string
}

/** 存储后端类型 */
export type StorageBackendType = 'local' | 'indexeddb' | 'file'
