/**
 * 幕僚二期 + 三期测试
 *
 * 覆盖：
 * - parseHandoverResponse（正常/包裹/错误格式）
 * - renderHandoverPackage（完整/空字段）
 * - parseErrorAttribution（正常/无效类别/错误格式）
 * - parseReportCheck（正常/错误格式）
 * - buildHandoverPackage（provider 不可用抛异常）
 * - attributeError（provider 不可用抛异常）
 * - checkReport（provider 不可用抛异常）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  parseHandoverResponse,
  renderHandoverPackage,
  buildHandoverPackage,
} from '@/services/agent/handover-package'
import type { HandoverPackage } from '@/services/agent/handover-package'
import {
  parseErrorAttribution,
  parseReportCheck,
  attributeError,
  checkReport,
} from '@/services/skills/llm-advisor'
import { resetAppStorageForTest, initializeAppStorage, appStorage } from '@/services/storage/app-storage'
import { resetStorageBackend, setStorageBackend } from '@/services/storage/factory'
import { FileStorageBackend } from '@/services/storage/file-storage'

// ============ 二期：交接包解析 ============

describe('parseHandoverResponse', () => {
  it('正常 JSON 解析成功', () => {
    const raw = JSON.stringify({
      goal: '分析代码质量',
      requiredItems: ['保留用户指定的目录结构'],
      completedItems: ['已创建 src/utils.ts（证据: [E1]）'],
      evidenceRefs: ['[E1] src/utils.ts 包含 10 个工具函数'],
      unresolvedIssues: ['测试覆盖率不足'],
      nextSteps: ['补充单元测试']
    })

    const result = parseHandoverResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.goal).toBe('分析代码质量')
    expect(result!.requiredItems).toHaveLength(1)
    expect(result!.completedItems).toHaveLength(1)
    expect(result!.evidenceRefs).toHaveLength(1)
    expect(result!.unresolvedIssues).toHaveLength(1)
    expect(result!.nextSteps).toHaveLength(1)
  })

  it('markdown 代码块包裹的 JSON', () => {
    const raw = '```json\n{"goal":"测试","requiredItems":[],"completedItems":[],"evidenceRefs":[],"unresolvedIssues":[],"nextSteps":[]}\n```'

    const result = parseHandoverResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.goal).toBe('测试')
  })

  it('多余文本包裹的 JSON', () => {
    const raw = '以下是交接包：\n{"goal":"分析","requiredItems":["要求1"],"completedItems":[],"evidenceRefs":[],"unresolvedIssues":[],"nextSteps":["下一步1"]}\n希望有帮助！'

    const result = parseHandoverResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.goal).toBe('分析')
    expect(result!.requiredItems).toEqual(['要求1'])
    expect(result!.nextSteps).toEqual(['下一步1'])
  })

  it('格式错误返回 null', () => {
    expect(parseHandoverResponse('')).toBeNull()
    expect(parseHandoverResponse('这不是 JSON')).toBeNull()
    expect(parseHandoverResponse('{broken')).toBeNull()
  })

  it('缺失字段使用默认空数组', () => {
    const raw = JSON.stringify({ goal: '简单任务' })

    const result = parseHandoverResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.goal).toBe('简单任务')
    expect(result!.requiredItems).toEqual([])
    expect(result!.completedItems).toEqual([])
    expect(result!.evidenceRefs).toEqual([])
    expect(result!.unresolvedIssues).toEqual([])
    expect(result!.nextSteps).toEqual([])
  })
})

describe('renderHandoverPackage', () => {
  it('完整交接包渲染所有段落', () => {
    const handover: HandoverPackage = {
      goal: '分析项目代码',
      requiredItems: ['保留目录结构'],
      completedItems: ['已创建 utils.ts（证据: [E1]）'],
      evidenceRefs: ['[E1] utils.ts 包含 10 个函数'],
      unresolvedIssues: ['缺少测试'],
      nextSteps: ['补充测试']
    }

    const text = renderHandoverPackage(handover)
    expect(text).toContain('[以下为之前对话的结构化交接包]')
    expect(text).toContain('## 目标')
    expect(text).toContain('分析项目代码')
    expect(text).toContain('## 不可丢弃的用户要求')
    expect(text).toContain('保留目录结构')
    expect(text).toContain('## 已完成事项')
    expect(text).toContain('已创建 utils.ts')
    expect(text).toContain('## 证据引用')
    expect(text).toContain('## 未解决问题')
    expect(text).toContain('缺少测试')
    expect(text).toContain('## 下一步')
    expect(text).toContain('补充测试')
    expect(text).toContain('[交接包结束')
  })

  it('空字段不渲染对应段落', () => {
    const handover: HandoverPackage = {
      goal: '简单任务',
      requiredItems: [],
      completedItems: [],
      evidenceRefs: [],
      unresolvedIssues: [],
      nextSteps: []
    }

    const text = renderHandoverPackage(handover)
    expect(text).toContain('## 目标')
    expect(text).toContain('简单任务')
    expect(text).not.toContain('## 不可丢弃的用户要求')
    expect(text).not.toContain('## 已完成事项')
    expect(text).not.toContain('## 证据引用')
    expect(text).not.toContain('## 未解决问题')
    expect(text).not.toContain('## 下一步')
  })
})

// ============ 三期：异常归因解析 ============

describe('parseErrorAttribution', () => {
  it('正常 JSON 解析成功', () => {
    const raw = JSON.stringify({
      category: 'tool_error',
      summary: '文件写入失败',
      rootCause: '目标目录不存在',
      affectedTools: ['write_file'],
      suggestions: ['先创建目录再写入']
    })

    const result = parseErrorAttribution(raw)
    expect(result).not.toBeNull()
    expect(result!.category).toBe('tool_error')
    expect(result!.summary).toBe('文件写入失败')
    expect(result!.rootCause).toBe('目标目录不存在')
    expect(result!.affectedTools).toEqual(['write_file'])
    expect(result!.suggestions).toEqual(['先创建目录再写入'])
  })

  it('无效类别回退为 tool_error', () => {
    const raw = JSON.stringify({
      category: 'invalid_category',
      summary: '测试',
      rootCause: '',
      affectedTools: [],
      suggestions: []
    })

    const result = parseErrorAttribution(raw)
    expect(result).not.toBeNull()
    expect(result!.category).toBe('tool_error')
  })

  it('所有有效类别都能正确解析', () => {
    const categories = ['tool_error', 'permission_denied', 'resource_issue', 'logic_error', 'timeout', 'external_factor']
    for (const cat of categories) {
      const raw = JSON.stringify({ category: cat, summary: '', rootCause: '', affectedTools: [], suggestions: [] })
      const result = parseErrorAttribution(raw)
      expect(result).not.toBeNull()
      expect(result!.category).toBe(cat)
    }
  })

  it('格式错误返回 null', () => {
    expect(parseErrorAttribution('')).toBeNull()
    expect(parseErrorAttribution('不是 JSON')).toBeNull()
  })

  it('markdown 包裹的 JSON', () => {
    const raw = '```json\n{"category":"timeout","summary":"超时","rootCause":"网络慢","affectedTools":[],"suggestions":[]}\n```'
    const result = parseErrorAttribution(raw)
    expect(result).not.toBeNull()
    expect(result!.category).toBe('timeout')
  })
})

// ============ 三期：汇报检查解析 ============

describe('parseReportCheck', () => {
  it('正常 JSON 解析成功', () => {
    const raw = JSON.stringify({
      goalCovered: true,
      coveredPoints: ['代码分析完成', '测试通过'],
      missingPoints: [],
      suggestions: ['可以补充性能分析']
    })

    const result = parseReportCheck(raw)
    expect(result).not.toBeNull()
    expect(result!.goalCovered).toBe(true)
    expect(result!.coveredPoints).toHaveLength(2)
    expect(result!.missingPoints).toHaveLength(0)
    expect(result!.suggestions).toHaveLength(1)
  })

  it('目标未覆盖', () => {
    const raw = JSON.stringify({
      goalCovered: false,
      coveredPoints: ['部分分析'],
      missingPoints: ['缺少总结', '缺少建议'],
      suggestions: ['补充完整分析']
    })

    const result = parseReportCheck(raw)
    expect(result).not.toBeNull()
    expect(result!.goalCovered).toBe(false)
    expect(result!.missingPoints).toHaveLength(2)
  })

  it('格式错误返回 null', () => {
    expect(parseReportCheck('')).toBeNull()
    expect(parseReportCheck('{broken')).toBeNull()
  })

  it('缺失字段使用默认值', () => {
    const raw = JSON.stringify({ goalCovered: true })
    const result = parseReportCheck(raw)
    expect(result).not.toBeNull()
    expect(result!.goalCovered).toBe(true)
    expect(result!.coveredPoints).toEqual([])
    expect(result!.missingPoints).toEqual([])
    expect(result!.suggestions).toEqual([])
  })
})

// ============ 异步函数：provider 不可用时抛异常 ============

describe('幕僚二期三期 — provider 不可用', () => {
  const file = new Map<string, string>()

  beforeEach(async () => {
    localStorage.clear()
    file.clear()
    resetAppStorageForTest()
    resetStorageBackend()

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        storeGetAll: async () => Object.fromEntries(file),
        storeGetPath: async () => 'test/chaotang-store.json',
        storeSet: async (key: string, value: string) => { file.set(key, value); return true },
        storeDelete: async (key: string) => { file.delete(key); return true },
        storeSetSync: (key: string, value: string) => { file.set(key, value) },
        storeDeleteSync: (key: string) => { file.delete(key) },
        loadApiKeys: async () => ({}),
        saveApiKeys: async () => true
      }
    })

    setStorageBackend(new FileStorageBackend())
    await initializeAppStorage()
  })

  afterEach(() => {
    resetAppStorageForTest()
    resetStorageBackend()
    delete (window as { electronAPI?: unknown }).electronAPI
    localStorage.clear()
  })

  it('buildHandoverPackage: provider 不可用时抛异常', async () => {
    const messages = [
      { role: 'system' as const, content: '系统指令' },
      { role: 'user' as const, content: '用户消息' },
      { role: 'assistant' as const, content: 'AI 回复' },
      { role: 'user' as const, content: '后续消息' },
      { role: 'assistant' as const, content: '后续回复' },
    ]

    await expect(
      buildHandoverPackage({ messages, taskGoal: '测试' })
    ).rejects.toThrow()
  })

  it('buildHandoverPackage: 消息太少时抛异常', async () => {
    const messages = [
      { role: 'system' as const, content: '系统' },
      { role: 'user' as const, content: '用户' },
    ]

    await expect(
      buildHandoverPackage({ messages, taskGoal: '测试' })
    ).rejects.toThrow('消息数量不足')
  })

  it('attributeError: provider 不可用时抛异常', async () => {
    await expect(
      attributeError({
        taskDescription: '测试任务',
        failedToolCalls: [],
        errorMessage: '测试错误'
      })
    ).rejects.toThrow()
  })

  it('checkReport: provider 不可用时抛异常', async () => {
    await expect(
      checkReport({
        goal: '测试目标',
        requirements: [],
        reportContent: '测试报告内容'
      })
    ).rejects.toThrow()
  })
})
