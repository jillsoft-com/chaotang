/**
 * 仓库级自动上下文 — 项目索引 + 关键词检索 + 语义检索 + 上下文注入
 *
 * 当 session 设置了 workingDirectory 时：
 * 1. 自动扫描项目结构，构建文件索引
 * 2. 提供关键词检索（TF-IDF 评分）
 * 3. 提供语义检索（VectorIndex，支持 TF-IDF 降级和嵌入 API）
 * 4. 在 minister 发言前自动注入相关上下文摘要
 *
 * Sprint B - #8 / Phase 5 语义增强
 */

import { VectorIndex, createTfIdfIndex } from './vector-index'
import type { VectorDocument, VectorSearchResult } from './vector-index'
import { extractSymbols, extractReferences, SymbolIndex } from './symbol-index'
import type { SymbolInfo, ReferenceInfo } from './symbol-index'
import { extractDependencies, buildModuleGraph } from './module-graph'
import type { ModuleGraph, ModuleDependency } from './module-graph'

// ============ 类型 ============

export interface FileEntry {
  /** 相对路径（相对于项目根） */
  path: string
  /** 文件名 */
  name: string
  /** 扩展名 */
  ext: string
  /** 文件大小（字节） */
  size: number
  /** 最后修改时间 */
  modified: number
  /** 文件类型分类 */
  category: 'source' | 'config' | 'doc' | 'test' | 'asset' | 'other'
}

export interface TextChunk {
  /** 所属文件路径 */
  filePath: string
  /** 块内容 */
  content: string
  /** 起始行号 */
  startLine: number
  /** 结束行号 */
  endLine: number
}

export interface SearchResult {
  filePath: string
  content: string
  score: number
  startLine: number
  endLine: number
}

export interface ProjectIndex {
  /** 项目根目录 */
  rootDir: string
  /** 文件列表 */
  files: FileEntry[]
  /** 文本块（用于检索） */
  chunks: TextChunk[]
  /** 索引构建时间 */
  builtAt: number
  /** 项目结构摘要（目录树） */
  treeSummary: string
  /** 关键文件摘要（package.json / README 等） */
  keyFileSummaries: Record<string, string>
  /** 三期 Phase C: 符号索引 */
  symbolIndex?: SymbolIndex
  /** 三期 Phase C: 引用关系 */
  references?: ReferenceInfo[]
  /** 三期 Phase D: 模块依赖图 */
  moduleGraph?: ModuleGraph
}

// ============ 配置 ============

/** 最大索引文件数 */
const MAX_FILES = 5000

/** 最大单文件字符数（超过则截断） */
const MAX_FILE_CHARS = 50000

/** 文本块大小（行） */
const CHUNK_SIZE = 50

/** 块重叠行数 */
const CHUNK_OVERLAP = 10

/** 跳过的目录 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  '__pycache__', '.cache', 'coverage', '.idea', '.vscode',
  'vendor', 'target', '.output'
])

/** 跳过的文件扩展名 */
const SKIP_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp',
  '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4',
  '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.pptx',
  '.lock', '.map'
])

/** 代码类扩展名 */
const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.vue', '.py', '.java', '.kt',
  '.go', '.rs', '.c', '.cpp', '.h', '.hpp', '.cs', '.rb',
  '.php', '.swift', '.dart', '.scala', '.lua', '.sh', '.bash',
  '.css', '.scss', '.less', '.html', '.xml', '.yaml', '.yml'
])

/** 文档类扩展名 */
const DOC_EXTS = new Set(['.md', '.txt', '.rst', '.adoc'])

/** 配置类文件名模式 */
const CONFIG_PATTERNS = [
  /^package\.json$/, /^tsconfig/, /^vite\.config/, /^webpack/,
  /^\.env/, /^Dockerfile/, /^docker-compose/, /^Makefile/,
  /^Cargo\.toml$/, /^go\.mod$/, /^requirements\.txt$/,
  /^pyproject\.toml$/, /\.eslintrc/, /\.prettierrc/
]

// ============ 索引构建 ============

/**
 * 扫描项目目录并构建索引
 * 通过 Electron IPC 读取文件系统
 */
export async function buildProjectIndex(rootDir: string): Promise<ProjectIndex> {
  const files: FileEntry[] = []
  const chunks: TextChunk[] = []
  const keyFileSummaries: Record<string, string> = {}

  // 递归扫描目录
  await scanDirectory(rootDir, rootDir, files, 0)

  // 读取关键文件内容并分块
  const importantFiles = files.filter(f =>
    f.category === 'source' || f.category === 'config' || f.category === 'doc'
  ).slice(0, 500) // 最多处理 500 个文件

  const symbolIndex = new SymbolIndex()
  const allReferences: ReferenceInfo[] = []
  const allDependencies: ModuleDependency[] = []

  for (const file of importantFiles) {
    const absPath = `${rootDir}/${file.path}`
    try {
      if (window.electronAPI?.readFile) {
        const result = await window.electronAPI.readFile(absPath)
        if (result.success && result.content) {
          const content = result.content.slice(0, MAX_FILE_CHARS)

          // 分块
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i += (CHUNK_SIZE - CHUNK_OVERLAP)) {
            const startLine = i + 1
            const endLine = Math.min(i + CHUNK_SIZE, lines.length)
            const chunkContent = lines.slice(i, endLine).join('\n')
            if (chunkContent.trim().length > 0) {
              chunks.push({
                filePath: file.path,
                content: chunkContent,
                startLine,
                endLine
              })
            }
            if (endLine >= lines.length) break
          }

          // Phase C: 符号提取（仅源码文件）
          if (file.category === 'source' && ['.ts', '.tsx', '.js', '.jsx', '.vue', '.py', '.go'].includes(file.ext)) {
            const symbols = extractSymbols(content, file.path, file.ext)
            symbolIndex.addSymbols(symbols)
          }

          // Phase D: 模块依赖提取（仅 TS/JS 源码）
          if (file.category === 'source' && ['.ts', '.tsx', '.js', '.jsx'].includes(file.ext)) {
            const deps = extractDependencies(content, file.path)
            allDependencies.push(...deps)
          }

          // 关键文件摘要（取前 500 字符）
          if (isKeyFile(file.name)) {
            keyFileSummaries[file.path] = content.slice(0, 500)
          }
        }
      }
    } catch { /* 读取失败跳过 */ }
  }

  // Phase C: 提取引用关系（需要已知符号列表）
  const allSymbols = symbolIndex.getAllSymbols()
  for (const file of importantFiles.filter(f => f.category === 'source')) {
    const absPath = `${rootDir}/${file.path}`
    try {
      if (window.electronAPI?.readFile) {
        const result = await window.electronAPI.readFile(absPath)
        if (result.success && result.content) {
          const content = result.content.slice(0, MAX_FILE_CHARS)
          const refs = extractReferences(content, file.path, allSymbols)
          allReferences.push(...refs)
        }
      }
    } catch { /* 读取失败跳过 */ }
  }
  symbolIndex.addReferences(allReferences)

  // Phase D: 构建模块依赖图
  const moduleGraph = allDependencies.length > 0 ? buildModuleGraph(allDependencies) : undefined

  // 构建目录树摘要
  const treeSummary = buildTreeSummary(rootDir, files)

  return {
    rootDir,
    files,
    chunks,
    builtAt: Date.now(),
    treeSummary,
    keyFileSummaries,
    symbolIndex,
    references: allReferences,
    moduleGraph
  }
}

/**
 * 递归扫描目录
 */
async function scanDirectory(
  dirPath: string,
  rootDir: string,
  files: FileEntry[],
  depth: number
): Promise<void> {
  if (files.length >= MAX_FILES) return
  if (depth > 10) return

  if (!window.electronAPI?.readDirectory) return

  try {
    const result = await window.electronAPI.readDirectory(dirPath)
    if (!result.success || !result.items) return

    for (const item of result.items) {
      if (files.length >= MAX_FILES) return

      const relPath = dirPath === rootDir
        ? item.name
        : `${dirPath.slice(rootDir.length + 1)}/${item.name}`

      if (item.type === 'directory') {
        if (SKIP_DIRS.has(item.name) || item.name.startsWith('.')) continue
        await scanDirectory(`${dirPath}/${item.name}`, rootDir, files, depth + 1)
      } else {
        const ext = getExtension(item.name)
        if (SKIP_EXTS.has(ext)) continue
        if (item.size > 500000) continue // 跳过 >500KB 的文件

        files.push({
          path: relPath,
          name: item.name,
          ext,
          size: item.size,
          modified: item.modified ? new Date(item.modified).getTime() : 0,
          category: classifyFile(item.name, ext)
        })
      }
    }
  } catch { /* 目录读取失败跳过 */ }
}

// ============ 检索 ============

/**
 * 在项目索引中搜索相关内容
 * 使用关键词 TF-IDF 评分，返回最相关的文本块
 */
export function searchProjectIndex(
  index: ProjectIndex,
  query: string,
  maxResults: number = 10
): SearchResult[] {
  const keywords = query.toLowerCase()
    .split(/[\s,;，；、]+/)
    .filter(k => k.length >= 2)

  if (keywords.length === 0) return []

  // 对每个 chunk 计算相关性评分
  const scored = index.chunks.map(chunk => {
    const text = chunk.content.toLowerCase()
    let score = 0

    for (const kw of keywords) {
      // 精确匹配加分
      const matches = countOccurrences(text, kw)
      score += matches * 2

      // 文件名匹配额外加分
      if (chunk.filePath.toLowerCase().includes(kw)) {
        score += 5
      }
    }

    // 路径深度惩罚（越深越低优先级）
    const depth = (chunk.filePath.match(/\//g) || []).length
    score -= depth * 0.5

    return {
      filePath: chunk.filePath,
      content: chunk.content,
      score,
      startLine: chunk.startLine,
      endLine: chunk.endLine
    }
  })

  return scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
}

/**
 * 生成上下文摘要（注入到 system prompt）
 * 根据用户议题自动检索相关代码和文档
 */
export function generateContextHint(
  index: ProjectIndex,
  topic: string,
  maxChars: number = 3000
): string {
  const parts: string[] = []

  // 0. 索引元数据（P1-A 4.4）
  const totalFiles = index.files.length
  const indexedFiles = index.chunks.length > 0
    ? new Set(index.chunks.map(c => c.filePath)).size
    : 0
  const builtAt = new Date(index.builtAt).toLocaleString('zh-CN')
  parts.push(`=== 索引信息 ===\n文件数: ${totalFiles} | 已索引: ${indexedFiles} | 构建时间: ${builtAt}`)

  // 1. 项目结构
  parts.push(`=== 项目结构 ===\n${index.treeSummary}`)

  // 2. 关键文件
  const keyEntries = Object.entries(index.keyFileSummaries)
  if (keyEntries.length > 0) {
    const keySection = keyEntries
      .map(([path, summary]) => `--- ${path} ---\n${summary}`)
      .join('\n\n')
    parts.push(`=== 关键文件 ===\n${keySection}`)
  }

  // 3. 相关代码片段
  const results = searchProjectIndex(index, topic, 5)
  if (results.length > 0) {
    const codeSection = results
      .map(r => `--- ${r.filePath} (L${r.startLine}-${r.endLine}, 相关性: ${r.score.toFixed(1)}) ---\n${r.content.slice(0, 800)}`)
      .join('\n\n')
    parts.push(`=== 与议题相关的代码 ===\n${codeSection}`)
  }

  // 拼接并截断
  const full = parts.join('\n\n')
  return full.length > maxChars ? full.slice(0, maxChars) + '\n...(已截断)' : full
}

// ============ 语义检索 ============

/** 内存中的语义索引缓存（rootDir → VectorIndex） */
const semanticIndexCache = new Map<string, { index: VectorIndex; expiresAt: number }>()

/**
 * 构建语义索引（从 ProjectIndex 的 chunks 构建 VectorIndex）
 */
async function buildSemanticIndex(projectIndex: ProjectIndex): Promise<VectorIndex> {
  const vectorIndex = createTfIdfIndex()

  const docs: VectorDocument[] = projectIndex.chunks.map((chunk) => ({
    id: `${chunk.filePath}:${chunk.startLine}`,
    text: chunk.content,
    metadata: {
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine
    }
  }))

  await vectorIndex.addAll(docs)
  return vectorIndex
}

/**
 * 语义搜索 — 使用 VectorIndex 检索最相关的代码块
 *
 * 如果配置了嵌入 API 则使用真实向量检索，否则降级为 TF-IDF。
 * 结果按相关性排序，可直接注入提示词。
 */
export async function semanticSearch(
  index: ProjectIndex,
  query: string,
  topK: number = 10
): Promise<VectorSearchResult[]> {
  const cached = semanticIndexCache.get(index.rootDir)
  let vectorIndex: VectorIndex

  if (cached && cached.expiresAt > Date.now()) {
    vectorIndex = cached.index
  } else {
    vectorIndex = await buildSemanticIndex(index)
    semanticIndexCache.set(index.rootDir, { index: vectorIndex, expiresAt: Date.now() + CACHE_TTL })
  }

  return vectorIndex.search(query, topK)
}

/**
 * 清除语义索引缓存
 */
export function clearSemanticIndexCache(rootDir?: string): void {
  if (rootDir) {
    semanticIndexCache.delete(rootDir)
  } else {
    semanticIndexCache.clear()
  }
}

// ============ Phase C: 符号搜索 ============

/**
 * 符号搜索 — 查找符号定义和引用
 * 返回符号定义位置 + 引用位置，供 Agent 理解代码结构
 */
export function symbolSearch(
  index: ProjectIndex,
  query: string,
  mode: 'definition' | 'references' | 'callers' = 'definition',
  maxResults: number = 20
): Array<{ symbol: SymbolInfo; references?: ReferenceInfo[] }> {
  if (!index.symbolIndex) return []

  const symbols = index.symbolIndex.lookupSymbol(query)
  if (symbols.length === 0) {
    // 模糊匹配：名称包含查询字符串
    const allSymbols = index.symbolIndex.getAllSymbols()
    const fuzzyMatches = allSymbols
      .filter(s => s.name.toLowerCase().includes(query.toLowerCase()))
      .slice(0, maxResults)
    
    return fuzzyMatches.map(s => ({
      symbol: s,
      references: mode !== 'definition' ? index.symbolIndex!.findReferences(s.name) : undefined
    }))
  }

  return symbols.slice(0, maxResults).map(s => {
    const result: { symbol: SymbolInfo; references?: ReferenceInfo[] } = { symbol: s }
    if (mode === 'references' || mode === 'callers') {
      result.references = index.symbolIndex!.findReferences(s.name)
      if (mode === 'callers') {
        result.references = result.references.filter(r => r.kind === 'call')
      }
    }
    return result
  })
}

// ============ 缓存 ============

/** 内存中的索引缓存（rootDir → index） */
const indexCache = new Map<string, { index: ProjectIndex; expiresAt: number }>()

/** 缓存有效期（10 分钟） */
const CACHE_TTL = 10 * 60 * 1000

/**
 * 获取项目索引（带缓存）
 * 如果缓存未过期直接返回，否则重新构建
 */
export async function getProjectIndex(rootDir: string, forceRebuild = false): Promise<ProjectIndex> {
  const cached = indexCache.get(rootDir)
  if (!forceRebuild && cached && cached.expiresAt > Date.now()) {
    return cached.index
  }

  const index = await buildProjectIndex(rootDir)
  indexCache.set(rootDir, { index, expiresAt: Date.now() + CACHE_TTL })
  return index
}

/**
 * 清除索引缓存
 */
export function clearIndexCache(rootDir?: string): void {
  if (rootDir) {
    indexCache.delete(rootDir)
  } else {
    indexCache.clear()
  }
}

/**
 * 写操作后失效索引缓存（P1-A）
 * 当 write_file / search_replace / create_directory / git_operation 成功后调用，
 * 确保下次读取索引时会重新构建。
 */
export function invalidateIndexOnWrite(rootDir: string): void {
  clearIndexCache(rootDir)
  clearSemanticIndexCache(rootDir)
}

// ============ 工具函数 ============

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot >= 0 ? filename.slice(dot).toLowerCase() : ''
}

function classifyFile(name: string, ext: string): FileEntry['category'] {
  if (SOURCE_EXTS.has(ext)) return 'source'
  if (DOC_EXTS.has(ext)) return 'doc'
  if (CONFIG_PATTERNS.some(p => p.test(name))) return 'config'
  if (/\.test\.|\.spec\.|__test__|test_/.test(name)) return 'test'
  if (/\.(png|jpg|svg|ico|gif|webp|woff|ttf)$/.test(ext)) return 'asset'
  return 'other'
}

function isKeyFile(name: string): boolean {
  return CONFIG_PATTERNS.some(p => p.test(name)) || name === 'README.md' || name === 'readme.md'
}

function countOccurrences(text: string, keyword: string): number {
  let count = 0
  let pos = 0
  while ((pos = text.indexOf(keyword, pos)) !== -1) {
    count++
    pos += keyword.length
  }
  return count
}

function buildTreeSummary(_rootDir: string, files: FileEntry[]): string {
  // 统计各目录的文件数
  const dirCounts = new Map<string, number>()
  for (const f of files) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '(root)'
    dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1)
  }

  // 按文件数降序排列，取前 20 个目录
  const sortedDirs = Array.from(dirCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)

  const lines = sortedDirs.map(([dir, count]) => `  ${dir}/ (${count} files)`)

  // 统计文件类型
  const extCounts = new Map<string, number>()
  for (const f of files) {
    if (f.ext) extCounts.set(f.ext, (extCounts.get(f.ext) || 0) + 1)
  }
  const topExts = Array.from(extCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([ext, count]) => `${ext}(${count})`)
    .join(' ')

  return `共 ${files.length} 个文件\n目录分布:\n${lines.join('\n')}\n文件类型: ${topExts}`
}
