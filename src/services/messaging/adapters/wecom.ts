/**
 * WeComAdapter — 企业微信 Webhook 适配器
 *
 * 通过企业微信自定义机器人的 Webhook API 发送消息到群聊。
 * API 文档：https://developer.work.weixin.qq.com/document/path/91770
 */

import { BaseAdapter } from '../base-adapter'
import type { OutgoingMessage, SendResult, MessagingPlatform } from '../types'

export class WeComAdapter extends BaseAdapter {
  platform: MessagingPlatform = 'wecom'
  displayName = '企业微信'
  icon = '💬'

  private webhookUrl: string = ''

  /**
   * 配置企业微信 Webhook
   */
  configure(webhookUrl: string, _secret?: string): void {
    this.webhookUrl = webhookUrl
  }

  /**
   * 发送消息到企业微信群
   */
  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.webhookUrl) {
      return { success: false, error: '未配置企业微信 Webhook URL' }
    }

    if (!window.electronAPI?.sendWebhook) {
      return { success: false, error: '当前环境不支持 Webhook（需要 Electron 桌面版）' }
    }

    try {
      const result = await window.electronAPI.sendWebhook({
        webhookUrl: this.webhookUrl,
        message: message.content,
        msgType: message.type || 'markdown'
      })

      this.connected = result.success
      return {
        success: result.success,
        message: result.message,
        error: result.error
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '发送失败'
      }
    }
  }

  /**
   * 测试 Webhook 连接
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    if (!this.webhookUrl) {
      return { success: false, message: '请先配置 Webhook URL' }
    }

    const result = await this.send({
      content: '🏛️ **朝堂** 连接测试成功！\n> 消息集成已就绪',
      type: 'markdown'
    })

    return {
      success: result.success,
      message: result.success ? '连接成功，已发送测试消息' : (result.error || '连接失败')
    }
  }
}
