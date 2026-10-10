/**
 * BaseAdapter — 消息适配器基类
 *
 * 提供公共逻辑：连接状态管理、配置持久化。
 */

import type { MessageAdapter, MessagingPlatform, OutgoingMessage, SendResult } from './types'

export abstract class BaseAdapter implements MessageAdapter {
  abstract platform: MessagingPlatform
  abstract displayName: string
  abstract icon: string
  connected = false

  abstract send(message: OutgoingMessage): Promise<SendResult>
  abstract testConnection(): Promise<{ success: boolean; message: string }>

  /** 更新连接状态 */
  setConnected(connected: boolean): void {
    this.connected = connected
  }
}
