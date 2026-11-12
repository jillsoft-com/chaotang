/**
 * Worker 二次拆解 / 长期目标重规划的上屏内容回归测试
 *
 * 背景：这两处走的是「模型只回 JSON」的内部协议。协议文本曾直接被写进发言气泡，
 * 用户在一轮执行结束后看到的是一整段 {"needDecompose": true, "subtasks": [...]}，
 * 解析失败时更是整段裸文本原样留在会话区。
 * 这里用假 provider 钉住三件事：
 * 1) 拆解成功 → 气泡是可读清单，且子任务确实进了任务树；
 * 2) 判定不拆解 → 气泡是一句结论说明，节点保持为叶子；
 * 3) 回复不是合法 JSON → 既不泄漏裸文本，也不误建子节点。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { LocalStorageBackend } from '@/services/storage/local-storage'
import { setStorageBackend, resetStorageBackend } from '@/services/storage/factory'
import { initializeAppStorage, resetAppStorageForTest } from '@/services/storage/app-storage'
import { createTree, createNode, addNode, computeDepth } from '@/services/agent/task-tree'
import type { TaskNode, TaskTreeSnapshot } from '@/services/agent/task-tree'
import type { Speech } from '@/types'

/** 假 provider 的可控开关：需在 vi.mock 工厂里引用，故用 hoisted */
const stub = vi.hoisted(() => ({ reply: '', throwOnStream: false }))

vi.mock('@/services/llm', () => ({
  createProvider: () => ({
    chatStream: async (_messages: any[], onContent?: (text: string) => void) => {
      if (stub.throwOnStream) throw new Error('网络中断')
      // 模拟流式：先推一段半成品，再返回完整文本
      onContent?.(stub.reply.slice(0, Math.min(20, stub.reply.length)))
      return stub.reply
    },
    chat: async () => stub.reply
  })
}))

// coordinator 会经 skills barrel 创建 SkillRegistry 单例，构造时就要读本地存储；
// 静态 import 会被提升到存储初始化之前，因此这里等存储就绪后再动态取类
let CoordinatorAgent: new () => any

beforeEach(async () => {
  localStorage.clear()
  resetAppStorageForTest()
  setStorageBackend(new LocalStorageBackend(''))
  await initializeAppStorage()
  ;({ CoordinatorAgent } = await import('@/services/agent/coordinator'))
})

afterEach(() => {
  resetAppStorageForTest()
  resetStorageBackend()
  localStorage.clear()
  stub.reply = ''
  stub.throwOnStream = false
})

const WORKER: any = {
  id: 'frontend',
  name: '前端开发',
  title: '前端开发',
  description: '实现前端代码并编译验证',
  systemPrompt: '你是前端开发',
  llm: { apiKey: 'test', model: 'test-model', baseURL: 'http://localhost/v1' },
  order: 2
}

interface Harness {
  tree: TaskTreeSnapshot
  node: TaskNode
  speeches: Speech[]
  decompose: (reply: string) => Promise<Speech>
}

function buildHarness(): Harness {
  const coordinator = new CoordinatorAgent()
  const tree = createTree('debate-test', '修复开发环境 API 代理', '丞相计划', 'chancellor')
  const node = createNode({
    title: '修复开发代理',
    description: '创建或修改 web/vite.config.ts 并验证请求代理生效',
    parentId: tree.rootId,
    createdBy: 'chancellor',
    assigneeId: WORKER.id,
    mode: 'action',
    autonomous: true,
    readOnly: false,
    decomposition: 'unexamined'
  })
  const added = addNode(tree, node)
  if (!added.ok) throw new Error(`测试前置失败：${added.error}`)

  const speeches: Speech[] = []
  const addSpeech = (speech: Speech) => { speeches.push(speech) }
  const getReactiveSpeech = (id: string) => speeches.find(s => s.id === id)!
  const resolveLLM = (llm: any) => llm

  return {
    tree,
    node,
    speeches,
    async decompose(reply: string) {
      stub.reply = reply
      await (coordinator as any).requestWorkerDecomposition(
        WORKER, node, tree, '修复开发环境 API 代理', addSpeech, getReactiveSpeech, resolveLLM
      )
      return getReactiveSpeech(speeches[speeches.length - 1].id)
    }
  }
}

/** 判定「原始协议文本上屏」：既不该出现 JSON 括号，也不该出现协议字段名 */
function looksLikeRawProtocol(text: string): boolean {
  return text.includes('needDecompose') || text.includes('"subtasks"') || text.includes('{') || text.includes('}')
}

describe('Worker 二次拆解的上屏内容', () => {
  let h: Harness

  beforeEach(() => {
    h = buildHarness()
  })

  it('拆解成功时展示可读子任务清单，原始 JSON 不上屏', async () => {
    const reply = JSON.stringify({
      needDecompose: true,
      subtasks: [
        {
          title: '检查前端请求与开发配置',
          description: '使用相对路径检查 web/ 中的 API 基址、Vite 配置与启动脚本。',
          acceptance: ['明确当前 API 请求路径与开发服务器配置', '指出导致请求落入 SPA 回退的配置缺口'],
          autonomous: false
        },
        {
          title: '修复开发代理并补充配置文档',
          description: '按实际项目结构创建或修改 web/vite.config.ts，改后立即回读核对。',
          acceptance: ['开发环境的 /api/v1 请求能够代理至可配置的本地 API 目标'],
          autonomous: true
        }
      ]
    })

    const speech = await h.decompose(reply)

    expect(looksLikeRawProtocol(speech.content)).toBe(false)
    expect(speech.content).toContain('检查前端请求与开发配置')
    expect(speech.content).toContain('修复开发代理并补充配置文档')
    expect(speech.content).toContain('验收：')
    expect(speech.status).toBe('completed')

    const children = Object.values(h.tree.nodes).filter(n => n.parentId === h.node.id)
    expect(children).toHaveLength(2)
    expect(children[0].acceptance).toHaveLength(2)
    expect(children[1].autonomous).toBe(true)
    expect(children.every(c => computeDepth(h.tree, c.id) === 2)).toBe(true)
  })

  it('判定无需拆解时只留一句结论，节点仍是叶子', async () => {
    const speech = await h.decompose(JSON.stringify({ needDecompose: false }))

    expect(looksLikeRawProtocol(speech.content)).toBe(false)
    expect(speech.content).toContain('无需再拆解')
    expect(speech.status).toBe('completed')
    expect(Object.values(h.tree.nodes).filter(n => n.parentId === h.node.id)).toHaveLength(0)
  })

  it('回复不是合法 JSON 时既不泄漏裸文本也不建子节点', async () => {
    const speech = await h.decompose('这个任务有点复杂，我建议拆成几步来做，先检查配置再改代理。')

    expect(speech.content).not.toContain('这个任务有点复杂')
    expect(looksLikeRawProtocol(speech.content)).toBe(false)
    expect(speech.content).toContain('未能解析')
    expect(speech.status).toBe('completed')
    expect(Object.values(h.tree.nodes).filter(n => n.parentId === h.node.id)).toHaveLength(0)
  })

  it('子任务超出单父节点上限时如实说明被截断的数量', async () => {
    const maxChildren = h.tree.limits?.maxChildren ?? 5
    const reply = JSON.stringify({
      needDecompose: true,
      subtasks: Array.from({ length: maxChildren + 2 }, (_, i) => ({
        title: `子任务 ${i + 1}`,
        description: `第 ${i + 1} 项要交付的东西`,
        acceptance: ['验收项'],
        autonomous: true
      }))
    })

    const speech = await h.decompose(reply)

    const children = Object.values(h.tree.nodes).filter(n => n.parentId === h.node.id)
    expect(children).toHaveLength(maxChildren)
    expect(speech.content).toContain(`其余 ${maxChildren + 2 - maxChildren} 项`)
    expect(looksLikeRawProtocol(speech.content)).toBe(false)
  })

  it('provider 调用抛错时不留占位文案、不中断执行', async () => {
    stub.reply = ''
    stub.throwOnStream = true
    try {
      const speech = await h.decompose('')
      expect(speech.content).toContain('未完成')
      expect(speech.content).not.toContain('正在评估任务粒度')
      expect(speech.status).toBe('completed')
      // 评估失败不该顺手造出一堆凭空的子节点
      expect(Object.values(h.tree.nodes).filter(n => n.parentId === h.node.id)).toHaveLength(0)
    } finally {
      stub.throwOnStream = false
    }
  })
})

describe('长期目标重规划的上屏内容', () => {
  it('重规划成功时展示追加子任务清单，原始 JSON 不上屏', async () => {
    const coordinator = new CoordinatorAgent()
    const tree = createTree('debate-goal', '持续完善订单模块', '丞相计划', 'chancellor')
    const speeches: Speech[] = []

    stub.reply = JSON.stringify({
      subtasks: [
        { title: '补齐退款路径测试', description: '为 refund 分支补充集成测试', assigneeId: 'tester', autonomous: true },
        { title: '整理接口文档', description: '输出订单模块接口说明', assigneeId: 'general', autonomous: false }
      ]
    })

    await (coordinator as any).requestGoalReplanForTree(
      { id: 'chancellor', name: '丞相', llm: WORKER.llm, systemPrompt: '你是丞相' } as any,
      tree,
      '目标：订单模块测试覆盖率达 80%',
      '持续完善订单模块',
      (s: Speech) => speeches.push(s),
      (id: string) => speeches.find(s => s.id === id)!,
      (llm: any) => llm
    )

    const speech = speeches[speeches.length - 1]
    expect(looksLikeRawProtocol(speech.content)).toBe(false)
    expect(speech.content).toContain('补齐退款路径测试')
    expect(speech.content).toContain('整理接口文档')
    expect(speech.status).toBe('completed')
    expect(Object.values(tree.nodes).filter(n => n.parentId === tree.rootId && n.createdBy === 'chancellor')).toHaveLength(2)
  })

  it('重规划回复非法时给出可读兜底，不铺裸文本', async () => {
    const coordinator = new CoordinatorAgent()
    const tree = createTree('debate-goal-bad', '议题', '计划', 'chancellor')
    const speeches: Speech[] = []

    stub.reply = '本轮暂无新任务可加。'

    await (coordinator as any).requestGoalReplanForTree(
      { id: 'chancellor', name: '丞相', llm: WORKER.llm, systemPrompt: '你是丞相' } as any,
      tree, '目标摘要', '议题',
      (s: Speech) => speeches.push(s),
      (id: string) => speeches.find(s => s.id === id)!,
      (llm: any) => llm
    )

    const speech = speeches[speeches.length - 1]
    expect(speech.content).not.toContain('本轮暂无新任务可加。')
    expect(speech.content).toContain('未能解析')
    expect(speech.status).toBe('completed')
  })
})
