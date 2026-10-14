/**
 * subagent-registry.ts 测试
 *
 * 覆盖：内置子 Agent 加载、查询、标签筛选、工具过滤、注册/清除、
 *       TaskNode.subAgentId 集成
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { subAgentRegistry } from '@/services/agent/subagent-registry'
import type { SubAgentProfile } from '@/services/agent/subagent-registry'
import { createTree, createNode, addNode } from '@/services/agent/task-tree'
import type { ToolDefinition } from '@/types'

// ============ 辅助 ============

/** 创建简易 ToolDefinition 列表（用于测试过滤） */
function makeToolDefs(): ToolDefinition[] {
  return [
    { type: 'function', function: { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'write_file', description: '写文件', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'search_code', description: '搜索', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'execute_command', description: '执行命令', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'run_tests', description: '运行测试', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'git_operation', description: 'Git', parameters: { type: 'object', properties: {} } } }
  ] as ToolDefinition[]
}

// ============ 测试用例 ============

describe('SubAgentRegistry — 内置子 Agent', () => {
  it('启动时加载 3 个内置子 Agent', () => {
    const all = subAgentRegistry.getSubAgents()
    const builtins = all.filter(a => a.source === 'builtin')
    expect(builtins.length).toBe(3)
  })

  it('包含 code-reviewer', () => {
    const sa = subAgentRegistry.getSubAgent('code-reviewer')
    expect(sa).toBeDefined()
    expect(sa!.name).toBe('代码审查员')
    expect(sa!.source).toBe('builtin')
    expect(sa!.systemPromptAddon.length).toBeGreaterThan(0)
  })

  it('包含 security-auditor', () => {
    const sa = subAgentRegistry.getSubAgent('security-auditor')
    expect(sa).toBeDefined()
    expect(sa!.tags).toContain('security')
  })

  it('包含 test-specialist', () => {
    const sa = subAgentRegistry.getSubAgent('test-specialist')
    expect(sa).toBeDefined()
    expect(sa!.tags).toContain('test')
  })

  it('不存在的 ID 返回 undefined', () => {
    expect(subAgentRegistry.getSubAgent('nonexistent')).toBeUndefined()
  })
})

describe('SubAgentRegistry — 标签筛选', () => {
  it('getByTag("review") 返回 code-reviewer', () => {
    const results = subAgentRegistry.getByTag('review')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.some(r => r.id === 'code-reviewer')).toBe(true)
  })

  it('getByTag("security") 返回 security-auditor', () => {
    const results = subAgentRegistry.getByTag('security')
    expect(results.some(r => r.id === 'security-auditor')).toBe(true)
  })

  it('getByTag("nonexistent") 返回空数组', () => {
    expect(subAgentRegistry.getByTag('nonexistent')).toHaveLength(0)
  })
})

describe('SubAgentRegistry — 工具过滤', () => {
  const toolDefs = makeToolDefs()

  it('白名单：只保留指定工具', () => {
    const profile: SubAgentProfile = {
      id: 'test-filter',
      name: '测试',
      description: '',
      systemPromptAddon: '',
      toolWhitelist: ['read_file', 'search_code'],
      tags: [],
      source: 'builtin'
    }
    const filtered = subAgentRegistry.filterTools(toolDefs, profile)
    expect(filtered).toHaveLength(2)
    expect(filtered.map(t => t.function.name)).toEqual(['read_file', 'search_code'])
  })

  it('黑名单：排除指定工具', () => {
    const profile: SubAgentProfile = {
      id: 'test-filter',
      name: '测试',
      description: '',
      systemPromptAddon: '',
      toolBlacklist: ['write_file', 'execute_command'],
      tags: [],
      source: 'builtin'
    }
    const filtered = subAgentRegistry.filterTools(toolDefs, profile)
    expect(filtered.every(t => t.function.name !== 'write_file')).toBe(true)
    expect(filtered.every(t => t.function.name !== 'execute_command')).toBe(true)
    expect(filtered.length).toBe(toolDefs.length - 2)
  })

  it('无白名单/黑名单时返回全部工具', () => {
    const profile: SubAgentProfile = {
      id: 'test-filter',
      name: '测试',
      description: '',
      systemPromptAddon: '',
      tags: [],
      source: 'builtin'
    }
    const filtered = subAgentRegistry.filterTools(toolDefs, profile)
    expect(filtered).toHaveLength(toolDefs.length)
  })

  it('内置 code-reviewer 排除写工具', () => {
    const reviewer = subAgentRegistry.getSubAgent('code-reviewer')!
    const filtered = subAgentRegistry.filterTools(toolDefs, reviewer)
    const names = filtered.map(t => t.function.name)
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('execute_command')
    expect(names).toContain('read_file')
    expect(names).toContain('search_code')
  })
})

describe('SubAgentRegistry — 列表摘要', () => {
  it('getListSummary 包含所有子 Agent', () => {
    const summary = subAgentRegistry.getListSummary()
    expect(summary).toContain('code-reviewer')
    expect(summary).toContain('security-auditor')
    expect(summary).toContain('test-specialist')
    expect(summary).toContain('可用子 Agent')
  })
})

describe('SubAgentRegistry — 注册与清除', () => {
  it('register 添加自定义子 Agent', () => {
    const custom: SubAgentProfile = {
      id: 'my-custom-agent',
      name: '自定义',
      description: '测试用',
      systemPromptAddon: '请特别注意测试覆盖',
      tags: ['custom-test'],
      source: 'custom'
    }
    subAgentRegistry.register(custom)
    expect(subAgentRegistry.getSubAgent('my-custom-agent')).toBeDefined()
    expect(subAgentRegistry.getByTag('custom-test')).toHaveLength(1)
  })

  it('clearCustom 只清除自定义，保留内置', () => {
    subAgentRegistry.register({
      id: 'temp-agent',
      name: '临时',
      description: '',
      systemPromptAddon: '',
      tags: [],
      source: 'custom'
    })
    subAgentRegistry.clearCustom()
    expect(subAgentRegistry.getSubAgent('temp-agent')).toBeUndefined()
    // 内置仍在
    expect(subAgentRegistry.getSubAgent('code-reviewer')).toBeDefined()
    expect(subAgentRegistry.getSubAgent('security-auditor')).toBeDefined()
    expect(subAgentRegistry.getSubAgent('test-specialist')).toBeDefined()
  })
})

describe('TaskNode.subAgentId 集成', () => {
  it('createNode 支持 subAgentId', () => {
    const tree = createTree('debate-1', '根', '描述')
    const node = createNode({
      title: '审查任务',
      description: '审查代码质量',
      parentId: tree.rootId,
      createdBy: 'chancellor',
      subAgentId: 'code-reviewer'
    })
    addNode(tree, node)
    expect(tree.nodes[node.id].subAgentId).toBe('code-reviewer')
  })

  it('subAgentId 默认为 undefined', () => {
    const tree = createTree('debate-1', '根', '描述')
    const node = createNode({
      title: '普通任务',
      description: '普通描述',
      parentId: tree.rootId,
      createdBy: 'user'
    })
    addNode(tree, node)
    expect(tree.nodes[node.id].subAgentId).toBeUndefined()
  })
})
