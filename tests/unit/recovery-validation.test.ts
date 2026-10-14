/**
 * P1-C 恢复校验 — 单元测试
 *
 * 测试 validateFileBaselines 三种场景：
 * - write_landed: 写入已落盘
 * - write_lost: 写入未落盘/已撤销
 * - conflict: 外部修改冲突
 */

import { describe, it, expect } from 'vitest'
import {
  validateFileBaselines
} from '@/services/agent/acceptance-gate'
import type { FileBaselineEntry } from '@/services/agent/acceptance-gate'

/**
 * 辅助函数：模拟 readFileWithHash 接口
 * 使用简单的字符串哈希来模拟 SHA-256（仅用于测试）
 */
function mockHash(content: string): string {
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash) + content.charCodeAt(i)
    hash = hash & hash // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, '0')
}

function createReadFileWithHash(fileContents: Record<string, string | null>) {
  return async (path: string): Promise<{ content: string; sha256: string } | null> => {
    const content = fileContents[path]
    if (content === null || content === undefined) return null
    return { content, sha256: mockHash(content) }
  }
}

describe('P1-C 恢复校验', () => {
  describe('validateFileBaselines — 三种场景', () => {
    it('currentSha === afterSha256 → write_landed', async () => {
      const beforeHash = mockHash('original content')
      const afterHash = mockHash('modified content')

      const baselines: Record<string, FileBaselineEntry> = {
        '/src/a.ts': { beforeSha256: beforeHash, afterSha256: afterHash }
      }

      const readFileWithHash = createReadFileWithHash({ '/src/a.ts': 'modified content' })
      const results = await validateFileBaselines(baselines, readFileWithHash)

      expect(results.length).toBe(1)
      expect(results[0].status).toBe('write_landed')
      expect(results[0].path).toBe('/src/a.ts')
    })

    it('currentSha === beforeSha256 → write_lost', async () => {
      const beforeHash = mockHash('original content')
      const afterHash = mockHash('modified content')

      const baselines: Record<string, FileBaselineEntry> = {
        '/src/b.ts': { beforeSha256: beforeHash, afterSha256: afterHash }
      }

      // 文件内容仍然是修改前的内容 → write_lost
      const readFileWithHash = createReadFileWithHash({ '/src/b.ts': 'original content' })
      const results = await validateFileBaselines(baselines, readFileWithHash)

      expect(results.length).toBe(1)
      expect(results[0].status).toBe('write_lost')
    })

    it('两者均不等 → conflict', async () => {
      const beforeHash = mockHash('original content')
      const afterHash = mockHash('modified content')

      const baselines: Record<string, FileBaselineEntry> = {
        '/src/c.ts': { beforeSha256: beforeHash, afterSha256: afterHash }
      }

      // 文件内容被第三方修改 → conflict
      const readFileWithHash = createReadFileWithHash({ '/src/c.ts': 'some other content' })
      const results = await validateFileBaselines(baselines, readFileWithHash)

      expect(results.length).toBe(1)
      expect(results[0].status).toBe('conflict')
    })

    it('文件不存在 → conflict', async () => {
      const beforeHash = mockHash('original')
      const afterHash = mockHash('new')

      const baselines: Record<string, FileBaselineEntry> = {
        '/src/d.ts': { beforeSha256: beforeHash, afterSha256: afterHash }
      }

      // 文件不存在
      const readFileWithHash = createReadFileWithHash({})
      const results = await validateFileBaselines(baselines, readFileWithHash)

      expect(results.length).toBe(1)
      expect(results[0].status).toBe('conflict')
      expect(results[0].currentSha256).toBe('')
    })

    it('无 afterSha256 且 currentSha === beforeSha256 → write_lost', async () => {
      const beforeHash = mockHash('original')

      const baselines: Record<string, FileBaselineEntry> = {
        '/src/e.ts': { beforeSha256: beforeHash }
      }

      const readFileWithHash = createReadFileWithHash({ '/src/e.ts': 'original' })
      const results = await validateFileBaselines(baselines, readFileWithHash)

      expect(results.length).toBe(1)
      expect(results[0].status).toBe('write_lost')
    })

    it('多文件混合场景', async () => {
      const hashA_before = mockHash('a-before')
      const hashA_after = mockHash('a-after')
      const hashB_before = mockHash('b-before')
      const hashB_after = mockHash('b-after')
      const hashC_before = mockHash('c-before')
      const hashC_after = mockHash('c-after')

      const baselines: Record<string, FileBaselineEntry> = {
        '/a.ts': { beforeSha256: hashA_before, afterSha256: hashA_after },
        '/b.ts': { beforeSha256: hashB_before, afterSha256: hashB_after },
        '/c.ts': { beforeSha256: hashC_before, afterSha256: hashC_after }
      }

      const fileContents: Record<string, string | null> = {
        '/a.ts': 'a-after',    // write_landed
        '/b.ts': 'b-before',   // write_lost
        '/c.ts': 'c-external'  // conflict
      }

      const readFileWithHash = createReadFileWithHash(fileContents)
      const results = await validateFileBaselines(baselines, readFileWithHash)

      expect(results.length).toBe(3)
      const byPath = Object.fromEntries(results.map(r => [r.path, r]))
      expect(byPath['/a.ts'].status).toBe('write_landed')
      expect(byPath['/b.ts'].status).toBe('write_lost')
      expect(byPath['/c.ts'].status).toBe('conflict')
    })

    it('空基线 → 空结果', async () => {
      const results = await validateFileBaselines({}, async () => null)
      expect(results).toEqual([])
    })
  })
})
