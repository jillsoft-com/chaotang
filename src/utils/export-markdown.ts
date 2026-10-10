/**
 * 朝议记录导出为 Markdown 格式
 */

import type { Debate, Minister } from '@/types'

/** 格式化时间戳为可读字符串 */
function fmtTime(ts: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString('zh-CN')
}

/** 获取角色名称（圣上 / 大臣名） */
function getMinisterName(id: string, ministers: Minister[]): string {
  if (id === 'emperor') return '圣上'
  return ministers.find(m => m.id === id)?.name || id
}

/** 获取角色头衔 */
function getMinisterTitle(id: string, ministers: Minister[]): string {
  if (id === 'emperor') return ''
  return ministers.find(m => m.id === id)?.title || ''
}

/** 获取角色头像 */
function getMinisterAvatar(id: string, ministers: Minister[]): string {
  if (id === 'emperor') return '🐲'
  return ministers.find(m => m.id === id)?.avatar || '👤'
}

/** 将朝议记录导出为 Markdown 字符串 */
export function exportDebateToMarkdown(debate: Debate, ministers: Minister[]): string {
  const lines: string[] = []

  // 标题与元信息
  lines.push(`# ${debate.topic || '未命名朝议'}`)
  lines.push('')
  lines.push(`> 生成时间：${fmtTime(debate.createdAt)}`)
  if (debate.completedAt) {
    lines.push(`> 完成时间：${fmtTime(debate.completedAt)}`)
  }
  const modeLabels: Record<string, string> = {
    court: '朝议模式',
    compare: '对比模式',
    private: '召见模式'
  }
  const modeLabel = modeLabels[debate.mode] || debate.mode
  const debateModeLabels: Record<string, string> = {
    serial: '串行',
    parallel: '并行',
    agent: 'Agent'
  }
  const debateModeLabel = debate.debateMode ? debateModeLabels[debate.debateMode] || debate.debateMode : ''
  lines.push(`> 模式：${modeLabel}${debateModeLabel ? ' · ' + debateModeLabel : ''}`)
  if (debate.tags && debate.tags.length > 0) {
    lines.push(`> 标签：${debate.tags.map(t => '`' + t + '`').join(' ')}`)
  }
  lines.push('')
  lines.push('---')
  lines.push('')

  // 发言记录
  lines.push('## 朝议记录')
  lines.push('')

  for (const speech of debate.speeches) {
    if (!speech.content || speech.status === 'pending') continue

    const name = getMinisterName(speech.ministerId, ministers)
    const title = getMinisterTitle(speech.ministerId, ministers)
    const avatar = getMinisterAvatar(speech.ministerId, ministers)
    const time = fmtTime(speech.timestamp)
    const header = title ? `${avatar} **${name}**（${title}）· ${time}` : `${avatar} **${name}** · ${time}`

    lines.push(`### ${header}`)
    lines.push('')

    // 工具调用记录
    if (speech.toolCalls && speech.toolCalls.length > 0) {
      lines.push('<details>')
      lines.push(`<summary>🔧 工具调用 (${speech.toolCalls.length})</summary>`)
      lines.push('')
      for (const tc of speech.toolCalls) {
        const status = tc.status === 'success' ? '✅' : tc.status === 'error' ? '❌' : '⏳'
        lines.push(`- ${status} \`${tc.functionName}\` (${tc.duration}ms)`)
        if (tc.status === 'error' && tc.result) {
          lines.push(`  - 错误: ${String(tc.result).slice(0, 200)}`)
        }
      }
      lines.push('')
      lines.push('</details>')
      lines.push('')
    }

    lines.push(speech.content)
    lines.push('')

    // Token 统计（如果有）
    if (speech.tokenUsage) {
      const { promptTokens, completionTokens, totalTokens } = speech.tokenUsage
      const model = speech.model || '未知模型'
      const duration = speech.durationMs ? ` · ${(speech.durationMs / 1000).toFixed(1)}s` : ''
      lines.push(`> 📊 ${model} · ${totalTokens} tokens (输入 ${promptTokens} + 输出 ${completionTokens})${duration}`)
      lines.push('')
    }
  }

  // 圣旨
  if (debate.imperialDecree) {
    lines.push('---')
    lines.push('')
    lines.push('## 📜 圣旨')
    lines.push('')
    lines.push(debate.imperialDecree)
    lines.push('')
  }

  // 决策报告（四象限）
  if (debate.decisionReport) {
    const report = debate.decisionReport
    lines.push('---')
    lines.push('')
    lines.push('## 📋 决策报告')
    lines.push('')
    if (report.verdict) {
      lines.push(`**🎯 决策结论：** ${report.verdict}`)
      lines.push('')
    }

    if (report.consensus.length > 0) {
      lines.push('### ✅ 共识点')
      lines.push('')
      for (const item of report.consensus) {
        lines.push(`- **${item.title}**：${item.detail}`)
        if (item.sources && item.sources.length > 0) {
          lines.push(`  - 来源：${item.sources.map(id => getMinisterName(id, ministers)).join('、')}`)
        }
      }
      lines.push('')
    }

    if (report.disagreements.length > 0) {
      lines.push('### ⚔️ 分歧点')
      lines.push('')
      for (const item of report.disagreements) {
        lines.push(`- **${item.title}**：${item.detail}`)
        if (item.sources && item.sources.length > 0) {
          lines.push(`  - 相关方：${item.sources.map(id => getMinisterName(id, ministers)).join('、')}`)
        }
      }
      lines.push('')
    }

    if (report.risks.length > 0) {
      lines.push('### ⚠️ 风险清单')
      lines.push('')
      for (const item of report.risks) {
        lines.push(`- **${item.title}**：${item.detail}`)
      }
      lines.push('')
    }

    if (report.assumptions.length > 0) {
      lines.push('### 🔍 待验证假设')
      lines.push('')
      for (const item of report.assumptions) {
        lines.push(`- **${item.title}**：${item.detail}`)
      }
      lines.push('')
    }

    if (report.nextSteps && report.nextSteps.length > 0) {
      lines.push('### 🚀 下一步行动')
      lines.push('')
      for (let i = 0; i < report.nextSteps.length; i++) {
        lines.push(`${i + 1}. ${report.nextSteps[i]}`)
      }
      lines.push('')
    }
  }

  // 附件清单
  if (debate.attachments && debate.attachments.length > 0) {
    lines.push('---')
    lines.push('')
    lines.push('## 📎 附件')
    lines.push('')
    for (const att of debate.attachments) {
      const sizeStr = att.fileSize < 1024
        ? `${att.fileSize} B`
        : att.fileSize < 1024 * 1024
          ? `${(att.fileSize / 1024).toFixed(1)} KB`
          : `${(att.fileSize / (1024 * 1024)).toFixed(1)} MB`
      lines.push(`- **${att.fileName}** (${att.fileType}, ${sizeStr})`)
    }
    lines.push('')
  }

  // 页脚
  lines.push('---')
  lines.push('')
  lines.push('*由朝堂 ChaoTang 生成 · 百官进言，圣裁由你*')

  return lines.join('\n')
}
