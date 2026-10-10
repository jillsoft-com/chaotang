/**
 * MessageRouter — 消息路由器
 *
 * 接收来自消息平台的 IncomingMessage，触发朝议辩论，
 * 辩论完成后通过同一平台回复结果。
 */

import type { IncomingMessage, MessagingPlatform } from './types'
import type { MessageAdapter } from './types'

/** 消息处理回调 */
export type MessageHandler = (message: IncomingMessage) => Promise<string | null>

/** 已注册的消息处理器 */
let messageHandler: MessageHandler | null = null

/** 适配器映射 */
const adapters = new Map<MessagingPlatform, MessageAdapter>()

/**
 * 注册消息处理器
 */
export function setMessageHandler(handler: MessageHandler): void {
  messageHandler = handler
}

/**
 * 注册适配器
 */
export function registerAdapter(adapter: MessageAdapter): void {
  adapters.set(adapter.platform, adapter)
}

/**
 * 获取适配器
 */
export function getAdapter(platform: MessagingPlatform): MessageAdapter | undefined {
  return adapters.get(platform)
}

/**
 * 处理接收到的消息
 */
export async function handleIncomingMessage(message: IncomingMessage): Promise<void> {
  console.log(`[MessageRouter] 收到来自 ${message.platform} 的消息:`, message.content.slice(0, 100))

  if (!messageHandler) {
    console.warn('[MessageRouter] 未注册消息处理器，忽略消息')
    return
  }

  try {
    const reply = await messageHandler(message)

    if (reply) {
      // 通过同一平台回复
      const adapter = adapters.get(message.platform)
      if (adapter) {
        await adapter.send({
          content: reply,
          type: 'markdown'
        })
      }
    }
  } catch (error) {
    console.error('[MessageRouter] 处理消息失败:', error)
  }
}

/**
 * 初始化 Electron Webhook 消息监听
 */
export function initWebhookListener(): () => void {
  if (!window.electronAPI?.onWebhookMessage) {
    return () => {}
  }

  const unsubscribe = window.electronAPI.onWebhookMessage((data: any) => {
    // 企业微信消息格式解析
    const message: IncomingMessage = {
      platform: 'wecom',
      content: data?.text?.content || data?.content || JSON.stringify(data),
      sender: {
        id: data?.from?.user_id || 'unknown',
        name: data?.from?.user_name || '未知'
      },
      raw: data,
      timestamp: Date.now()
    }

    handleIncomingMessage(message)
  })

  return unsubscribe
}
