/**
 * 子 Agent 注册表 — 与 6 角色正交的执行策略
 *
 * 角色（Role）回答"谁来做"：身份 + 模型 + system prompt
 * 子 Agent（SubAgent）回答"怎么做"：行为规范 + 工具约束 + 输出格式
 *
 * 一个角色执行时可以"戴上"不同的子 Agent 帽子：
 * - 前端开发 + code-reviewer = 做代码审查
 * - 御史 + security-auditor = 做安全审计
 *
 * 用户可在 `.chaotang/subagents/*.md` 中用 Markdown 定义自定义子 Agent。
 * 系统内置 3 个默认子 Agent（code-reviewer, security-auditor, test-specialist）。
 *
 * 设计依据：编码能力三期 Phase A。
 */

// ============ 类型 ============

export interface SubAgentProfile {
  /** 唯一标识 */
  id: string
  /** 显示名称 */
  name: string
  /** 简短描述（供丞相选择时参考） */
  description: string
  /** 追加到角色 system prompt 之后的行为指令 */
  systemPromptAddon: string
  /** 工具白名单（为空 = 不限制，使用角色默认工具） */
  toolWhitelist?: string[]
  /** 工具黑名单（从默认工具中排除） */
  toolBlacklist?: string[]
  /** 输出格式要求（如 "以表格形式输出审查结果"） */
  outputFormat?: string
  /** 覆盖角色默认模型（可选） */
  modelOverride?: string
  /** 分类标签（如 "review", "security", "test"） */
  tags: string[]
  /** 来源：'builtin' | 'custom' */
  source: 'builtin' | 'custom'
}

// ============ 默认子 Agent ============

const BUILTIN_SUBAGENTS: SubAgentProfile[] = [
  {
    id: 'code-reviewer',
    name: '代码审查员',
    description: '专注于代码质量审查：检查代码风格、潜在 bug、性能问题、可维护性。只做分析不修改。',
    systemPromptAddon: `## 代码审查模式

你当前以"代码审查员"身份执行任务。请遵循以下规范：

### 审查维度
1. **正确性**：逻辑是否正确，边界条件是否处理
2. **安全性**：是否有注入风险、敏感信息泄露、权限越界
3. **性能**：是否有不必要的循环、内存泄漏、N+1 查询
4. **可维护性**：命名是否清晰、函数是否过长、是否有重复代码
5. **代码风格**：是否遵循项目规范（如有 AGENTS.md 则以其为准）

### 输出格式
- 按文件逐个审查
- 每个问题标注严重程度：🔴 严重 / 🟡 建议 / 🟢 可选
- 给出具体行号和修改建议
- 最后给出整体评价和优先修复建议

### 约束
- 只读取和分析代码，不要修改文件
- 不要执行任何命令
- 聚焦于实际风险，不要纠结于无关紧要的风格偏好`,
    toolBlacklist: ['write_file', 'search_replace', 'create_directory', 'execute_command'],
    outputFormat: '按文件分节的审查报告，每个问题标注严重程度和行号',
    tags: ['review', 'quality', 'read-only'],
    source: 'builtin'
  },
  {
    id: 'security-auditor',
    name: '安全审计员',
    description: '专注于安全漏洞扫描：XSS、CSRF、SQL注入、认证鉴权、敏感信息泄露。',
    systemPromptAddon: `## 安全审计模式

你当前以"安全审计员"身份执行任务。请遵循以下规范：

### 审计维度
1. **注入攻击**：SQL 注入、XSS、命令注入、路径遍历
2. **认证鉴权**：身份验证是否完备、权限检查是否遗漏
3. **敏感数据**：密钥/密码是否硬编码、日志是否泄露敏感信息
4. **依赖安全**：是否使用已知有漏洞的依赖版本
5. **配置安全**：CORS、CSP、HTTPS 等安全配置是否合理

### 输出格式
- 按安全风险等级排序：🔴 高危 / 🟡 中危 / 🟢 低危
- 每个漏洞包含：位置（文件+行号）、描述、攻击场景、修复建议
- 最后给出安全评估总结

### 约束
- 只读取和分析代码，不要修改文件
- 不要执行任何命令
- 重点关注实际可利用的安全风险`,
    toolBlacklist: ['write_file', 'search_replace', 'create_directory', 'execute_command'],
    outputFormat: '按风险等级排序的安全审计报告',
    tags: ['security', 'audit', 'read-only'],
    source: 'builtin'
  },
  {
    id: 'test-specialist',
    name: '测试专家',
    description: '专注于编写和运行测试：单元测试、集成测试、边界用例。会实际创建测试文件并运行。',
    systemPromptAddon: `## 测试专家模式

你当前以"测试专家"身份执行任务。请遵循以下规范：

### 工作流程
1. 分析目标代码的结构和逻辑分支
2. 识别需要测试的关键路径和边界条件
3. 编写测试用例（优先使用项目已有的测试框架）
4. 运行测试并确认全部通过
5. 如果有失败，分析原因并修复测试代码

### 测试策略
- 先写正向用例（正常输入 → 预期输出）
- 再写反向用例（异常输入 → 错误处理）
- 补充边界用例（空值、极大值、并发等）
- 如有 UI 组件，测试渲染和交互

### 输出格式
- 列出测试文件和用例清单
- 标注每个测试覆盖的场景
- 给出测试运行结果（通过/失败/跳过）
- 如有未覆盖的代码路径，说明原因

### 约束
- 只创建测试文件，不要修改源代码
- 如果测试失败是因为源代码 bug，记录但不修复`,
    toolWhitelist: ['read_file', 'read_directory', 'search_code', 'write_file', 'execute_command', 'run_tests'],
    outputFormat: '测试报告：用例清单 + 运行结果 + 覆盖率说明',
    tags: ['test', 'quality'],
    source: 'builtin'
  }
]

// ============ Frontmatter 解析 ============

/**
 * 解析 Markdown frontmatter（简易实现，不依赖外部库）
 *
 * 支持格式：
 * ```
 * ---
 * key: value
 * tags: review, security
 * toolWhitelist: read_file, search_code
 * ---
 * body content here
 * ```
 */
function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {}
  let body = content

  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (fmMatch) {
    const frontmatter = fmMatch[1]
    body = fmMatch[2]

    for (const line of frontmatter.split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim()
        const value = line.slice(colonIdx + 1).trim()
        if (key && value) {
          meta[key] = value
        }
      }
    }
  }

  return { meta, body }
}

/**
 * 将 frontmatter 元数据转换为 SubAgentProfile 字段
 */
function metaToProfile(id: string, meta: Record<string, string>, body: string): SubAgentProfile {
  const parseList = (val: string | undefined): string[] | undefined => {
    if (!val) return undefined
    return val.split(',').map(s => s.trim()).filter(Boolean)
  }

  return {
    id,
    name: meta['name'] || id,
    description: meta['description'] || '',
    systemPromptAddon: body.trim(),
    toolWhitelist: parseList(meta['toolWhitelist'] || meta['tool_whitelist']),
    toolBlacklist: parseList(meta['toolBlacklist'] || meta['tool_blacklist']),
    outputFormat: meta['outputFormat'] || meta['output_format'],
    modelOverride: meta['model'] || meta['modelOverride'],
    tags: parseList(meta['tags']) || [],
    source: 'custom'
  }
}

// ============ 注册表 ============

class SubAgentRegistry {
  /** 已注册的子 Agent：id → profile */
  private profiles = new Map<string, SubAgentProfile>()
  /** 是否已初始化默认子 Agent */
  private builtinsLoaded = false

  constructor() {
    this.loadBuiltins()
  }

  /**
   * 加载内置子 Agent
   */
  private loadBuiltins(): void {
    if (this.builtinsLoaded) return
    for (const sa of BUILTIN_SUBAGENTS) {
      this.profiles.set(sa.id, sa)
    }
    this.builtinsLoaded = true
  }

  /**
   * 扫描工作目录下的 `.chaotang/subagents/*.md` 文件
   * 解析并注册自定义子 Agent
   */
  async scanSubAgents(workingDirectory: string): Promise<SubAgentProfile[]> {
    if (!window.electronAPI?.readDirectory || !window.electronAPI?.readFile) {
      return []
    }

    const subagentsDir = `${workingDirectory.replace(/[\\/]+$/, '')}/.chaotang/subagents`
    const loaded: SubAgentProfile[] = []

    try {
      const dirResult = await window.electronAPI.readDirectory(subagentsDir)
      if (!dirResult.success || !dirResult.items) return []

      for (const item of dirResult.items) {
        if (item.type !== 'file' || !item.name.endsWith('.md')) continue

        const filePath = `${subagentsDir}/${item.name}`
        const fileResult = await window.electronAPI.readFile(filePath)
        if (!fileResult.success || !fileResult.content) continue

        // 从文件名推导 ID（去掉 .md 后缀）
        const id = `custom-${item.name.replace(/\.md$/, '').replace(/[^a-zA-Z0-9_-]/g, '-')}`

        const { meta, body } = parseFrontmatter(fileResult.content)
        const profile = metaToProfile(id, meta, body)
        profile.source = 'custom'

        this.profiles.set(id, profile)
        loaded.push(profile)
      }
    } catch {
      // 目录不存在或读取失败不影响主流程
    }

    return loaded
  }

  /**
   * 获取所有已注册的子 Agent
   */
  getSubAgents(): SubAgentProfile[] {
    return Array.from(this.profiles.values())
  }

  /**
   * 按 ID 获取子 Agent
   */
  getSubAgent(id: string): SubAgentProfile | undefined {
    return this.profiles.get(id)
  }

  /**
   * 按标签筛选子 Agent
   */
  getByTag(tag: string): SubAgentProfile[] {
    const lower = tag.toLowerCase()
    return this.getSubAgents().filter(sa =>
      sa.tags.some(t => t.toLowerCase() === lower)
    )
  }

  /**
   * 生成子 Agent 列表摘要（注入丞相提示词）
   */
  getListSummary(): string {
    const agents = this.getSubAgents()
    if (agents.length === 0) return ''

    const lines = agents.map(sa => {
      const tags = sa.tags.length > 0 ? ` [${sa.tags.join(', ')}]` : ''
      const source = sa.source === 'builtin' ? '（内置）' : '（自定义）'
      return `- **${sa.id}**（${sa.name}）${source}${tags}: ${sa.description}`
    })

    return `\n\n=== 可用子 Agent（执行策略） ===\n以下是可用的子 Agent，在分配任务时可通过 subAgentId 指定：\n${lines.join('\n')}\n=== 子 Agent 列表结束 ===`
  }

  /**
   * 过滤工具定义（应用白名单/黑名单）
   */
  filterTools(
    toolDefs: import('@/types').ToolDefinition[],
    profile: SubAgentProfile
  ): import('@/types').ToolDefinition[] {
    let filtered = toolDefs

    // 白名单：只保留列表中的工具
    if (profile.toolWhitelist && profile.toolWhitelist.length > 0) {
      const whitelist = new Set(profile.toolWhitelist)
      filtered = filtered.filter(td => whitelist.has(td.function.name))
    }

    // 黑名单：排除列表中的工具
    if (profile.toolBlacklist && profile.toolBlacklist.length > 0) {
      const blacklist = new Set(profile.toolBlacklist)
      filtered = filtered.filter(td => !blacklist.has(td.function.name))
    }

    return filtered
  }

  /**
   * 清除所有自定义子 Agent（保留内置）
   */
  clearCustom(): void {
    for (const [id, profile] of this.profiles) {
      if (profile.source === 'custom') {
        this.profiles.delete(id)
      }
    }
  }

  /**
   * 手动注册一个子 Agent（用于测试或动态添加）
   */
  register(profile: SubAgentProfile): void {
    this.profiles.set(profile.id, profile)
  }

  /**
   * 获取总数
   */
  getCount(): number {
    return this.profiles.size
  }
}

/** 全局子 Agent 注册表单例 */
export const subAgentRegistry = new SubAgentRegistry()
