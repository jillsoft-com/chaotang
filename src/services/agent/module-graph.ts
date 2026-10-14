/**
 * 模块关系追踪 — 三期 Phase D
 *
 * 从 import 语句中提取模块依赖关系，构建依赖图，
 * 供 Agent 查询"模块 A 依赖哪些模块"、"谁依赖了模块 B"。
 */

// ============ 类型 ============

export interface ModuleDependency {
  /** 源模块路径 */
  from: string
  /** 目标模块路径 */
  to: string
  /** 导入的符号（可选） */
  importedSymbols?: string[]
}

export interface ModuleGraph {
  /** 所有模块路径 */
  modules: string[]
  /** 依赖关系列表 */
  dependencies: ModuleDependency[]
  /** 邻接表：模块 → 它依赖的模块 */
  adjacencyList: Map<string, string[]>
  /** 反向邻接表：模块 → 依赖它的模块 */
  reverseAdjacencyList: Map<string, string[]>
}

// ============ 依赖提取 ============

/**
 * 从文件内容中提取 import 依赖
 */
export function extractDependencies(content: string, filePath: string): ModuleDependency[] {
  const deps: ModuleDependency[] = []
  const lines = content.split('\n')

  for (const line of lines) {
    // ES6 import: import { X } from './module' or import type { X } from './module'
    const es6Match = line.match(/import\s+(?:type\s+)?(?:.*?\s+from\s+)?['"]([^'"]+)['"]/)
    if (es6Match) {
      const importPath = es6Match[1]
      // 跳过 node_modules 和非相对路径
      if (importPath.startsWith('.') || importPath.startsWith('/')) {
        // 提取导入的符号
        const symbolsMatch = line.match(/import\s+(?:type\s+)?\{([^}]+)\}/)
        const symbols = symbolsMatch
          ? symbolsMatch[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim())
          : undefined

        deps.push({
          from: filePath,
          to: resolveImportPath(filePath, importPath),
          importedSymbols: symbols
        })
      }
      continue
    }

    // CommonJS require: const X = require('./module')
    const requireMatch = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/)
    if (requireMatch) {
      const importPath = requireMatch[1]
      if (importPath.startsWith('.') || importPath.startsWith('/')) {
        deps.push({
          from: filePath,
          to: resolveImportPath(filePath, importPath)
        })
      }
    }
  }

  return deps
}

/**
 * 解析相对导入路径为绝对路径
 */
function resolveImportPath(fromFile: string, importPath: string): string {
  if (importPath.startsWith('/')) return importPath

  // 相对路径：从 fromFile 的目录开始
  const fromDir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : ''
  const parts = [...fromDir.split('/'), ...importPath.split('/')]
  const resolved: string[] = []

  for (const part of parts) {
    if (part === '..') {
      resolved.pop()
    } else if (part !== '.' && part !== '') {
      resolved.push(part)
    }
  }

  return resolved.join('/')
}

// ============ 模块图构建 ============

/**
 * 构建模块依赖图
 */
export function buildModuleGraph(dependencies: ModuleDependency[]): ModuleGraph {
  const modules = new Set<string>()
  const adjacencyList = new Map<string, string[]>()
  const reverseAdjacencyList = new Map<string, string[]>()

  for (const dep of dependencies) {
    modules.add(dep.from)
    modules.add(dep.to)

    // 正向邻接
    const forward = adjacencyList.get(dep.from) || []
    if (!forward.includes(dep.to)) forward.push(dep.to)
    adjacencyList.set(dep.from, forward)

    // 反向邻接
    const reverse = reverseAdjacencyList.get(dep.to) || []
    if (!reverse.includes(dep.from)) reverse.push(dep.from)
    reverseAdjacencyList.set(dep.to, reverse)
  }

  return {
    modules: Array.from(modules),
    dependencies,
    adjacencyList,
    reverseAdjacencyList
  }
}

// ============ 查询函数 ============

/**
 * 查询模块依赖了哪些其他模块
 */
export function getModuleDependencies(graph: ModuleGraph, modulePath: string): string[] {
  return graph.adjacencyList.get(modulePath) || []
}

/**
 * 查询哪些模块依赖了指定模块
 */
export function getModuleDependents(graph: ModuleGraph, modulePath: string): string[] {
  return graph.reverseAdjacencyList.get(modulePath) || []
}

/**
 * 检测循环依赖
 */
export function detectCycles(graph: ModuleGraph): string[][] {
  const cycles: string[][] = []
  const visited = new Set<string>()
  const recursionStack = new Set<string>()

  function dfs(node: string, path: string[]): void {
    if (recursionStack.has(node)) {
      // 找到环
      const cycleStart = path.indexOf(node)
      if (cycleStart !== -1) {
        cycles.push(path.slice(cycleStart))
      }
      return
    }

    if (visited.has(node)) return

    visited.add(node)
    recursionStack.add(node)
    path.push(node)

    const neighbors = graph.adjacencyList.get(node) || []
    for (const neighbor of neighbors) {
      dfs(neighbor, [...path])
    }

    recursionStack.delete(node)
  }

  for (const module of graph.modules) {
    if (!visited.has(module)) {
      dfs(module, [])
    }
  }

  return cycles
}

/**
 * 获取模块的传递依赖（所有直接或间接依赖）
 */
export function getTransitiveDependencies(graph: ModuleGraph, modulePath: string): string[] {
  const result = new Set<string>()
  const queue = [modulePath]
  const visited = new Set<string>()

  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)

    const deps = graph.adjacencyList.get(current) || []
    for (const dep of deps) {
      if (dep !== modulePath) {
        result.add(dep)
        queue.push(dep)
      }
    }
  }

  return Array.from(result)
}
