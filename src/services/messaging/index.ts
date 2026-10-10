/**
 * Messaging 模块入口
 */
export type {
  MessagingPlatform, MessageAdapter, OutgoingMessage, IncomingMessage,
  SendResult, MessagingConfig
} from './types'
export { DEFAULT_MESSAGING_CONFIG } from './types'
export { BaseAdapter } from './base-adapter'
export { WeComAdapter } from './adapters/wecom'
export {
  setMessageHandler, registerAdapter, getAdapter,
  handleIncomingMessage, initWebhookListener
} from './message-router'
export {
  getMessagingConfig, saveMessagingConfig, initMessaging,
  startWebhookServer, stopWebhookServer, isServerRunning,
  sendMessage, onMessage, getWeComAdapter
} from './messaging-manager'
