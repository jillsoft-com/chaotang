/**
 * SKILL.md 解析器
 *
 * 解析 SKILL.md 文件中的 YAML frontmatter，提取插件配置和工具定义。
 * 不依赖外部 YAML 库，使用简化的 YAML 解析（支持嵌套对象和数组）。
 */

import type { PluginManifest, PluginToolDefinition } from './types'
import type { ToolDefinition, ToolHandler } from '@/types'

/**
 * 从 Markdown 文件中提取 YAML frontmatter
 * @param content SKILL.md 文件内容
 * @returns frontmatter 字符串和 body
 */
export function extractFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    return { frontmatter: '', body: content }
  }
  return { frontmatter: match[1], body: match[2] }
}

/**
 * 简化的 YAML 解析器
 * 支持：标量值、嵌套对象、数组、多行字符串（| 和 >）
 * 不支持：锚点/别名、复杂类型标签
 */
export function parseSimpleYaml(yaml: string): Record<string, any> {
  const result: Record<string, any> = {}
  const lines = yaml.split('\n')
  let i = 0

  function getIndent(line: string): number {
    const match = line.match(/^(\s*)/)
    return match ? match[1].length : 0
  }

  function parseValue(value: string): any {
    const trimmed = value.trim()
    if (trimmed === '' || trimmed === '~' || trimmed === 'null') return null
    if (trimmed === 'true' || trimmed === 'True' || trimmed === 'TRUE') return true
    if (trimmed === 'false' || trimmed === 'False' || trimmed === 'FALSE') return false
    if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10)
    if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed)
    // 去除引号
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return trimmed.slice(1, -1)
    }
    // 内联数组 [a, b, c]
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const inner = trimmed.slice(1, -1)
      return inner.split(',').map(s => parseValue(s.trim())).filter(v => v !== null)
    }
    return trimmed
  }

  function parseBlock(baseIndent: number): Record<string, any> {
    const obj: Record<string, any> = {}

    while (i < lines.length) {
      const line = lines[i]
      const trimmed = line.trim()

      // 跳过空行和注释
      if (trimmed === '' || trimmed.startsWith('#')) {
        i++
        continue
      }

      const indent = getIndent(line)

      // 如果缩进比基础缩进小，说明当前块结束
      if (indent < baseIndent) break

      // 数组项
      if (trimmed.startsWith('- ')) {
        break // 数组项在上层处理
      }

      // 键值对
      const colonIndex = trimmed.indexOf(':')
      if (colonIndex === -1) {
        i++
        continue
      }

      const key = trimmed.slice(0, colonIndex).trim()
      const valueStr = trimmed.slice(colonIndex + 1).trim()

      if (valueStr === '|' || valueStr === '>') {
        // 多行字符串
        i++
        const multiLineIndent = i < lines.length ? getIndent(lines[i]) : indent + 2
        let multiLine = ''
        while (i < lines.length) {
          const ml = lines[i]
          if (ml.trim() === '' || getIndent(ml) >= multiLineIndent) {
            multiLine += (multiLine ? '\n' : '') + ml.trim()
            i++
          } else {
            break
          }
        }
        obj[key] = valueStr === '>' ? multiLine.replace(/\n/g, ' ') : multiLine
      } else if (valueStr === '') {
        // 嵌套对象或数组
        i++
        if (i < lines.length) {
          const nextLine = lines[i]
          const nextTrimmed = nextLine.trim()
          const nextIndent = getIndent(nextLine)

          if (nextIndent > indent && nextTrimmed.startsWith('- ')) {
            // 解析数组
            obj[key] = parseArray(nextIndent)
          } else if (nextIndent > indent) {
            // 解析嵌套对象
            obj[key] = parseBlock(nextIndent)
          } else {
            obj[key] = null
          }
        }
      } else {
        obj[key] = parseValue(valueStr)
        i++
      }
    }

    return obj
  }

  function parseArray(baseIndent: number): any[] {
    const arr: any[] = []

    while (i < lines.length) {
      const line = lines[i]
      const trimmed = line.trim()

      if (trimmed === '' || trimmed.startsWith('#')) {
        i++
        continue
      }

      const indent = getIndent(line)
      if (indent < baseIndent) break

      if (trimmed.startsWith('- ')) {
        const itemContent = trimmed.slice(2).trim()
        const colonIdx = itemContent.indexOf(':')

        if (colonIdx !== -1) {
          // 对象数组项
          const firstKey = itemContent.slice(0, colonIdx).trim()
          const firstValue = itemContent.slice(colonIdx + 1).trim()
          const itemObj: Record<string, any> = {}
          itemObj[firstKey] = parseValue(firstValue)
          i++

          // 读取该对象的其余属性
          while (i < lines.length) {
            const subLine = lines[i]
            const subTrimmed = subLine.trim()
            const subIndent = getIndent(subLine)

            if (subTrimmed === '' || subIndent <= indent) break

            const subColonIdx = subTrimmed.indexOf(':')
            if (subColonIdx !== -1 && !subTrimmed.startsWith('- ')) {
              const subKey = subTrimmed.slice(0, subColonIdx).trim()
              const subVal = subTrimmed.slice(subColonIdx + 1).trim()

              if (subVal === '' && i + 1 < lines.length && getIndent(lines[i + 1]) > subIndent) {
                i++
                const nextIndent = getIndent(lines[i])
                if (lines[i].trim().startsWith('- ')) {
                  itemObj[subKey] = parseArray(nextIndent)
                } else {
                  itemObj[subKey] = parseBlock(nextIndent)
                }
              } else {
                itemObj[subKey] = parseValue(subVal)
                i++
              }
            } else {
              break
            }
          }

          arr.push(itemObj)
        } else {
          // 简单数组项
          arr.push(parseValue(itemContent))
          i++
        }
      } else {
        break
      }
    }

    return arr
  }

  // 开始解析
  parseBlock(0)

  // 将解析结果合并到 result
  i = 0
  Object.assign(result, parseBlock(0))

  return result
}

/**
 * 解析 SKILL.md 文件内容为 PluginManifest
 */
export function parseSkillMd(content: string): PluginManifest {
  const { frontmatter } = extractFrontmatter(content)

  if (!frontmatter) {
    throw new Error('SKILL.md 缺少 YAML frontmatter（以 --- 开头和结尾）')
  }

  const parsed = parseSimpleYaml(frontmatter)

  // 校验必填字段
  if (!parsed.id || typeof parsed.id !== 'string') {
    throw new Error('SKILL.md 缺少 id 字段')
  }
  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error('SKILL.md 缺少 name 字段')
  }
  if (!parsed.tools || !Array.isArray(parsed.tools) || parsed.tools.length === 0) {
    throw new Error('SKILL.md 缺少 tools 数组或 tools 为空')
  }

  // 校验每个 tool 的基本结构
  for (const tool of parsed.tools) {
    if (!tool.name || typeof tool.name !== 'string') {
      throw new Error(`工具定义缺少 name 字段`)
    }
    if (!tool.description || typeof tool.description !== 'string') {
      throw new Error(`工具 ${tool.name} 缺少 description 字段`)
    }
    if (!tool.parameters || typeof tool.parameters !== 'object') {
      throw new Error(`工具 ${tool.name} 缺少 parameters 定义`)
    }
  }

  return {
    id: parsed.id,
    name: parsed.name,
    description: parsed.description || '',
    icon: parsed.icon,
    category: parsed.category || 'system',
    version: parsed.version,
    author: parsed.author,
    tools: parsed.tools as PluginToolDefinition[],
    handler: typeof parsed.handler === 'string' ? parsed.handler : undefined,
    bindTo: Array.isArray(parsed.bindTo) ? parsed.bindTo : undefined
  }
}

/**
 * 将 PluginToolDefinition 转换为标准 ToolDefinition
 */
export function toToolDefinition(tool: PluginToolDefinition): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: tool.parameters.type || 'object',
        properties: tool.parameters.properties as any,
        required: tool.parameters.required
      }
    }
  }
}

/**
 * 编译 handler 代码为可执行函数
 *
 * 安全策略：
 * - 禁止 require/import/process/fs/child_process
 * - 在受限 Function 构造器中执行
 * - 只允许纯计算和 JSON 操作
 */
export function compileHandler(code: string, toolNames: string[]): Record<string, ToolHandler> {
  const handlers: Record<string, ToolHandler> = {}

  // 安全检查：禁止危险 API
  const forbiddenPatterns = [
    /\brequire\s*\(/,
    /\bimport\s+/,
    /\bprocess\b/,
    /\bglobal\b/,
    /\bglobalThis\b/,
    /\b__dirname\b/,
    /\b__filename\b/,
    /\beval\s*\(/,
    /\bFunction\s*\(/,
    /\bsetTimeout\s*\(/,
    /\bsetInterval\s*\(/,
  ]

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(code)) {
      throw new Error(`Handler 代码包含禁止的 API: ${pattern.source}`)
    }
  }

  // 为每个工具创建 handler
  // handler 代码应该定义一个名为 handler 的 async 函数，或者为每个工具名定义对应的函数
  for (const toolName of toolNames) {
    try {
      // 构建受限的执行上下文
      const wrappedCode = `
        "use strict";
        const fetch = undefined;
        const XMLHttpRequest = undefined;
        const WebSocket = undefined;
        ${code}
        ;
        return typeof ${toolName} === 'function' ? ${toolName}
             : typeof handler === 'function' ? handler
             : null;
      `
      const factory = new Function('args', wrappedCode)
      const fn = factory(undefined)

      if (typeof fn === 'function') {
        handlers[toolName] = async (args: Record<string, any>) => {
          return await fn(args)
        }
      } else {
        // 如果没有找到对应函数，创建一个返回提示信息的 handler
        handlers[toolName] = async () => ({
          error: `插件 handler 未定义函数 ${toolName} 或 handler`
        })
      }
    } catch (error) {
      throw new Error(`编译工具 ${toolName} 的 handler 失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  return handlers
}
