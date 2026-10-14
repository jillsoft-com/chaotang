/**
 * 符号级代码索引测试（三期 Phase C）
 *
 * 覆盖：符号提取（TS/Vue/Python/Go）、引用提取、SymbolIndex 类、symbolSearch
 */

import { describe, it, expect } from 'vitest'
import { extractSymbols, extractReferences, SymbolIndex } from '@/services/agent/symbol-index'
import type { SymbolInfo } from '@/services/agent/symbol-index'

// ============ 辅助 ============

const TS_CODE = `
export function add(a: number, b: number): number {
  return a + b
}

export class Calculator {
  multiply(x: number, y: number) {
    return x * y
  }
}

interface Config {
  name: string
  value: number
}

export type Result = {
  success: boolean
  data: any
}

export const VERSION = '1.0.0'
`

const VUE_CODE = `
<template>
  <div>{{ message }}</div>
</template>

<script>
export function setup() {
  const message = 'Hello'
  return { message }
}

export default {
  name: 'HelloWorld'
}
</script>
`

const PYTHON_CODE = `
def greet(name):
    return f"Hello, {name}"

class UserService:
    def __init__(self):
        self.users = []
    
    def add_user(self, user):
        self.users.append(user)
`

const GO_CODE = `
func Add(a int, b int) int {
    return a + b
}

type User struct {
    Name string
    Age int
}

type Repository interface {
    Find(id string) (*User, error)
}
`

// ============ 测试用例 ============

describe('extractSymbols — TypeScript', () => {
  it('提取函数', () => {
    const symbols = extractSymbols(TS_CODE, 'test.ts', '.ts')
    const func = symbols.find(s => s.name === 'add')
    expect(func).toBeDefined()
    expect(func?.kind).toBe('function')
    expect(func?.exported).toBe(true)
    expect(func?.signature).toContain('a: number')
  })

  it('提取类', () => {
    const symbols = extractSymbols(TS_CODE, 'test.ts', '.ts')
    const cls = symbols.find(s => s.name === 'Calculator')
    expect(cls).toBeDefined()
    expect(cls?.kind).toBe('class')
    expect(cls?.exported).toBe(true)
  })

  it('提取接口', () => {
    const symbols = extractSymbols(TS_CODE, 'test.ts', '.ts')
    const iface = symbols.find(s => s.name === 'Config')
    expect(iface).toBeDefined()
    expect(iface?.kind).toBe('interface')
  })

  it('提取类型别名', () => {
    const symbols = extractSymbols(TS_CODE, 'test.ts', '.ts')
    const type = symbols.find(s => s.name === 'Result')
    expect(type).toBeDefined()
    expect(type?.kind).toBe('type')
  })

  it('提取导出变量', () => {
    const symbols = extractSymbols(TS_CODE, 'test.ts', '.ts')
    const variable = symbols.find(s => s.name === 'VERSION')
    expect(variable).toBeDefined()
    expect(variable?.kind).toBe('variable')
    expect(variable?.exported).toBe(true)
  })
})

describe('extractSymbols — Vue', () => {
  it('提取 script 块中的函数', () => {
    const symbols = extractSymbols(VUE_CODE, 'test.vue', '.vue')
    const func = symbols.find(s => s.name === 'setup')
    expect(func).toBeDefined()
    expect(func?.kind).toBe('function')
  })

  it('提取组件名', () => {
    const symbols = extractSymbols(VUE_CODE, 'test.vue', '.vue')
    const component = symbols.find(s => s.name === 'HelloWorld')
    expect(component).toBeDefined()
    expect(component?.kind).toBe('module')
    expect(component?.signature).toBe('Vue Component')
  })
})

describe('extractSymbols — Python', () => {
  it('提取顶层函数', () => {
    const symbols = extractSymbols(PYTHON_CODE, 'test.py', '.py')
    const func = symbols.find(s => s.name === 'greet')
    expect(func).toBeDefined()
    expect(func?.kind).toBe('function')
    expect(func?.exported).toBe(true)
  })

  it('提取类', () => {
    const symbols = extractSymbols(PYTHON_CODE, 'test.py', '.py')
    const cls = symbols.find(s => s.name === 'UserService')
    expect(cls).toBeDefined()
    expect(cls?.kind).toBe('class')
  })

  it('提取方法（缩进 > 0）', () => {
    const symbols = extractSymbols(PYTHON_CODE, 'test.py', '.py')
    const method = symbols.find(s => s.name === 'add_user')
    expect(method).toBeDefined()
    expect(method?.kind).toBe('method')
  })
})

describe('extractSymbols — Go', () => {
  it('提取函数', () => {
    const symbols = extractSymbols(GO_CODE, 'test.go', '.go')
    const func = symbols.find(s => s.name === 'Add')
    expect(func).toBeDefined()
    expect(func?.kind).toBe('function')
    expect(func?.exported).toBe(true) // 首字母大写
  })

  it('提取 struct', () => {
    const symbols = extractSymbols(GO_CODE, 'test.go', '.go')
    const struct = symbols.find(s => s.name === 'User')
    expect(struct).toBeDefined()
    expect(struct?.kind).toBe('class') // struct 映射为 class
  })

  it('提取 interface', () => {
    const symbols = extractSymbols(GO_CODE, 'test.go', '.go')
    const iface = symbols.find(s => s.name === 'Repository')
    expect(iface).toBeDefined()
    expect(iface?.kind).toBe('interface')
  })
})

describe('extractReferences', () => {
  it('提取 import 语句', () => {
    const knownSymbols: SymbolInfo[] = [
      { id: '1', name: 'add', kind: 'function', filePath: 'math.ts', startLine: 1, endLine: 3, signature: '()', exported: true }
    ]
    const code = `import { add } from './math'`
    const refs = extractReferences(code, 'test.ts', knownSymbols)
    expect(refs).toHaveLength(1)
    expect(refs[0].symbolName).toBe('add')
    expect(refs[0].kind).toBe('import')
  })

  it('提取函数调用', () => {
    const knownSymbols: SymbolInfo[] = [
      { id: '1', name: 'calculate', kind: 'function', filePath: 'calc.ts', startLine: 1, endLine: 3, signature: '()', exported: true }
    ]
    const code = `const result = calculate(1, 2)`
    const refs = extractReferences(code, 'test.ts', knownSymbols)
    expect(refs).toHaveLength(1)
    expect(refs[0].symbolName).toBe('calculate')
    expect(refs[0].kind).toBe('call')
  })
})

describe('SymbolIndex', () => {
  it('添加和查找符号', () => {
    const index = new SymbolIndex()
    const symbol: SymbolInfo = {
      id: 'test.ts:add:1',
      name: 'add',
      kind: 'function',
      filePath: 'test.ts',
      startLine: 1,
      endLine: 3,
      signature: '(a, b)',
      exported: true
    }
    index.addSymbol(symbol)
    
    const results = index.lookupSymbol('add')
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('add')
  })

  it('批量添加符号', () => {
    const index = new SymbolIndex()
    const symbols: SymbolInfo[] = [
      { id: '1', name: 'foo', kind: 'function', filePath: 'a.ts', startLine: 1, endLine: 2, signature: '()', exported: true },
      { id: '2', name: 'bar', kind: 'function', filePath: 'b.ts', startLine: 1, endLine: 2, signature: '()', exported: true }
    ]
    index.addSymbols(symbols)
    expect(index.size).toBe(2)
  })

  it('查找引用', () => {
    const index = new SymbolIndex()
    index.addReferences([
      { filePath: 'test.ts', line: 10, symbolName: 'add', kind: 'call' },
      { filePath: 'test.ts', line: 20, symbolName: 'add', kind: 'call' }
    ])
    
    const refs = index.findReferences('add')
    expect(refs).toHaveLength(2)
    expect(refs[0].symbolName).toBe('add')
  })

  it('获取调用图', () => {
    const index = new SymbolIndex()
    const symbol: SymbolInfo = {
      id: '1', name: 'calculate', kind: 'function', filePath: 'calc.ts',
      startLine: 1, endLine: 3, signature: '()', exported: true
    }
    index.addSymbol(symbol)
    index.addReferences([
      { filePath: 'main.ts', line: 5, symbolName: 'calculate', kind: 'call' }
    ])
    
    const graph = index.getCallGraph('calculate')
    expect(graph.symbol.name).toBe('calculate')
    expect(graph.callers).toHaveLength(1)
    expect(graph.callers[0].kind).toBe('call')
  })

  it('清空索引', () => {
    const index = new SymbolIndex()
    index.addSymbol({
      id: '1', name: 'test', kind: 'function', filePath: 'a.ts',
      startLine: 1, endLine: 2, signature: '()', exported: true
    })
    expect(index.size).toBe(1)
    
    index.clear()
    expect(index.size).toBe(0)
  })
})
