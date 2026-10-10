/**
 * MCP 模块入口
 *
 * 提供 MCP Client 服务和类型定义，
 * 使朝堂能够接入外部 MCP Server 的工具生态。
 */

export { mcpService } from './mcp-client'
export type {
  MCPToolDefinition,
  MCPServerConfig,
  MCPServerStatus
} from './mcp-client'
