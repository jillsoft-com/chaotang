/**
 * 最小工具集 — 8 个基础工具的实现
 *
 * 1. web_search    — 网络搜索（通过搜索引擎 API）
 * 2. knowledge_query — 知识库检索（本地 RAG，初期为简单关键词匹配）
 * 3. calculate     — 数学表达式求值
 * 4. read_file     — 读取本地文件
 * 5. write_file    — 写入本地文件
 * 6. create_directory — 创建目录
 * 7. read_directory   — 读取目录内容
 * 8. summarize_results — 汇总多个 worker 的结果
 */

import type { ToolDefinition, ToolHandler } from '@/types'
import { memoryStore } from '@/services/memory'

// ============ 工具定义（发给 LLM 的 Schema）============

export const webSearchTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'web_search',
    description: '搜索互联网上的信息。输入搜索关键词，返回相关的搜索结果摘要。适合查找实时信息、新闻、政策、数据等。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词'
        },
        max_results: {
          type: 'integer',
          description: '最大返回结果数，默认 5',
          default: 5
        }
      },
      required: ['query']
    }
  }
}

export const knowledgeQueryTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'knowledge_query',
    description: '从本地知识库中检索信息。输入问题，返回相关的知识片段。适合查找领域知识、历史案例、专业资料等。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要查询的问题'
        },
        context: {
          type: 'string',
          description: '可选的上下文信息，帮助缩小检索范围'
        }
      },
      required: ['question']
    }
  }
}

export const calculateTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'calculate',
    description: '计算数学表达式。支持基本运算、百分比、幂运算等。适合进行财务计算、统计分析、预算估算等。',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: '数学表达式，如 "(100 + 200) * 0.15" 或 "1000 / 12"'
        }
      },
      required: ['expression']
    }
  }
}

export const readFileTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_file',
    description: '读取本地文件的内容。支持文本文件和常见代码文件（.txt, .md, .csv, .json, .js, .ts, .vue, .py, .java 等）。适合读取文档、代码、配置文件等。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件的完整路径'
        }
      },
      required: ['path']
    }
  }
}

export const summarizeResultsTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'summarize_results',
    description: '汇总多个信息源的结果，生成综合摘要。适合将多个大臣/分析结果进行整合归纳。',
    parameters: {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          description: '需要汇总的结果列表',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string', description: '来源名称' },
              content: { type: 'string', description: '内容' }
            }
          }
        },
        focus: {
          type: 'string',
          description: '汇总的重点方向'
        }
      },
      required: ['results']
    }
  }
}

export const writeFileTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'write_file',
    description: '将内容写入本地文件。支持文本文件（.txt, .md, .csv, .json 等）。如果父目录不存在会自动创建。适合保存报告、导出数据、记录分析结果等。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件的完整路径（如 D:\\output\\report.md）'
        },
        content: {
          type: 'string',
          description: '要写入的文件内容'
        }
      },
      required: ['path', 'content']
    }
  }
}

export const createDirectoryTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'create_directory',
    description: '创建本地目录。支持递归创建多级目录。适合在写入文件前创建目录结构。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '目录的完整路径（如 D:\\output\\reports）'
        }
      },
      required: ['path']
    }
  }
}

export const readDirectoryTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_directory',
    description: '读取目录内容，列出文件和子目录。返回每个条目的名称、类型、大小和修改时间。适合浏览文件结构、查找已有文件等。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '目录的完整路径'
        }
      },
      required: ['path']
    }
  }
}

export const readDocumentTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_document',
    description: '读取 Office 文档和 PDF 文件的文本内容。支持格式：.doc, .docx, .pdf, .xls, .xlsx, .pptx。适合读取报告、表格、演示文稿、合同等文档。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文档文件的完整路径'
        }
      },
      required: ['path']
    }
  }
}

export const executeCommandTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'execute_command',
    description: '在命令行中执行命令（Windows 默认 PowerShell，Linux/Mac 默认 bash）。适合运行构建命令、查看 git 状态、执行测试、安装依赖等。命令在工作目录下执行。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的命令，如 "npm install"、"git status"、"node -v"'
        },
        cwd: {
          type: 'string',
          description: '工作目录路径，默认为项目根目录'
        },
        timeout: {
          type: 'integer',
          description: '超时时间（毫秒），默认 30000，最大 120000'
        }
      },
      required: ['command']
    }
  }
}

export const searchCodeTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'search_code',
    description: '在指定目录中搜索代码内容，支持普通文本和正则表达式。返回匹配的文件名、行号和行内容，类似 grep 命令。适合查找代码中的关键词、函数名、变量引用等。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '搜索模式（文本或正则表达式），如 "function" 或 "export\\s+const"'
        },
        directory: {
          type: 'string',
          description: '搜索的目录路径（绝对路径）'
        },
        filePattern: {
          type: 'string',
          description: '文件扩展名过滤，如 "*.ts" 或 "ts,vue"（可选）'
        },
        maxResults: {
          type: 'integer',
          description: '最大返回结果数，默认 50，最大 200',
          default: 50
        },
        isRegex: {
          type: 'boolean',
          description: '是否使用正则表达式，默认 false',
          default: false
        }
      },
      required: ['pattern', 'directory']
    }
  }
}

export const gitOperationTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'git_operation',
    description: '执行 Git 操作。支持查看状态(status)、差异(diff)、日志(log)、分支(branch)、提交(commit)等常用操作。',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['status', 'diff', 'diff-staged', 'log', 'branch', 'branch-all', 'remote', 'show', 'add', 'commit', 'stash', 'stash-list'],
          description: 'Git 操作类型'
        },
        args: {
          type: 'string',
          description: '附加参数，如 commit 的提交信息、show 的 commit hash 等'
        },
        cwd: {
          type: 'string',
          description: 'Git 仓库目录路径'
        }
      },
      required: ['operation']
    }
  }
}

export const runTestsTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'run_tests',
    description: '运行项目的测试套件。自动检测测试框架（vitest/jest/pytest/cargo/go等），返回测试结果摘要。修改代码后可反复调用直到测试全部通过。',
    parameters: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: '项目目录路径'
        },
        testCommand: {
          type: 'string',
          description: '自定义测试命令（可选，不填则自动检测）'
        }
      }
    }
  }
}

// ============ 工具处理器实现 ============

/**
 * web_search — 网络搜索
 * 使用 DuckDuckGo HTML 搜索结果页（无需 API Key，中文支持好）
 * 备用：DuckDuckGo Instant Answer API
 */
export const webSearchHandler: ToolHandler = async (args) => {
  const { query, max_results = 5 } = args

  // 优先尝试 HTML 搜索结果页
  try {
    const htmlResults = await searchDuckDuckGoHTML(query, max_results)
    if (htmlResults.length > 0) {
      return {
        query,
        source: 'duckduckgo',
        result_count: htmlResults.length,
        results: htmlResults
      }
    }
  } catch (error) {
    console.warn('[web_search] HTML 搜索失败，尝试备用方案:', error)
  }

  // 备用：Instant Answer API
  try {
    const apiResults = await searchDuckDuckGoAPI(query, max_results)
    if (apiResults.length > 0) {
      return {
        query,
        source: 'duckduckgo_instant',
        result_count: apiResults.length,
        results: apiResults
      }
    }
  } catch (error) {
    console.warn('[web_search] Instant Answer 搜索也失败:', error)
  }

  return {
    query,
    message: `搜索 "${query}" 未找到结果，建议更换关键词或尝试英文搜索。`,
    results: []
  }
}

/**
 * DuckDuckGo HTML 搜索 — 抓取搜索结果页面并解析
 * 自动检测环境：开发模式走 Vite 代理，生产模式/Electron 直连
 */
async function searchDuckDuckGoHTML(
  query: string,
  maxResults: number
): Promise<Array<{ title: string; snippet: string; url: string }>> {
  // 开发模式走代理避免 CORS，生产模式/Electron 直连
  const isDev = window.location.hostname === 'localhost'
  const url = isDev
    ? `/ddg-proxy/html/?q=${encodeURIComponent(query)}`
    : `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    }
  })

  if (!response.ok) {
    throw new Error(`HTML 搜索请求失败: ${response.status} ${response.statusText}`)
  }

  const html = await response.text()
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')

  const results: Array<{ title: string; snippet: string; url: string }> = []

  // 解析搜索结果
  const resultElements = doc.querySelectorAll('.result')

  for (const el of resultElements) {
    if (results.length >= maxResults) break

    // 标题和链接
    const titleEl = el.querySelector('.result__a')
    if (!titleEl) continue

    const title = titleEl.textContent?.trim() || ''
    let href = titleEl.getAttribute('href') || ''

    // DuckDuckGo 的链接可能是重定向格式: //duckduckgo.com/l/?uddg=实际URL&...
    if (href.includes('uddg=')) {
      try {
        const uddgMatch = href.match(/uddg=([^&]+)/)
        if (uddgMatch) {
          href = decodeURIComponent(uddgMatch[1])
        }
      } catch {
        // 解析失败保留原始链接
      }
    }

    // 摘要
    const snippetEl = el.querySelector('.result__snippet')
    const snippet = snippetEl?.textContent?.trim() || ''

    if (title && snippet) {
      results.push({ title, snippet, url: href })
    }
  }

  return results
}

/**
 * DuckDuckGo Instant Answer API — 备用方案
 */
async function searchDuckDuckGoAPI(
  query: string,
  maxResults: number
): Promise<Array<{ title: string; snippet: string; url: string }>> {
  const response = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
  )

  if (!response.ok) {
    throw new Error(`API 请求失败: ${response.statusText}`)
  }

  const data = await response.json()
  const results: Array<{ title: string; snippet: string; url: string }> = []

  if (data.Abstract) {
    results.push({
      title: data.Heading || query,
      snippet: data.Abstract,
      url: data.AbstractURL || ''
    })
  }

  if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
    for (const topic of data.RelatedTopics.slice(0, maxResults)) {
      if (topic.Text) {
        results.push({
          title: topic.Text.split(' - ')[0] || '',
          snippet: topic.Text,
          url: topic.FirstURL || ''
        })
      }
    }
  }

  return results
}

/**
 * knowledge_query — 知识库检索
 * 初期实现：从 localStorage 中读取预存的知识条目，简单关键词匹配
 * 后续可替换为向量数据库 RAG
 */
export const knowledgeQueryHandler: ToolHandler = async (args) => {
  const { question, context } = args

  // 初期：从 localStorage 的知识库中检索
  const knowledgeBase = JSON.parse(localStorage.getItem('knowledge_base') || '[]')

  if (knowledgeBase.length === 0) {
    return {
      question,
      message: '知识库为空。请在设置中添加知识条目，或等待知识库功能完善。',
      results: []
    }
  }

  // 简单关键词匹配
  const keywords = question.toLowerCase().split(/\s+/)
  const scored = knowledgeBase.map((entry: any) => {
    const text = `${entry.title || ''} ${entry.content || ''}`.toLowerCase()
    const score = keywords.filter((kw: string) => text.includes(kw)).length
    return { ...entry, score }
  }).filter((e: any) => e.score > 0)
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, 3)

  return {
    question,
    context: context || '',
    result_count: scored.length,
    results: scored.map((e: any) => ({
      title: e.title,
      content: e.content,
      relevance: e.score
    }))
  }
}

/**
 * calculate — 数学表达式求值
 * 安全实现：仅允许数字和基本运算符
 */
export const calculateHandler: ToolHandler = async (args) => {
  const { expression } = args

  // 安全检查：只允许数字、运算符、括号、小数点、空格
  const safePattern = /^[\d\s+\-*/().,%^]+$/
  if (!safePattern.test(expression)) {
    throw new Error('表达式包含不安全的字符，仅支持数字和基本运算符')
  }

  try {
    // 替换 ^ 为 ** （幂运算）
    const normalized = expression.replace(/\^/g, '**')

    // 使用 Function 构造器安全求值（避免 eval）
    const fn = new Function(`"use strict"; return (${normalized})`)
    const result = fn()

    if (typeof result !== 'number' || !isFinite(result)) {
      throw new Error('计算结果无效（可能除以零或表达式错误）')
    }

    return {
      expression,
      result: Number(result.toFixed(10)), // 处理浮点精度
      formatted: result.toLocaleString('zh-CN')
    }
  } catch (error) {
    throw new Error(`计算失败: ${error instanceof Error ? error.message : '表达式语法错误'}`)
  }
}

/**
 * read_file — 读取本地文件
 * 通过 Electron IPC 调用主进程读取（安全沙箱）
 * 非 Electron 环境下使用 File API 模拟
 */
export const readFileHandler: ToolHandler = async (args) => {
  const { path: filePath } = args

  // 检查是否在 Electron 环境
  if (window.electronAPI?.readFile) {
    try {
      const result = await window.electronAPI.readFile(filePath)
      if (!result.success) {
        throw new Error(result.error || '文件读取失败')
      }
      const content = result.content!
      return {
        path: filePath,
        size: content.length,
        content: content.length > 10000 ? content.slice(0, 10000) + '\n... (文件过大，已截断)' : content
      }
    } catch (error) {
      throw new Error(`文件读取失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  // 非 Electron 环境：提示用户
  return {
    path: filePath,
    message: '当前为 Web 模式，无法直接读取本地文件。请使用 Electron 桌面版，或将文件内容粘贴到对话中。'
  }
}

/**
 * summarize_results — 汇总多个结果
 * 初期实现：结构化拼接，后续可调用 LLM 进行智能摘要
 */
export const summarizeResultsHandler: ToolHandler = async (args) => {
  const { results, focus } = args

  if (!Array.isArray(results) || results.length === 0) {
    return { summary: '无结果可汇总。' }
  }

  const sections = results.map((r: any, i: number) => {
    const source = r.source || `来源 ${i + 1}`
    const content = r.content || '(空)'
    return `## ${source}\n${content}`
  })

  const summary = [
    focus ? `# 汇总报告：${focus}` : '# 综合汇总报告',
    '',
    `共 ${results.length} 个信息来源`,
    '',
    ...sections
  ].join('\n\n')

  return {
    summary,
    source_count: results.length,
    focus: focus || '综合'
  }
}

/**
 * write_file — 写入本地文件
 * 通过 Electron IPC 调用主进程写入（安全沙箱）
 */
export const writeFileHandler: ToolHandler = async (args) => {
  const { path: filePath, content } = args

  if (window.electronAPI?.writeFile) {
    try {
      const result = await window.electronAPI.writeFile(filePath, content)
      if (!result.success) {
        throw new Error(result.error || '文件写入失败')
      }
      return {
        path: filePath,
        size: result.size,
        message: `文件已成功写入: ${filePath}（${result.size} 字节）`
      }
    } catch (error) {
      throw new Error(`文件写入失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  return {
    path: filePath,
    message: '当前为 Web 模式，无法写入本地文件。请使用 Electron 桌面版。'
  }
}

/**
 * create_directory — 创建目录
 * 通过 Electron IPC 调用主进程创建（安全沙箱）
 */
export const createDirectoryHandler: ToolHandler = async (args) => {
  const { path: dirPath } = args

  if (window.electronAPI?.createDirectory) {
    try {
      const result = await window.electronAPI.createDirectory(dirPath)
      if (!result.success) {
        throw new Error(result.error || '目录创建失败')
      }
      return {
        path: dirPath,
        message: `目录已创建: ${dirPath}`
      }
    } catch (error) {
      throw new Error(`目录创建失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  return {
    path: dirPath,
    message: '当前为 Web 模式，无法创建本地目录。请使用 Electron 桌面版。'
  }
}

/**
 * read_directory — 读取目录内容
 * 通过 Electron IPC 调用主进程读取（安全沙箱）
 */
export const readDirectoryHandler: ToolHandler = async (args) => {
  const { path: dirPath } = args

  if (window.electronAPI?.readDirectory) {
    try {
      const result = await window.electronAPI.readDirectory(dirPath)
      if (!result.success) {
        throw new Error(result.error || '目录读取失败')
      }
      return {
        path: dirPath,
        count: result.count,
        truncated: result.truncated,
        items: result.items
      }
    } catch (error) {
      throw new Error(`目录读取失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  return {
    path: dirPath,
    message: '当前为 Web 模式，无法读取本地目录。请使用 Electron 桌面版。'
  }
}

/**
 * read_document — 读取 Office 文档 / PDF
 * 通过 Electron IPC 调用主进程解析（安全沙箱）
 * 支持: doc, docx, pdf, xls, xlsx, pptx
 */
export const readDocumentHandler: ToolHandler = async (args) => {
  const { path: filePath } = args

  if (window.electronAPI?.readDocument) {
    try {
      const result = await window.electronAPI.readDocument(filePath)
      if (!result.success) {
        throw new Error(result.error || '文档读取失败')
      }
      return {
        path: filePath,
        size: result.content?.length || 0,
        metadata: result.metadata || {},
        content: result.content || ''
      }
    } catch (error) {
      throw new Error(`文档读取失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  return {
    path: filePath,
    message: '当前为 Web 模式，无法读取本地文档。请使用 Electron 桌面版。'
  }
}

/**
 * execute_command — 执行命令行命令
 * 通过 Electron IPC 调用主进程执行（安全沙箱）
 * Windows 默认 PowerShell，Linux/Mac 默认 bash
 */
export const executeCommandHandler: ToolHandler = async (args) => {
  const { command, cwd, timeout } = args

  if (window.electronAPI?.executeCommand) {
    try {
      const result = await window.electronAPI.executeCommand({ command, cwd, timeout })
      return {
        command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        success: result.success,
        timedOut: result.timedOut || false
      }
    } catch (error) {
      throw new Error(`命令执行失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  return {
    command,
    message: '当前为 Web 模式，无法执行命令行。请使用 Electron 桌面版。',
    success: false
  }
}

/**
 * search_code — 代码搜索
 * 通过 Electron IPC 调用主进程进行跨文件搜索
 */
export const searchCodeHandler: ToolHandler = async (args) => {
  const { pattern, directory, filePattern, maxResults, isRegex } = args

  if (window.electronAPI?.searchCode) {
    try {
      const result = await window.electronAPI.searchCode({
        pattern, directory, filePattern, maxResults, isRegex
      })
      if (!result.success) {
        throw new Error(result.error || '搜索失败')
      }
      return {
        pattern,
        directory,
        filesScanned: result.filesScanned,
        matchCount: result.matchCount,
        truncated: result.truncated,
        results: result.results
      }
    } catch (error) {
      throw new Error(`代码搜索失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  return {
    pattern,
    message: '当前为 Web 模式，无法搜索本地代码。请使用 Electron 桌面版。',
    results: []
  }
}

/**
 * git_operation — Git 操作
 * 将 git 操作转换为 execute_command 调用
 */
export const gitOperationHandler: ToolHandler = async (args) => {
  const { operation, args: gitArgs, cwd } = args

  // 将操作映射为具体的 git 命令
  const commandMap: Record<string, string> = {
    'status': 'git status --short',
    'diff': 'git diff',
    'diff-staged': 'git diff --staged',
    'log': 'git log --oneline -20',
    'branch': 'git branch',
    'branch-all': 'git branch -a',
    'remote': 'git remote -v',
    'stash-list': 'git stash list',
    'stash': 'git stash'
  }

  let command = commandMap[operation]
  if (!command) {
    // 处理带参数的操作
    if (operation === 'show' && gitArgs) {
      command = `git show ${gitArgs}`
    } else if (operation === 'add' && gitArgs) {
      command = `git add ${gitArgs}`
    } else if (operation === 'commit' && gitArgs) {
      // commit message 需要用引号包裹
      const msg = gitArgs.replace(/"/g, '\\"')
      command = `git commit -m "${msg}"`
    } else if (operation === 'log' && gitArgs) {
      command = `git log --oneline ${gitArgs}`
    } else {
      throw new Error(`不支持的 Git 操作: ${operation}`)
    }
  }

  if (window.electronAPI?.executeCommand) {
    try {
      const result = await window.electronAPI.executeCommand({ command, cwd, timeout: 30000 })
      return {
        operation,
        command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        success: result.success
      }
    } catch (error) {
      throw new Error(`Git 操作失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  return {
    operation,
    message: '当前为 Web 模式，无法执行 Git 操作。请使用 Electron 桌面版。',
    success: false
  }
}

/**
 * run_tests — 运行测试
 * 通过 Electron IPC 调用主进程运行测试
 */
export const runTestsHandler: ToolHandler = async (args) => {
  const { cwd, testCommand } = args

  if (window.electronAPI?.runTests) {
    try {
      const result = await window.electronAPI.runTests({ cwd, testCommand })
      return {
        command: result.command,
        success: result.success,
        exitCode: result.exitCode,
        summary: result.summary,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut || false
      }
    } catch (error) {
      throw new Error(`测试执行失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  return {
    message: '当前为 Web 模式，无法运行测试。请使用 Electron 桌面版。',
    success: false
  }
}

// ============ 记忆工具 ============

/**
 * save_memory — 保存记忆
 * Agent 主动存储重要信息，供未来会话使用
 */
export const saveMemoryTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'save_memory',
    description: '保存一条重要记忆，供未来会话使用。当你发现重要的项目知识、用户偏好、关键决策或经验规律时，使用此工具保存。',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: '记忆类型',
          enum: ['project', 'preference', 'fact', 'decision', 'pattern']
        },
        content: {
          type: 'string',
          description: '记忆内容，简洁明确，200字以内'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '标签列表，如 ["Vue", "架构", "性能"]'
        },
        importance: {
          type: 'integer',
          description: '重要程度 1-5，默认为 3'
        }
      },
      required: ['type', 'content']
    }
  }
}

export const saveMemoryHandler: ToolHandler = async (args) => {
  const { type, content, tags, importance } = args
  const memory = memoryStore.add({
    type: type || 'fact',
    content,
    tags: tags || [],
    importance: importance || 3
  })
  return {
    success: true,
    id: memory.id,
    message: `记忆已保存: ${content.slice(0, 50)}...`
  }
}

/**
 * search_memory — 搜索记忆
 * 查找过去保存的相关记忆
 */
export const searchMemoryTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'search_memory',
    description: '搜索已保存的记忆。输入关键词或标签，返回相关的历史记忆。适合查找项目知识、用户偏好、过去决策等。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词'
        },
        type: {
          type: 'string',
          description: '记忆类型筛选（可选）',
          enum: ['project', 'preference', 'fact', 'decision', 'pattern']
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '标签筛选（可选）'
        }
      },
      required: ['query']
    }
  }
}

export const searchMemoryHandler: ToolHandler = async (args) => {
  const { query, type, tags } = args

  let results = memoryStore.search(query)

  // 按类型筛选
  if (type) {
    results = results.filter(m => m.type === type)
  }

  // 按标签筛选
  if (tags && tags.length > 0) {
    const tagSet = new Set(tags.map((t: string) => t.toLowerCase()))
    results = results.filter(m => m.tags.some(t => tagSet.has(t.toLowerCase())))
  }

  // 按更新时间排序，取前 10 条
  results.sort((a, b) => b.updatedAt - a.updatedAt)
  const top = results.slice(0, 10)

  return {
    success: true,
    count: top.length,
    total: results.length,
    memories: top.map(m => ({
      id: m.id,
      type: m.type,
      content: m.content,
      tags: m.tags,
      importance: m.importance,
      createdAt: new Date(m.createdAt).toISOString()
    }))
  }
}

// ============ 角色专属工具（Sprint A - #4） ============

/**
 * fact_check — 事实核查（御史专属）
 * 验证某个说法的真伪，交叉验证多个信息源
 */
export const factCheckTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'fact_check',
    description: '事实核查。验证某个说法、数据或结论的真伪，交叉验证多个信息源，给出置信度评分。御史用于指出前序发言中的可疑之处。',
    parameters: {
      type: 'object',
      properties: {
        claim: {
          type: 'string',
          description: '需要核查的说法、声明或结论'
        },
        context: {
          type: 'string',
          description: '可选的上下文（谁提出的、什么场景下说的）'
        },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: '可选的参考来源（网址、文档名等）'
        }
      },
      required: ['claim']
    }
  }
}

/**
 * trace_source — 来源追溯（御史专属）
 * 查找某个说法的原始出处
 */
export const traceSourceTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'trace_source',
    description: '追溯某个说法、数据或引用的原始出处。查找信息从哪里来，是否可靠。',
    parameters: {
      type: 'object',
      properties: {
        statement: {
          type: 'string',
          description: '需要追溯来源的说法或数据'
        }
      },
      required: ['statement']
    }
  }
}

/**
 * generate_chart — 图表/数据可视化（户部专属，文本形态）
 * 用 ASCII/Markdown 表格、进度条、排行榜、预算分配表等方式呈现数据
 */
export const chartGeneratorTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'generate_chart',
    description: '将数据转化为可视化的文本图表。支持表格(table)、排行榜(ranking)、预算分配(budget)、进度条(progress)、对比矩阵(matrix) 五种格式。户部尚书用于呈现财务、成本、收益数据。',
    parameters: {
      type: 'object',
      properties: {
        chart_type: {
          type: 'string',
          enum: ['table', 'ranking', 'budget', 'progress', 'matrix'],
          description: '图表类型'
        },
        title: {
          type: 'string',
          description: '图表标题'
        },
        data: {
          type: 'array',
          description: '数据项列表，每项至少包含 label 和 value',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '标签' },
              value: { type: 'number', description: '数值' },
              note: { type: 'string', description: '可选备注' }
            }
          }
        },
        unit: {
          type: 'string',
          description: '单位（如 万元、%）'
        }
      },
      required: ['chart_type', 'data']
    }
  }
}

/**
 * history_search — 历史案例检索（太傅专属）
 * 从历史朝议记录中检索相关案例
 */
export const historySearchTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'history_search',
    description: '检索历史朝议记录，查找与当前议题相关的过去案例。太傅用于"引经据典"，参考过去的决策和经验。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索关键词或问题'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '可选的标签筛选'
        },
        limit: {
          type: 'integer',
          description: '返回数量，默认 5，最大 10'
        }
      },
      required: ['query']
    }
  }
}

/**
 * fact_check 处理器
 * 本地规则 + 网络搜索交叉验证，输出 verdict(判定) + confidence(置信度 0-100) + evidence
 */
export const factCheckHandler: ToolHandler = async (args) => {
  const { claim, context, sources } = args

  // 1. 本地规则：识别明显的夸大、绝对词、数据可疑信号
  const signals: string[] = []
  const absoluteWords = /\b(总是|从不|所有|全部|永远|绝对|必然|100%|always|never|all|none|every|must)\b/i
  if (absoluteWords.test(claim)) signals.push('包含绝对化用词，可能过度概括')
  if (/\d+%/.test(claim) && !/来源|根据|统计/.test(claim)) signals.push('包含百分比但无来源')
  if (/\d{4}\s*年/.test(claim) && /预计|将会|必然/.test(claim)) signals.push('对未来做确定性表述')

  // 2. 调用 web_search 搜索佐证
  let webEvidence: Array<{ title: string; snippet: string; url: string }> = []
  try {
    const searchResult = await webSearchHandler({ query: claim, max_results: 3 })
    webEvidence = (searchResult as any).results || []
  } catch { /* 搜索失败不影响主流程 */ }

  // 3. 判定置信度
  let confidence = 50
  if (signals.length === 0 && webEvidence.length >= 2) confidence = 78
  else if (signals.length === 0) confidence = 60
  else if (webEvidence.length >= 2) confidence = 55
  else confidence = 35

  let verdict: '可信' | '部分可信' | '存疑' | '无法验证' = '部分可信'
  if (confidence >= 75) verdict = '可信'
  else if (confidence >= 55) verdict = '部分可信'
  else if (confidence >= 40) verdict = '存疑'
  else verdict = '无法验证'

  return {
    claim,
    context: context || '',
    verdict,
    confidence,
    signals,
    evidence: webEvidence.map(e => ({
      title: e.title,
      snippet: e.snippet,
      url: e.url
    })),
    referenced_sources: sources || [],
    suggestion: signals.length > 0
      ? '建议要求原说法者补充来源或弱化绝对化表述'
      : (webEvidence.length > 0 ? '已找到佐证材料，可作为参考' : '未找到明确佐证，建议进一步核实')
  }
}

/**
 * trace_source 处理器
 * 对声明做网络搜索，返回最相关的源头
 */
export const traceSourceHandler: ToolHandler = async (args) => {
  const { statement } = args
  try {
    const searchResult = await webSearchHandler({ query: statement, max_results: 5 })
    const results = (searchResult as any).results || []
    return {
      statement,
      source_count: results.length,
      possible_origins: results.map((r: any) => ({
        title: r.title,
        snippet: r.snippet,
        url: r.url
      })),
      reliability_hint: results.length >= 3
        ? '找到多处相关来源，建议对比权威媒体与官方出处'
        : '来源较少，建议通过官方渠道进一步确认'
    }
  } catch (err) {
    return {
      statement,
      source_count: 0,
      possible_origins: [],
      reliability_hint: '搜索失败，请手动核实'
    }
  }
}

/**
 * generate_chart 处理器
 * 纯文本图表渲染，便于在 Markdown 气泡中直接展示
 */
export const chartGeneratorHandler: ToolHandler = async (args) => {
  const { chart_type, title, data, unit } = args
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('data 不能为空')
  }
  const items = data.map((d: any) => ({
    label: String(d.label || ''),
    value: Number(d.value) || 0,
    note: d.note || ''
  }))
  const unitLabel = unit ? ` (${unit})` : ''
  const lines: string[] = []
  if (title) lines.push(`### ${title}`)

  const maxVal = Math.max(...items.map(i => Math.abs(i.value)), 1)

  switch (chart_type) {
    case 'table': {
      lines.push(`| 项目 | 数值${unitLabel} | 备注 |`)
      lines.push('| --- | ---: | --- |')
      for (const it of items) lines.push(`| ${it.label} | ${it.value.toLocaleString('zh-CN')} | ${it.note} |`)
      break
    }
    case 'ranking': {
      const sorted = [...items].sort((a, b) => b.value - a.value)
      sorted.forEach((it, i) => {
        lines.push(`${i + 1}. **${it.label}** — ${it.value.toLocaleString('zh-CN')}${unitLabel}`)
      })
      break
    }
    case 'budget': {
      const total = items.reduce((s, it) => s + Math.abs(it.value), 0) || 1
      for (const it of items) {
        const pct = Math.round((Math.abs(it.value) / total) * 100)
        const bar = '█'.repeat(Math.max(1, Math.round(pct / 5)))
        lines.push(`- ${it.label.padEnd(12, ' ')} ${bar} ${pct}%  (${it.value.toLocaleString('zh-CN')}${unitLabel})`)
      }
      lines.push(`\n合计：${total.toLocaleString('zh-CN')}${unitLabel}`)
      break
    }
    case 'progress': {
      for (const it of items) {
        const pct = Math.min(100, Math.max(0, (it.value / maxVal) * 100))
        const filled = Math.round(pct / 5)
        const bar = '▓'.repeat(filled) + '░'.repeat(20 - filled)
        lines.push(`${it.label.padEnd(12, ' ')} [${bar}] ${pct.toFixed(0)}%`)
      }
      break
    }
    case 'matrix': {
      lines.push(`| 维度 | 数值${unitLabel} | 条形 |`)
      lines.push('| --- | ---: | --- |')
      for (const it of items) {
        const barLen = Math.round((Math.abs(it.value) / maxVal) * 15)
        lines.push(`| ${it.label} | ${it.value.toLocaleString('zh-CN')} | ${'■'.repeat(barLen)} |`)
      }
      break
    }
    default:
      throw new Error(`不支持的 chart_type: ${chart_type}`)
  }

  return {
    chart_type,
    title: title || '',
    markdown: lines.join('\n'),
    item_count: items.length
  }
}

/**
 * history_search 处理器
 * 从 localStorage debates_history 中检索历史朝议
 */
export const historySearchHandler: ToolHandler = async (args) => {
  const { query, tags, limit = 5 } = args
  const cap = Math.min(Number(limit) || 5, 10)

  let debates: any[] = []
  try {
    const raw = localStorage.getItem('debates_history')
    debates = raw ? JSON.parse(raw) : []
  } catch {
    debates = []
  }

  if (!Array.isArray(debates) || debates.length === 0) {
    return { query, message: '历史朝议记录为空', results: [] }
  }

  const keywords = String(query).toLowerCase().split(/\s+/).filter(Boolean)
  const tagSet = Array.isArray(tags) ? new Set(tags.map((t: string) => String(t).toLowerCase())) : null

  const scored = debates
    .filter((d: any) => d.status === 'completed')
    .map((d: any) => {
      const speeches = Array.isArray(d.speeches) ? d.speeches : []
      const fullText = [
        d.topic || '',
        d.imperialDecree || '',
        ...speeches.map((s: any) => s.content || '')
      ].join(' ').toLowerCase()
      const score = keywords.filter(k => fullText.includes(k)).length
      const debateTags: string[] = Array.isArray(d.tags) ? d.tags : []
      const tagMatch = tagSet ? debateTags.some((t: string) => tagSet.has(t.toLowerCase())) : true
      return { debate: d, score, tagMatch }
    })
    .filter(x => x.score > 0 && x.tagMatch)
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)

  return {
    query,
    total_matches: scored.length,
    results: scored.map(({ debate }) => ({
      id: debate.id,
      topic: debate.topic,
      createdAt: debate.createdAt,
      createdAtLabel: new Date(debate.createdAt).toLocaleString('zh-CN'),
      tags: debate.tags || [],
      imperialDecree: debate.imperialDecree || '',
      speeches_count: (debate.speeches || []).length,
      snippet: (debate.imperialDecree || debate.topic || '').slice(0, 150)
    }))
  }
}

// ============ 代码质量工具（Sprint B - #11） ============

/**
 * lint_check — 代码质量检查（ESLint / Pylint 等）
 * 在项目目录中运行 lint 工具，返回问题列表
 */
export const lintCheckTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'lint_check',
    description: '运行代码质量检查（ESLint/Pylint/ShellCheck 等），返回项目中的代码问题列表。支持自动检测框架，也可指定命令。大将军/丞相用于代码审查。',
    parameters: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: '项目目录路径'
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '要检查的文件列表（可选，不填则检查整个项目）'
        },
        command: {
          type: 'string',
          description: '自定义 lint 命令（可选，不填则自动检测：npx eslint / pylint 等）'
        },
        fix: {
          type: 'boolean',
          description: '是否自动修复可修复的问题，默认 false',
          default: false
        }
      },
      required: ['cwd']
    }
  }
}

/**
 * type_check — 类型检查（TypeScript / MyPy 等）
 * 检查项目中的类型错误
 */
export const typeCheckTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'type_check',
    description: '运行类型检查（tsc --noEmit / mypy / cargo check 等），返回类型错误列表。自动检测项目语言和框架。大将军用于确保代码重构后类型安全。',
    parameters: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: '项目目录路径'
        },
        command: {
          type: 'string',
          description: '自定义类型检查命令（可选，不填则自动检测）'
        }
      },
      required: ['cwd']
    }
  }
}

/**
 * refactor_rename — 跨文件重命名
 * 在项目中搜索并替换标识符名称
 */
export const refactorRenameTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'refactor_rename',
    description: '跨文件重命名标识符（变量名、函数名、类名等）。在项目中搜索所有引用并统一替换。大将军用于代码重构。',
    parameters: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: '项目目录路径'
        },
        oldName: {
          type: 'string',
          description: '旧名称（要替换的标识符）'
        },
        newName: {
          type: 'string',
          description: '新名称（替换后的标识符）'
        },
        filePattern: {
          type: 'string',
          description: '文件扩展名过滤，如 "*.ts" 或 "ts,vue"（可选，不填则搜索所有代码文件）'
        },
        dryRun: {
          type: 'boolean',
          description: '预览模式，只返回会被修改的文件和行，不实际写入，默认 true',
          default: true
        }
      },
      required: ['cwd', 'oldName', 'newName']
    }
  }
}

/**
 * lint_check 处理器
 * 自动检测 lint 框架并运行
 */
export const lintCheckHandler: ToolHandler = async (args) => {
  const { cwd, files, command, fix = false } = args

  if (!window.electronAPI?.executeCommand) {
    return { message: '当前为 Web 模式，无法运行 lint 检查。请使用 Electron 桌面版。', success: false }
  }

  // 自动检测 lint 命令
  let lintCmd = command
  if (!lintCmd) {
    // 检查 package.json 中是否有 eslint
    try {
      const pkgResult = await window.electronAPI.readFile(`${cwd}/package.json`)
      if (pkgResult.success && pkgResult.content) {
        const pkg = JSON.parse(pkgResult.content)
        const deps = { ...pkg.dependencies, ...pkg.devDependencies }
        if (deps.eslint || deps['@typescript-eslint/parser']) {
          const fixFlag = fix ? ' --fix' : ''
          const fileList = Array.isArray(files) && files.length > 0
            ? files.map((f: string) => `"${f}"`).join(' ')
            : '.'
          lintCmd = `npx eslint ${fileList}${fixFlag} --format json 2>&1`
        }
      }
    } catch { /* 检测失败，尝试通用命令 */ }

    // 检查 Python 项目
    if (!lintCmd) {
      try {
        const dirResult = await window.electronAPI.readDirectory(cwd)
        if (dirResult.success && dirResult.items) {
          const hasPython = dirResult.items.some(i => i.name.endsWith('.py'))
          const hasRuff = dirResult.items.some(i => i.name === 'ruff.toml' || i.name === 'pyproject.toml')
          if (hasRuff) {
            lintCmd = fix ? `ruff check --fix ${cwd}` : `ruff check ${cwd} --output-format=json`
          } else if (hasPython) {
            lintCmd = `python -m pylint ${cwd} --output-format=json 2>&1`
          }
        }
      } catch { /* 跳过 */ }
    }

    if (!lintCmd) {
      return { success: false, message: '未检测到 lint 框架（eslint/pylint/ruff），请手动指定 command 参数。' }
    }
  }

  try {
    const result = await window.electronAPI.executeCommand({ command: lintCmd, cwd, timeout: 60000 })
    // 尝试解析 JSON 输出
    let issues: any[] = []
    try {
      issues = JSON.parse(result.stdout || '[]')
    } catch {
      // 非 JSON 输出，返回原始文本
      return {
        command: lintCmd,
        success: result.success,
        exitCode: result.exitCode,
        output: result.stdout || result.stderr,
        issue_count: (result.stdout?.match(/\b(error|warning|warn)\b/gi) || []).length,
        fix_applied: fix
      }
    }
    return {
      command: lintCmd,
      success: true,
      issue_count: Array.isArray(issues) ? issues.length : 0,
      issues: Array.isArray(issues) ? issues.slice(0, 50) : issues,
      fix_applied: fix
    }
  } catch (error) {
    throw new Error(`Lint 检查失败: ${error instanceof Error ? error.message : '未知错误'}`)
  }
}

/**
 * type_check 处理器
 * 自动检测类型检查框架并运行
 */
export const typeCheckHandler: ToolHandler = async (args) => {
  const { cwd, command } = args

  if (!window.electronAPI?.executeCommand) {
    return { message: '当前为 Web 模式，无法运行类型检查。请使用 Electron 桌面版。', success: false }
  }

  let checkCmd = command
  if (!checkCmd) {
    // 检测项目类型
    try {
      const dirResult = await window.electronAPI.readDirectory(cwd)
      if (dirResult.success && dirResult.items) {
        const names = new Set(dirResult.items.map(i => i.name))

        // TypeScript 项目
        if (names.has('tsconfig.json') || names.has('tsconfig.node.json')) {
          checkCmd = 'npx tsc --noEmit 2>&1'
        }
        // Rust 项目
        else if (names.has('Cargo.toml')) {
          checkCmd = 'cargo check 2>&1'
        }
        // Go 项目
        else if (names.has('go.mod')) {
          checkCmd = 'go vet ./... 2>&1'
        }
        // Python + mypy
        else if (names.has('mypy.ini') || names.has('.mypy.ini') || names.has('pyproject.toml')) {
          checkCmd = `python -m mypy ${cwd} 2>&1`
        }
      }
    } catch { /* 检测失败 */ }

    if (!checkCmd) {
      return { success: false, message: '未检测到类型检查框架（tsc/mypy/cargo/go），请手动指定 command 参数。' }
    }
  }

  try {
    const result = await window.electronAPI.executeCommand({ command: checkCmd, cwd, timeout: 120000 })
    const output = result.stdout || result.stderr || ''

    // 统计错误数
    const errorMatches = output.match(/error\b/gi) || []
    const warningMatches = output.match(/warning\b/gi) || []

    return {
      command: checkCmd,
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      error_count: errorMatches.length,
      warning_count: warningMatches.length,
      output: output.length > 5000 ? output.slice(0, 5000) + '\n...(输出过长已截断)' : output
    }
  } catch (error) {
    throw new Error(`类型检查失败: ${error instanceof Error ? error.message : '未知错误'}`)
  }
}

/**
 * refactor_rename 处理器
 * 使用 search_code + read_file + write_file 实现跨文件重命名
 */
export const refactorRenameHandler: ToolHandler = async (args) => {
  const { cwd, oldName, newName, filePattern, dryRun = true } = args

  if (!oldName || !newName) {
    throw new Error('oldName 和 newName 不能为空')
  }
  if (oldName === newName) {
    return { success: true, message: '新旧名称相同，无需操作', changes: [] }
  }

  // 搜索所有引用
  let searchResults: Array<{ file: string; line: number; content: string }> = []
  if (window.electronAPI?.searchCode) {
    const result = await window.electronAPI.searchCode({
      pattern: oldName,
      directory: cwd,
      filePattern,
      maxResults: 200,
      isRegex: false
    })
    if (result.success) {
      searchResults = result.results || []
    }
  }

  if (searchResults.length === 0) {
    return { success: true, message: `未找到 "${oldName}" 的任何引用`, changes: [] }
  }

  // 按文件分组
  const fileMap = new Map<string, Array<{ line: number; content: string }>>()
  for (const r of searchResults) {
    if (!fileMap.has(r.file)) fileMap.set(r.file, [])
    fileMap.get(r.file)!.push({ line: r.line, content: r.content })
  }

  const changes = Array.from(fileMap.entries()).map(([file, refs]) => ({
    file,
    match_count: refs.length,
    lines: refs.map(r => ({ line: r.line, content: r.content.trim() }))
  }))

  if (!dryRun && window.electronAPI?.readFile && window.electronAPI?.writeFile) {
    // 实际执行替换
    let filesModified = 0
    for (const [file] of fileMap) {
      try {
        const readResult = await window.electronAPI.readFile(file)
        if (!readResult.success || !readResult.content) continue

        // 全词替换（避免部分匹配）
        const regex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
        const newContent = readResult.content.replace(regex, newName)

        if (newContent !== readResult.content) {
          const writeResult = await window.electronAPI.writeFile(file, newContent)
          if (writeResult.success) filesModified++
        }
      } catch { /* 单文件失败不影响其他文件 */ }
    }
    return {
      success: true,
      dryRun: false,
      files_matched: changes.length,
      files_modified: filesModified,
      total_references: searchResults.length,
      changes
    }
  }

  // 预览模式
  return {
    success: true,
    dryRun: true,
    message: `预览模式：找到 ${searchResults.length} 处引用，分布在 ${changes.length} 个文件中。设置 dryRun=false 执行实际替换。`,
    files_matched: changes.length,
    total_references: searchResults.length,
    changes
  }
}

/**
 * 所有工具的映射（供注册使用）
 */
export const MINIMAL_TOOL_HANDLERS: Record<string, ToolHandler> = {
  web_search: webSearchHandler,
  knowledge_query: knowledgeQueryHandler,
  calculate: calculateHandler,
  read_file: readFileHandler,
  write_file: writeFileHandler,
  create_directory: createDirectoryHandler,
  read_directory: readDirectoryHandler,
  read_document: readDocumentHandler,
  execute_command: executeCommandHandler,
  search_code: searchCodeHandler,
  git_operation: gitOperationHandler,
  run_tests: runTestsHandler,
  save_memory: saveMemoryHandler,
  search_memory: searchMemoryHandler,
  summarize_results: summarizeResultsHandler,
  fact_check: factCheckHandler,
  trace_source: traceSourceHandler,
  generate_chart: chartGeneratorHandler,
  history_search: historySearchHandler,
  lint_check: lintCheckHandler,
  type_check: typeCheckHandler,
  refactor_rename: refactorRenameHandler
}

export const MINIMAL_TOOL_DEFINITIONS: ToolDefinition[] = [
  webSearchTool,
  knowledgeQueryTool,
  calculateTool,
  readFileTool,
  writeFileTool,
  createDirectoryTool,
  readDirectoryTool,
  readDocumentTool,
  executeCommandTool,
  searchCodeTool,
  gitOperationTool,
  runTestsTool,
  saveMemoryTool,
  searchMemoryTool,
  summarizeResultsTool,
  factCheckTool,
  traceSourceTool,
  chartGeneratorTool,
  historySearchTool,
  lintCheckTool,
  typeCheckTool,
  refactorRenameTool
]
