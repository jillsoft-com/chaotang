/**
 * 消息集成系统类型定义
 *
 * Adapter 模式，支持多种消息平台的接入。
 */

/** 消息平台标识 */
export type MessagingPlatform = 'wecom' | 'dingtalk' | 'feishu'

/** 消息适配器接口 */
export interface MessageAdapter {
  /** 平台标识 */
  platform: MessagingPlatform
  /** 平台显示名称 */
  displayName: string
  /** 平台图标 */
  icon: string
  /** 是否已连接 */
  connected: boolean
  /** 发送消息 */
  send(message: OutgoingMessage): Promise<SendResult>
  /** 测试连接 */
  testConnection(): Promise<{ success: boolean; message: string }>
}

/** 发送的消息 */
export interface OutgoingMessage {
  /** 消息内容（纯文本或 Markdown） */
  content: string
  /** 消息类型 */
  type: 'text' | 'markdown'
  /** @提及的人员 ID 列表 */
  mentionedList?: string[]
}

/** 接收的消息 */
export interface IncomingMessage {
  /** 消息平台 */
  platform: MessagingPlatform
  /** 消息内容 */
  content: string
  /** 发送者信息 */
  sender: {
    id: string
    name: string
  }
  /** 原始数据 */
  raw: any
  /** 接收时间 */
  timestamp: number
}

/** 发送结果 */
export interface SendResult {
  success: boolean
  message?: string
  error?: string
}

/** 消息集成配置 */
export interface MessagingConfig {
  /** 企业微信 Webhook URL */
  wecomWebhookUrl?: string
  /** 企业微信 Webhook Secret（用于签名校验） */
  wecomSecret?: string
  /** 回调服务器端口 */
  webhookPort: number
  /** 是否自动启动回调服务器 */
  autoStartServer: boolean
  /** 辩论完成后自动推送结果 */
  autoPushResults: boolean
}

/** 默认配置 */
export const DEFAULT_MESSAGING_CONFIG: MessagingConfig = {
  webhookPort: 9527,
  autoStartServer: false,
  autoPushResults: false
}
