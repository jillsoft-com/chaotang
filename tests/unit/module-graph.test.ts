/**
 * 模块关系追踪测试（三期 Phase D）
 *
 * 覆盖：依赖提取、模块图构建、查询、循环检测
 */

import { describe, it, expect } from 'vitest'
import {
  extractDependencies,
  buildModuleGraph,
  getModuleDependencies,
  getModuleDependents,
  detectCycles,
  getTransitiveDependencies
} from '@/services/agent/module-graph'

// ============ 辅助 ============

const TS_CODE_WITH_IMPORTS = `
import { add, subtract } from './math'
import { UserService } from '../services/user'
import type { Config } from './config'
const lodash = require('lodash')
`

// ============ 测试用例 ============

describe('extractDependencies', () => {
  it('提取 ES6 import', () => {
    const deps = extractDependencies(TS_CODE_WITH_IMPORTS, 'src/app.ts')
    expect(deps.length).toBeGreaterThanOrEqual(3)
    
    const mathDep = deps.find(d => d.to.includes('math'))
    expect(mathDep).toBeDefined()
    expect(mathDep?.importedSymbols).toContain('add')
    expect(mathDep?.importedSymbols).toContain('subtract')
  })

  it('提取相对路径', () => {
    const deps = extractDependencies(TS_CODE_WITH_IMPORTS, 'src/app.ts')
    const userDep = deps.find(d => d.to.includes('user'))
    expect(userDep).toBeDefined()
    expect(userDep?.to).toContain('services/user')
  })

  it('提取 type import', () => {
    const deps = extractDependencies(TS_CODE_WITH_IMPORTS, 'src/app.ts')
    const configDep = deps.find(d => d.to.includes('config'))
    expect(configDep).toBeDefined()
    expect(configDep?.importedSymbols).toContain('Config')
  })

  it('忽略 node_modules', () => {
    const deps = extractDependencies(TS_CODE_WITH_IMPORTS, 'src/app.ts')
    const lodashDep = deps.find(d => d.to === 'lodash')
    expect(lodashDep).toBeUndefined()
  })

  it('解析相对路径为绝对路径', () => {
    const deps = extractDependencies(`import { X } from './b'`, 'src/a.ts')
    expect(deps[0].to).toBe('src/b')
  })
})

describe('buildModuleGraph', () => {
  it('构建邻接表', () => {
    const deps = [
      { from: 'a.ts', to: 'b.ts' },
      { from: 'a.ts', to: 'c.ts' },
      { from: 'b.ts', to: 'c.ts' }
    ]
    const graph = buildModuleGraph(deps)
    
    expect(graph.modules).toContain('a.ts')
    expect(graph.modules).toContain('b.ts')
    expect(graph.modules).toContain('c.ts')
    expect(graph.dependencies).toHaveLength(3)
  })

  it('正向邻接表正确', () => {
    const deps = [
      { from: 'a.ts', to: 'b.ts' },
      { from: 'a.ts', to: 'c.ts' }
    ]
    const graph = buildModuleGraph(deps)
    
    const aDeps = getModuleDependencies(graph, 'a.ts')
    expect(aDeps).toContain('b.ts')
    expect(aDeps).toContain('c.ts')
  })

  it('反向邻接表正确', () => {
    const deps = [
      { from: 'a.ts', to: 'c.ts' },
      { from: 'b.ts', to: 'c.ts' }
    ]
    const graph = buildModuleGraph(deps)
    
    const cDependents = getModuleDependents(graph, 'c.ts')
    expect(cDependents).toContain('a.ts')
    expect(cDependents).toContain('b.ts')
  })
})

describe('getModuleDependencies', () => {
  it('返回模块的直接依赖', () => {
    const deps = [
      { from: 'a.ts', to: 'b.ts' },
      { from: 'a.ts', to: 'c.ts' }
    ]
    const graph = buildModuleGraph(deps)
    
    const result = getModuleDependencies(graph, 'a.ts')
    expect(result).toHaveLength(2)
    expect(result).toContain('b.ts')
    expect(result).toContain('c.ts')
  })

  it('无依赖时返回空数组', () => {
    const deps = [{ from: 'a.ts', to: 'b.ts' }]
    const graph = buildModuleGraph(deps)
    
    const result = getModuleDependencies(graph, 'b.ts')
    expect(result).toHaveLength(0)
  })
})

describe('getModuleDependents', () => {
  it('返回依赖该模块的所有模块', () => {
    const deps = [
      { from: 'a.ts', to: 'c.ts' },
      { from: 'b.ts', to: 'c.ts' }
    ]
    const graph = buildModuleGraph(deps)
    
    const result = getModuleDependents(graph, 'c.ts')
    expect(result).toHaveLength(2)
    expect(result).toContain('a.ts')
    expect(result).toContain('b.ts')
  })
})

describe('detectCycles', () => {
  it('检测循环依赖', () => {
    const deps = [
      { from: 'a.ts', to: 'b.ts' },
      { from: 'b.ts', to: 'c.ts' },
      { from: 'c.ts', to: 'a.ts' }
    ]
    const graph = buildModuleGraph(deps)
    
    const cycles = detectCycles(graph)
    expect(cycles.length).toBeGreaterThan(0)
    expect(cycles[0]).toContain('a.ts')
    expect(cycles[0]).toContain('b.ts')
    expect(cycles[0]).toContain('c.ts')
  })

  it('无循环时返回空数组', () => {
    const deps = [
      { from: 'a.ts', to: 'b.ts' },
      { from: 'b.ts', to: 'c.ts' }
    ]
    const graph = buildModuleGraph(deps)
    
    const cycles = detectCycles(graph)
    expect(cycles).toHaveLength(0)
  })
})

describe('getTransitiveDependencies', () => {
  it('返回传递依赖', () => {
    const deps = [
      { from: 'a.ts', to: 'b.ts' },
      { from: 'b.ts', to: 'c.ts' },
      { from: 'c.ts', to: 'd.ts' }
    ]
    const graph = buildModuleGraph(deps)
    
    const result = getTransitiveDependencies(graph, 'a.ts')
    expect(result).toContain('b.ts')
    expect(result).toContain('c.ts')
    expect(result).toContain('d.ts')
  })

  it('不包含自身', () => {
    const deps = [
      { from: 'a.ts', to: 'b.ts' }
    ]
    const graph = buildModuleGraph(deps)
    
    const result = getTransitiveDependencies(graph, 'a.ts')
    expect(result).not.toContain('a.ts')
  })
})
