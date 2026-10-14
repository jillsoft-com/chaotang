/**
 * 符号级代码索引 — 三期 Phase C
 *
 * 从源码文件中提取符号（函数、类、接口、变量等）和引用关系，
 * 构建轻量级调用图，供 Agent 查询"函数定义在哪"、"谁调用了它"。
 *
 * 支持语言：TypeScript / JavaScript / Vue / Python / Go
 */

// ============ 类型 ============

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'method'
  | 'property'
  | 'module'

export interface SymbolInfo {
  /** 符号名称 */
  name: string
  /** 符号种类 */
  kind: SymbolKind
  /** 所在文件路径 */
  filePath: string
  /** 起始行号（1-based） */
  startLine: number
  /** 结束行号 */
  endLine: number
  /** 签名（如函数参数列表） */
  signature: string
  /** 是否导出 */
  exported: boolean
  /** 父符号 ID（如方法属于某个类） */
  parentId?: string
  /** 唯一 ID（filePath:name:line） */
  id: string
}

export interface ReferenceInfo {
  /** 引用发生所在的文件 */
  filePath: string
  /** 行号 */
  line: number
  /** 被引用的符号名称 */
  symbolName: string
  /** 引用类型 */
  kind: 'import' | 'call' | 'type_ref' | 'other'
}

// ============ 符号提取 ============

/**
 * 从文件内容中提取符号
 */
export function extractSymbols(content: string, filePath: string, ext: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = []
  const lines = content.split('\n')

  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
      extractTSSymbols(content, filePath, lines, symbols)
      break
    case '.vue':
      extractVueSymbols(content, filePath, lines, symbols)
      break
    case '.py':
      extractPythonSymbols(content, filePath, lines, symbols)
      break
    case '.go':
      extractGoSymbols(content, filePath, lines, symbols)
      break
  }

  return symbols
}

function extractTSSymbols(_content: string, filePath: string, lines: string[], symbols: SymbolInfo[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // export function / export async function
    const funcMatch = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(\([^)]*\))?/)
    if (funcMatch) {
      symbols.push({
        id: `${filePath}:${funcMatch[1]}:${lineNum}`,
        name: funcMatch[1],
        kind: 'function',
        filePath,
        startLine: lineNum,
        endLine: findClosingBrace(lines, i),
        signature: funcMatch[2] || '()',
        exported: line.startsWith('export'),
      })
      continue
    }

    // export class
    const classMatch = line.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/)
    if (classMatch) {
      symbols.push({
        id: `${filePath}:${classMatch[1]}:${lineNum}`,
        name: classMatch[1],
        kind: 'class',
        filePath,
        startLine: lineNum,
        endLine: findClosingBrace(lines, i),
        signature: '',
        exported: line.startsWith('export'),
      })
      continue
    }

    // interface (export optional)
    const ifaceMatch = line.match(/^(?:export\s+)?interface\s+(\w+)/)
    if (ifaceMatch) {
      symbols.push({
        id: `${filePath}:${ifaceMatch[1]}:${lineNum}`,
        name: ifaceMatch[1],
        kind: 'interface',
        filePath,
        startLine: lineNum,
        endLine: findClosingBrace(lines, i),
        signature: '',
        exported: line.startsWith('export'),
      })
      continue
    }

    // export type
    const typeMatch = line.match(/^(?:export\s+)type\s+(\w+)/)
    if (typeMatch) {
      symbols.push({
        id: `${filePath}:${typeMatch[1]}:${lineNum}`,
        name: typeMatch[1],
        kind: 'type',
        filePath,
        startLine: lineNum,
        endLine: lineNum,
        signature: '',
        exported: line.startsWith('export'),
      })
      continue
    }

    // export enum
    const enumMatch = line.match(/^(?:export\s+)enum\s+(\w+)/)
    if (enumMatch) {
      symbols.push({
        id: `${filePath}:${enumMatch[1]}:${lineNum}`,
        name: enumMatch[1],
        kind: 'enum',
        filePath,
        startLine: lineNum,
        endLine: findClosingBrace(lines, i),
        signature: '',
        exported: line.startsWith('export'),
      })
      continue
    }

    // export const / let / var
    const varMatch = line.match(/^(?:export\s+)(?:const|let|var)\s+(\w+)\s*(?::\s*(\w[^=;]*))?\s*=/)
    if (varMatch) {
      symbols.push({
        id: `${filePath}:${varMatch[1]}:${lineNum}`,
        name: varMatch[1],
        kind: 'variable',
        filePath,
        startLine: lineNum,
        endLine: lineNum,
        signature: varMatch[2] || '',
        exported: line.startsWith('export'),
      })
    }
  }
}

function extractVueSymbols(content: string, filePath: string, lines: string[], symbols: SymbolInfo[]): void {
  // Vue SFC: 提取 <script> 块中的 TS/JS 符号
  const scriptMatch = content.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  if (scriptMatch) {
    const scriptContent = scriptMatch[1]
    const scriptStart = content.slice(0, scriptMatch.index).split('\n').length
    extractTSSymbols(scriptContent, filePath, scriptContent.split('\n'), symbols)
    // 修正行号偏移
    for (const sym of symbols) {
      if (sym.filePath === filePath) {
        sym.startLine += scriptStart - 1
        sym.endLine += scriptStart - 1
      }
    }
  }

  // 提取组件名（defineComponent / setup）
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const compMatch = line.match(/name:\s*['"](\w+)['"]/)
    if (compMatch) {
      symbols.push({
        id: `${filePath}:${compMatch[1]}:${i + 1}`,
        name: compMatch[1],
        kind: 'module',
        filePath,
        startLine: i + 1,
        endLine: i + 1,
        signature: 'Vue Component',
        exported: true,
      })
    }
  }
}

function extractPythonSymbols(_content: string, filePath: string, lines: string[], symbols: SymbolInfo[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // def function_name(
    const funcMatch = line.match(/^(\s*)def\s+(\w+)\s*(\([^)]*\))?/)
    if (funcMatch) {
      const indent = funcMatch[1].length
      symbols.push({
        id: `${filePath}:${funcMatch[2]}:${lineNum}`,
        name: funcMatch[2],
        kind: indent > 0 ? 'method' : 'function',
        filePath,
        startLine: lineNum,
        endLine: findPythonBlockEnd(lines, i, indent),
        signature: funcMatch[3] || '()',
        exported: !funcMatch[2].startsWith('_'),
      })
      continue
    }

    // class ClassName
    const classMatch = line.match(/^(\s*)class\s+(\w+)/)
    if (classMatch) {
      symbols.push({
        id: `${filePath}:${classMatch[2]}:${lineNum}`,
        name: classMatch[2],
        kind: 'class',
        filePath,
        startLine: lineNum,
        endLine: findPythonBlockEnd(lines, i, classMatch[1].length),
        signature: '',
        exported: !classMatch[2].startsWith('_'),
      })
    }
  }
}

function extractGoSymbols(_content: string, filePath: string, lines: string[], symbols: SymbolInfo[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // func FunctionName(
    const funcMatch = line.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*(\([^)]*\))?/)
    if (funcMatch) {
      symbols.push({
        id: `${filePath}:${funcMatch[1]}:${lineNum}`,
        name: funcMatch[1],
        kind: 'function',
        filePath,
        startLine: lineNum,
        endLine: findClosingBrace(lines, i),
        signature: funcMatch[2] || '()',
        exported: /^[A-Z]/.test(funcMatch[1]),
      })
      continue
    }

    // type TypeName struct/interface
    const typeMatch = line.match(/^type\s+(\w+)\s+(struct|interface)/)
    if (typeMatch) {
      symbols.push({
        id: `${filePath}:${typeMatch[1]}:${lineNum}`,
        name: typeMatch[1],
        kind: typeMatch[2] === 'interface' ? 'interface' : 'class',
        filePath,
        startLine: lineNum,
        endLine: findClosingBrace(lines, i),
        signature: typeMatch[2],
        exported: /^[A-Z]/.test(typeMatch[1]),
      })
    }
  }
}

// ============ 引用提取 ============

/**
 * 从文件内容中提取对已知符号的引用
 */
export function extractReferences(content: string, filePath: string, knownSymbols: SymbolInfo[]): ReferenceInfo[] {
  const refs: ReferenceInfo[] = []
  const lines = content.split('\n')
  const symbolNames = new Set(knownSymbols.map(s => s.name))

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // import 语句
    const importMatch = line.match(/import\s+.*?\{([^}]+)\}.*?from\s+['"]([^'"]+)['"]/)
    if (importMatch) {
      const names = importMatch[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim())
      for (const name of names) {
        if (symbolNames.has(name)) {
          refs.push({ filePath, line: lineNum, symbolName: name, kind: 'import' })
        }
      }
      continue
    }

    // 函数调用：symbolName(
    const callRegex = /\b(\w+)\s*\(/g
    let match
    while ((match = callRegex.exec(line)) !== null) {
      if (symbolNames.has(match[1])) {
        refs.push({ filePath, line: lineNum, symbolName: match[1], kind: 'call' })
      }
    }
  }

  return refs
}

// ============ 符号索引类 ============

export class SymbolIndex {
  private symbols = new Map<string, SymbolInfo>()
  private references: ReferenceInfo[] = []
  /** 按名称索引：name → symbol IDs */
  private nameIndex = new Map<string, string[]>()
  /** 引用索引：symbolName → ReferenceInfo[] */
  private refIndex = new Map<string, ReferenceInfo[]>()

  /**
   * 添加符号
   */
  addSymbol(symbol: SymbolInfo): void {
    this.symbols.set(symbol.id, symbol)
    const existing = this.nameIndex.get(symbol.name) || []
    existing.push(symbol.id)
    this.nameIndex.set(symbol.name, existing)
  }

  /**
   * 批量添加符号
   */
  addSymbols(symbols: SymbolInfo[]): void {
    for (const s of symbols) this.addSymbol(s)
  }

  /**
   * 添加引用
   */
  addReferences(refs: ReferenceInfo[]): void {
    this.references.push(...refs)
    for (const ref of refs) {
      const existing = this.refIndex.get(ref.symbolName) || []
      existing.push(ref)
      this.refIndex.set(ref.symbolName, existing)
    }
  }

  /**
   * 按名称查找符号定义
   */
  lookupSymbol(name: string): SymbolInfo[] {
    const ids = this.nameIndex.get(name) || []
    return ids.map(id => this.symbols.get(id)!).filter(Boolean)
  }

  /**
   * 查找符号的所有引用
   */
  findReferences(name: string): ReferenceInfo[] {
    return this.refIndex.get(name) || []
  }

  /**
   * 获取调用图（谁调用了这个符号）
   */
  getCallGraph(name: string): { symbol: SymbolInfo; callers: ReferenceInfo[] } {
    const defs = this.lookupSymbol(name)
    const callers = this.findReferences(name).filter(r => r.kind === 'call')
    return {
      symbol: defs[0] || { name, kind: 'function' as SymbolKind, filePath: '', startLine: 0, endLine: 0, signature: '', exported: false, id: '' },
      callers
    }
  }

  /**
   * 获取所有符号
   */
  getAllSymbols(): SymbolInfo[] {
    return Array.from(this.symbols.values())
  }

  /**
   * 获取符号总数
   */
  get size(): number {
    return this.symbols.size
  }

  /**
   * 清空索引
   */
  clear(): void {
    this.symbols.clear()
    this.references = []
    this.nameIndex.clear()
    this.refIndex.clear()
  }
}

// ============ 辅助函数 ============

function findClosingBrace(lines: string[], startLine: number): number {
  let depth = 0
  let foundOpen = false
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; foundOpen = true }
      if (ch === '}') depth--
      if (foundOpen && depth === 0) return i + 1
    }
  }
  return startLine + 1
}

function findPythonBlockEnd(lines: string[], startLine: number, baseIndent: number): number {
  let lastContentLine = startLine
  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = line.search(/\S/)
    if (indent <= baseIndent) break
    lastContentLine = i
  }
  return lastContentLine + 1
}
