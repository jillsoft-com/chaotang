/**
 * MessagingManager — 消息集成管理器
 *
 * 管理所有消息适配器、配置持久化、服务器启停。
 */

import type { MessagingConfig, MessagingPlatform, OutgoingMessage, SendResult } from './types'
import { DEFAULT_MESSAGING_CONFIG } from './types'
import { WeComAdapter } from './adapters/wecom'
import { registerAdapter, getAdapter, initWebhookListener, setMessageHandler } from './message-router'
import type { MessageHandler } from './message-router'

const CONFIG_KEY = 'messaging_config'

/** 企业微信适配器单例 */
const wecomAdapter = new WeComAdapter()

/** Webhook 监听器取消函数 */
let webhookUnsubscribe: (() => void) | null = null

/** 服务器运行状态 */
let serverRunning = false

/**
 * 获取消息集成配置
 */
export function getMessagingConfig(): MessagingConfig {
  try {
    const saved = localStorage.getItem(CONFIG_KEY)
    if (saved) {
      return { ...DEFAULT_MESSAGING_CONFIG, ...JSON.parse(saved) }
    }
  } catch {
    // 解析失败使用默认值
  }
  return { ...DEFAULT_MESSAGING_CONFIG }
}

/**
 * 保存消息集成配置
 */
export function saveMessagingConfig(config: Partial<MessagingConfig>): void {
  const current = getMessagingConfig()
  const merged = { ...current, ...config }
  localStorage.setItem(CONFIG_KEY, JSON.stringify(merged))
}

/**
 * 初始化消息集成系统
 */
export function initMessaging(): void {
  const config = getMessagingConfig()

  // 配置企业微信适配器
  if (config.wecomWebhookUrl) {
    wecomAdapter.configure(config.wecomWebhookUrl, config.wecomSecret)
  }

  // 注册适配器
  registerAdapter(wecomAdapter)

  console.log('[Messaging] 消息集成系统已初始化')
}

/**
 * 启动 Webhook 回调服务器
 */
export async function startWebhookServer(port?: number): Promise<{ success: boolean; message: string }> {
  if (!window.electronAPI?.startWebhookServer) {
    return { success: false, message: 'Webhook 服务器仅在 Electron 桌面版可用' }
  }

  const config = getMessagingConfig()
  const result = await window.electronAPI.startWebhookServer({
    port: port || config.webhookPort
  })

  if (result.success) {
    serverRunning = true
    // 启动消息监听
    webhookUnsubscribe = initWebhookListener()
  }

  return {
    success: result.success,
    message: result.message || result.error || ''
  }
}

/**
 * 停止 Webhook 回调服务器
 */
export async function stopWebhookServer(): Promise<{ success: boolean; message: string }> {
  if (!window.electronAPI?.stopWebhookServer) {
    return { success: false, message: 'Webhook 服务器仅在 Electron 桌面版可用' }
  }

  const result = await window.electronAPI.stopWebhookServer()

  if (result.success) {
    serverRunning = false
    if (webhookUnsubscribe) {
      webhookUnsubscribe()
      webhookUnsubscribe = null
    }
  }

  return {
    success: result.success,
    message: result.message || ''
  }
}

/**
 * 获取服务器运行状态
 */
export function isServerRunning(): boolean {
  return serverRunning
}

/**
 * 发送消息到指定平台
 */
export async function sendMessage(
  platform: MessagingPlatform,
  message: OutgoingMessage
): Promise<SendResult> {
  const adapter = getAdapter(platform)
  if (!adapter) {
    return { success: false, error: `未找到平台 ${platform} 的适配器` }
  }
  return await adapter.send(message)
}

/**
 * 注册消息处理器（供外部调用，触发辩论等）
 */
export function onMessage(handler: MessageHandler): void {
  setMessageHandler(handler)
}

/**
 * 获取企业微信适配器实例
 */
export function getWeComAdapter(): WeComAdapter {
  return wecomAdapter
}
