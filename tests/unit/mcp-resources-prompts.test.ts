/**
 * MCP 协议完善测试（三期 Phase E）
 *
 * 覆盖：Resources、Prompts 支持
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MCPClient } from '@/services/mcp/mcp-client'
import type { MCPServerConfig } from '@/services/mcp/mcp-client'

// ============ 辅助 ============

function makeConfig(overrides?: Partial<MCPServerConfig>): MCPServerConfig {
  return {
    id: 'test-server',
    name: 'Test Server',
    transport: 'sse',
    url: 'http://localhost:3000',
    ...overrides
  }
}

// ============ Mock ============

const mockTools = [
  {
    name: 'search',
    description: 'Search the web',
    inputSchema: {
      type: 'object' as const,
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  }
]

const mockResources = [
  {
    uri: 'file:///README.md',
    name: 'README',
    description: 'Project readme',
    mimeType: 'text/markdown'
  }
]

const mockPrompts = [
  {
    name: 'code-review',
    description: 'Code review prompt',
    arguments: [
      { name: 'code', description: 'Code to review', required: true }
    ]
  }
]

// ============ 测试用例 ============

describe('MCPClient — Resources & Prompts', () => {
  let client: MCPClient

  beforeEach(() => {
    client = new MCPClient(makeConfig())
    // Mock 内部方法避免真实网络连接
    vi.spyOn(client as any, 'connectSSE').mockResolvedValue(undefined)
    vi.spyOn(client as any, 'initialize').mockResolvedValue(undefined)
    vi.spyOn(client as any, 'listTools').mockResolvedValue(mockTools)
    vi.spyOn(client as any, 'listResources').mockResolvedValue(mockResources)
    vi.spyOn(client as any, 'listPrompts').mockResolvedValue(mockPrompts)
  })

  it('连接后获取资源列表', async () => {
    await client.connect()
    expect(client.status.resources).toHaveLength(1)
    expect(client.status.resources[0].uri).toBe('file:///README.md')
    expect(client.status.resources[0].name).toBe('README')
  })

  it('连接后获取提示词列表', async () => {
    await client.connect()
    expect(client.status.prompts).toHaveLength(1)
    expect(client.status.prompts[0].name).toBe('code-review')
    expect(client.status.prompts[0].arguments).toHaveLength(1)
  })

  it('读取资源内容', async () => {
    await client.connect()
    vi.spyOn(client as any, 'sendRequest').mockResolvedValue({
      contents: [{ uri: 'file:///README.md', text: '# Hello' }]
    })
    
    const result = await client.readResource('file:///README.md')
    expect(result.uri).toBe('file:///README.md')
    expect(result.text).toBe('# Hello')
  })

  it('获取提示词', async () => {
    await client.connect()
    vi.spyOn(client as any, 'sendRequest').mockResolvedValue({
      messages: [{ role: 'user', content: { type: 'text', text: 'Review this code' } }]
    })
    
    const result = await client.getPrompt('code-review', { code: 'console.log("test")' })
    expect(result.messages).toBeDefined()
    expect(result.messages).toHaveLength(1)
  })

  it('断开连接后清空资源和提示词', async () => {
    await client.connect()
    expect(client.status.resources.length).toBeGreaterThan(0)
    expect(client.status.prompts.length).toBeGreaterThan(0)
    
    await client.disconnect()
    expect(client.status.resources).toHaveLength(0)
    expect(client.status.prompts).toHaveLength(0)
  })

  it('未连接时读取资源抛出错误', async () => {
    await expect(client.readResource('file:///test.txt')).rejects.toThrow('未连接')
  })

  it('未连接时获取提示词抛出错误', async () => {
    await expect(client.getPrompt('test')).rejects.toThrow('未连接')
  })
})

describe('MCPClient — 状态管理', () => {
  it('status 包含所有字段', () => {
    const client = new MCPClient(makeConfig())
    const status = client.status
    
    expect(status.id).toBe('test-server')
    expect(status.name).toBe('Test Server')
    expect(status.connected).toBe(false)
    expect(status.tools).toEqual([])
    expect(status.resources).toEqual([])
    expect(status.prompts).toEqual([])
    expect(status.error).toBeUndefined()
  })
})
