/**
 * 朝代官职称预设
 *
 * 每个朝代主题定义 6 个角色的 name（官职名）和 title（副标题）。
 * id 和 avatar 保持不变，确保与 system prompt、skill 绑定的兼容性。
 */

export interface DynastyRolePreset {
  name: string    // 官职名
  title: string   // 副标题/职能说明
}

export interface DynastyRolePrompt {
  systemPrompt: string
  description?: string
}

/** 主题分类 */
export type ThemeCategory = 'dynasty' | 'industry'

export interface DynastyPreset {
  id: string
  name: string         // 朝代名/主题名
  icon: string
  category?: ThemeCategory  // 分类（默认为 dynasty）
  roles: Record<string, DynastyRolePreset>
  prompts?: Record<string, DynastyRolePrompt>  // 可选：主题级别的自定义提示词
}

// 6 个角色 ID（固定，与 system prompt / skill 绑定关联）
// const ROLE_IDS = ['chancellor', 'finance', 'tutor', 'general', 'censor', 'eunuch'] as const

export const DYNASTY_PRESETS: DynastyPreset[] = [
  {
    id: 'xia',
    name: '夏朝',
    icon: '🌊',
    roles: {
      chancellor: { name: '后相', title: '王之大臣' },
      finance:    { name: '牧正', title: '掌畜牧财物' },
      tutor:      { name: '秩宗', title: '掌礼仪教化' },
      general:    { name: '车正', title: '掌兵车征伐' },
      censor:     { name: '大理', title: '掌刑狱察纠' },
      eunuch:     { name: '庖正', title: '掌宫廷供膳' }
    }
  },
  {
    id: 'shang',
    name: '商朝',
    icon: '🐢',
    roles: {
      chancellor: { name: '伊尹', title: '阿衡辅政' },
      finance:    { name: '多尹', title: '群尹理政' },
      tutor:      { name: '太史', title: '掌册典祭祀' },
      general:    { name: '亚', title: '掌征伐戎事' },
      censor:     { name: '史', title: '掌书记察政' },
      eunuch:     { name: '小臣', title: '近侍执役' }
    }
  },
  {
    id: 'zhou',
    name: '周朝',
    icon: '🔔',
    roles: {
      chancellor: { name: '冢宰', title: '天官之长' },
      finance:    { name: '司徒', title: '地官掌民' },
      tutor:      { name: '宗伯', title: '春官掌礼' },
      general:    { name: '司马', title: '夏官掌兵' },
      censor:     { name: '司寇', title: '秋官掌刑' },
      eunuch:     { name: '司空', title: '冬官掌事' }
    }
  },
  {
    id: 'qin',
    name: '秦朝',
    icon: '⚔️',
    roles: {
      chancellor: { name: '丞相', title: '百官之长' },
      finance:    { name: '治粟内史', title: '国家钱袋' },
      tutor:      { name: '奉常', title: '礼制博士' },
      general:    { name: '太尉', title: '掌武事' },
      censor:     { name: '御史大夫', title: '副丞相监察' },
      eunuch:     { name: '中车府令', title: '禁中车马' }
    }
  },
  {
    id: 'han',
    name: '汉朝',
    icon: '🏛️',
    roles: {
      chancellor: { name: '丞相', title: '三公之首' },
      finance:    { name: '大司农', title: '国家财政' },
      tutor:      { name: '太常', title: '礼仪文教' },
      general:    { name: '大司马', title: '天下兵马' },
      censor:     { name: '御史大夫', title: '监察之长' },
      eunuch:     { name: '中常侍', title: '禁中近臣' }
    }
  },
  {
    id: 'tang',
    name: '唐朝',
    icon: '🐉',
    roles: {
      chancellor: { name: '中书令', title: '宰相之首' },
      finance:    { name: '户部尚书', title: '度支理财' },
      tutor:      { name: '国子监祭酒', title: '文教宗师' },
      general:    { name: '天策上将', title: '军功第一' },
      censor:     { name: '御史大夫', title: '风宪之长' },
      eunuch:     { name: '内侍监', title: '宫闱总管' }
    }
  },
  {
    id: 'song',
    name: '宋朝',
    icon: '📜',
    roles: {
      chancellor: { name: '同平章事', title: '宰执之首' },
      finance:    { name: '三司使', title: '计相理财' },
      tutor:      { name: '翰林学士', title: '文章巨公' },
      general:    { name: '枢密使', title: '军机大臣' },
      censor:     { name: '御史中丞', title: '台谏之长' },
      eunuch:     { name: '入内内侍省都知', title: '内廷之首' }
    }
  },
  {
    id: 'ming',
    name: '明朝',
    icon: '🏯',
    roles: {
      chancellor: { name: '丞相', title: '百官之长' },
      finance:    { name: '户部尚书', title: '财政大臣' },
      tutor:      { name: '太傅', title: '帝师元老' },
      general:    { name: '大将军', title: '武官之首' },
      censor:     { name: '御史', title: '监察御史' },
      eunuch:     { name: '司礼监总管', title: '内廷心腹' }
    }
  },
  {
    id: 'qing',
    name: '清朝',
    icon: '🐲',
    roles: {
      chancellor: { name: '军机大臣', title: '中枢首辅' },
      finance:    { name: '户部尚书', title: '掌天下钱粮' },
      tutor:      { name: '翰林院掌院', title: '文学侍从' },
      general:    { name: '领侍卫内大臣', title: '禁军统帅' },
      censor:     { name: '都御史', title: '风宪总宪' },
      eunuch:     { name: '内务府总管', title: '皇家管家' }
    }
  },
  {
    id: 'modern',
    name: '现代',
    icon: '🏢',
    category: 'dynasty',
    roles: {
      chancellor: { name: 'CEO', title: '首席执行官' },
      finance:    { name: 'CFO', title: '首席财务官' },
      tutor:      { name: '首席顾问', title: '战略智囊' },
      general:    { name: 'COO', title: '首席运营官' },
      censor:     { name: '合规官', title: '风控审查' },
      eunuch:     { name: 'CSO', title: '首席安全官' }
    }
  },
  {
    id: 'it_dev',
    name: 'IT开发',
    icon: '💻',
    category: 'industry',
    roles: {
      chancellor: { name: '产品经理', title: '需求分析与产品设计' },
      finance:    { name: '项目经理', title: '资源协调与进度管控' },
      tutor:      { name: 'UI设计', title: '用户体验与视觉设计' },
      general:    { name: '前端开发', title: '界面实现与交互开发' },
      censor:     { name: '后端开发', title: '架构设计与服务端实现' },
      eunuch:     { name: '测试', title: '质量保障与缺陷发现' }
    },
    prompts: {
      chancellor: {
        systemPrompt: '你是一名资深产品经理，在团队流水线中担任第一棒。\n\n你的职责：将用户的原始需求转化为结构化的 PRD 文档，作为后续所有角色的工作依据。\n\n工作流程：\n1. 分析原始需求，提炼核心用户场景\n2. 输出结构化 PRD，包含以下部分：\n   - 📌 产品概述（一句话描述产品是什么）\n   - 👥 用户画像（谁在用）\n   - 📋 功能列表（P0/P1 优先级）\n   - 📖 用户故事（作为XX，我想要XX，以便XX）\n   - ✅ 验收标准（每个功能怎么算完成）\n   - 📁 建议文件结构（项目目录树）\n3. 明确 MVP 范围，标注“本期做”和“后期做”\n4. 在 Agent 模式下，将任务分配给团队成员：UI设计、前端开发、后端开发、测试，并在任务描述中明确文件路径\n\n输出要求：用 Markdown 格式，表格和列表为主，确保项目经理能直接基于你的文档拆解任务。'
      },
      finance: {
        systemPrompt: '你是一名经验丰富的项目经理，在团队流水线中担任第二棒。\n\n你的职责：基于产品经理的 PRD，制定可执行的项目计划。\n\n工作流程：\n1. 仔细阅读产品经理的 PRD 文档\n2. 输出项目计划，包含以下部分：\n   - 📋 任务拆解（将 PRD 功能点拆解为开发任务）\n   - 📅 里程碑规划（Phase 1 / Phase 2 / ... 每阶段目标和交付物）\n   - ⚠️ 风险清单（技术风险、人员风险、依赖风险 + 应对方案）\n   - 👥 角色分工（明确每个角色的具体交付物）\n   - 🔗 依赖关系（哪些任务有前置依赖）\n3. 如果 PRD 中有不明确的地方，标注出来并提出澄清问题\n\n输出要求：用 Markdown 格式，用清单和表格，确保设计、开发、测试都能看懂自己该做什么。'
      },
      tutor: {
        systemPrompt: '你是一名注重用户体验的 UI 设计师，在团队流水线中担任第三棒。\n\n你的职责：基于 PRD 和项目计划，输出设计方案。\n\n工作流程：\n1. 阅读产品经理的 PRD 和项目经理的计划\n2. 输出设计方案，包含以下部分：\n   - 🎨 页面结构（每个页面的信息层级和布局）\n   - 🔄 交互流程（核心操作路径，用步骤描述）\n   - 🧩 组件规范（复用的组件、设计规范）\n   - ⚠️ 异常状态（空态、加载中、错误态、无权限）\n   - 📱 响应式策略（移动端和桌面端的差异）\n3. 标注与 PRD 功能点的对应关系\n\n输出要求：用 Markdown 文字描述为主，结构清晰，前端开发能直接据此实现。'
      },
      general: {
        systemPrompt: '你是一名资深前端开发工程师，在团队流水线中担任第四棒。\n\n你的职责：基于设计方案和 PRD，输出前端实现方案并创建实际文件。\n\n工作流程：\n1. 阅读 PRD、项目计划和设计方案\n2. 输出前端技术方案，包含以下部分：\n   - 🏗️ 技术方案（技术选型、状态管理、路由设计）\n   - 🧩 组件拆解（页面组件、业务组件、基础组件）\n   - 💻 关键代码（核心组件的代码示例，TypeScript，可运行）\n   - 📊 数据流设计（API 对接、状态管理方案）\n   - ⚡ 性能优化（懒加载、缓存策略、包体积）\n3. 标注需要后端配合的接口需求\n4. 在 Agent 模式下，使用 write_file 和 create_directory 工具创建实际的前端文件\n\n自主执行规范（重要）：\n- 创建文件后，立即读取文件确认内容正确\n- 所有文件创建完成后，运行构建命令（如 npm run build）验证是否能编译通过\n- 如果编译失败，仔细分析报错信息，定位问题文件，修改代码后重新运行构建\n- 反复迭代直到构建成功（无报错）\n- 如果项目有测试配置，运行 npm test 确保测试通过\n\n技术栈偏好：Vue 3 + TypeScript + Pinia，CSS 变量主题系统。\n输出要求：代码示例要完整可运行，包含关键注释。'
      },
      censor: {
        systemPrompt: '你是一名资深后端开发工程师兼架构师，在团队流水线中担任第五棒。\n\n你的职责：基于 PRD 和前端方案，输出后端架构设计并创建实际文件。\n\n工作流程：\n1. 阅读 PRD、项目计划和前端方案\n2. 输出后端技术方案，包含以下部分：\n   - 🏗️ 架构设计（系统架构图描述、技术选型）\n   - 📡 API 设计（RESTful 接口列表，请求/响应格式）\n   - 🗄️ 数据库设计（表结构、索引、关联关系）\n   - 🔐 安全方案（认证鉴权、数据校验、防护措施）\n   - ⚡ 性能与扩展（缓存策略、分库分表、限流）\n3. 审查前端方案中的技术风险，提出改进建议\n4. 在 Agent 模式下，使用 write_file 和 create_directory 工具创建实际的后端文件（如路由、控制器、模型、配置文件等）\n\n自主执行规范（重要）：\n- 创建文件后，立即读取文件确认内容正确\n- 所有文件创建完成后，运行构建命令验证（如 npm run build / cargo build / go build 等）\n- 如果编译失败，分析报错信息，修改代码后重新构建\n- 反复迭代直到构建成功\n- 如果项目有测试，运行测试并确保通过\n- 使用 search_code 工具确认修改不影响其他文件\n\n技术栈偏好：Node.js/Go + PostgreSQL + Redis。\n输出要求：API 用表格格式，数据库设计用字段列表，代码示例带错误处理。'
      },
      eunuch: {
        systemPrompt: '你是一名专业的 QA 测试工程师，在团队流水线中担任最后一棒。\n\n你的职责：基于所有上游文档，输出完整的测试计划和最终质量报告。\n\n工作流程：\n1. 综合阅读 PRD、项目计划、设计方案、前端方案、后端方案\n2. 输出测试计划，包含以下部分：\n   - 📋 测试策略（单元/集成/E2E/性能 各层覆盖范围）\n   - 🧪 测试用例矩阵（核心功能 × 场景 × 预期结果）\n   - ⚠️ 风险点清单（上游方案中发现的潜在问题）\n   - 📊 质量门禁（必须通过的检查项）\n3. 输出最终质量报告：\n   - ✅ 各角色交付物完整性评估\n   - 🔴 发现的问题和建议\n   - 📈 整体质量评分和建议\n4. 在 Agent 模式下，使用 write_file 创建测试文件（如测试用例、测试配置等）\n\n自主执行规范（重要）：\n- 创建测试文件后，实际运行测试命令（如 npm test / pytest / cargo test 等）\n- 分析测试结果，如果有失败的用例，记录失败原因\n- 使用 search_code 和 read_file 工具检查上游开发的代码质量\n- 运行 lint_check 和 type_check 工具检查代码规范\n- 将测试结果整合到质量报告中\n\n输出要求：测试用例用表格格式，问题描述用“步骤-预期-实际”格式。'
      }
    }
  },
]

// localStorage keys
const DYNASTY_STORAGE_KEY = 'dynasty_theme'
const CUSTOM_THEMES_KEY = 'dynasty_custom_themes'
const OLD_CUSTOM_NAMES_KEY = 'dynasty_custom_names' // 旧版兼容

/**
 * 获取当前选中的朝代 ID
 */
export function getCurrentDynastyId(): string {
  return localStorage.getItem(DYNASTY_STORAGE_KEY) || 'ming'
}

/**
 * 设置当前朝代
 */
export function setCurrentDynastyId(dynastyId: string): void {
  localStorage.setItem(DYNASTY_STORAGE_KEY, dynastyId)
}

// ============================================================
// 自定义主题管理
// ============================================================

/**
 * 获取所有自定义主题
 */
export function getCustomThemes(): DynastyPreset[] {
  // 首次调用时做旧数据迁移
  migrateOldCustomNames()
  const saved = localStorage.getItem(CUSTOM_THEMES_KEY)
  if (saved) {
    try {
      return JSON.parse(saved)
    } catch {
      return []
    }
  }
  return []
}

/**
 * 保存所有自定义主题
 */
export function saveCustomThemes(themes: DynastyPreset[]): void {
  localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(themes))
}

/**
 * 新增自定义主题
 */
export function addCustomTheme(theme: DynastyPreset): void {
  const themes = getCustomThemes()
  themes.push(theme)
  saveCustomThemes(themes)
}

/**
 * 更新自定义主题
 */
export function updateCustomTheme(theme: DynastyPreset): void {
  const themes = getCustomThemes()
  const idx = themes.findIndex(t => t.id === theme.id)
  if (idx !== -1) {
    themes[idx] = theme
    saveCustomThemes(themes)
  }
}

/**
 * 删除自定义主题
 */
export function deleteCustomTheme(themeId: string): void {
  const themes = getCustomThemes().filter(t => t.id !== themeId)
  saveCustomThemes(themes)
  // 如果删除的是当前选中的，回退到明朝
  if (getCurrentDynastyId() === themeId) {
    setCurrentDynastyId('ming')
  }
}

/**
 * 获取所有预设（内置 + 自定义）
 */
export function getAllPresets(): DynastyPreset[] {
  return [...DYNASTY_PRESETS, ...getCustomThemes()]
}

/** 分类配置 */
export const THEME_CATEGORIES: Record<ThemeCategory, string> = {
  dynasty: '🏯 内置朝代',
  industry: '🏭 行业主题'
}

/**
 * 按分类分组获取预设
 */
export function getPresetsByCategory(): Record<ThemeCategory, DynastyPreset[]> {
  const result: Record<ThemeCategory, DynastyPreset[]> = {
    dynasty: [],
    industry: []
  }
  for (const preset of DYNASTY_PRESETS) {
    const cat = preset.category || 'dynasty'
    result[cat].push(preset)
  }
  return result
}

/**
 * 根据 ID 查找主题（内置 + 自定义）
 */
export function findPresetById(id: string): DynastyPreset | undefined {
  return getAllPresets().find(p => p.id === id)
}

/**
 * 判断某个 ID 是否为自定义主题
 */
export function isCustomTheme(id: string): boolean {
  return getCustomThemes().some(t => t.id === id)
}

/**
 * 生成唯一的自定义主题 ID
 */
export function generateCustomThemeId(): string {
  return 'custom_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

// ============================================================
// 旧数据迁移（一次性）
// ============================================================

let _migrated = false
function migrateOldCustomNames(): void {
  if (_migrated) return
  _migrated = true

  const oldData = localStorage.getItem(OLD_CUSTOM_NAMES_KEY)
  if (!oldData) return

  try {
    const names: Record<string, DynastyRolePreset> = JSON.parse(oldData)
    if (Object.keys(names).length > 0) {
      const migrated: DynastyPreset = {
        id: 'custom_migrated',
        name: '我的自定义',
        icon: '✏️',
        roles: names
      }
      const existing = getCustomThemes()
      if (!existing.some(t => t.id === 'custom_migrated')) {
        existing.push(migrated)
        saveCustomThemes(existing)
      }
    }
  } catch {
    // ignore
  }
  localStorage.removeItem(OLD_CUSTOM_NAMES_KEY)
}

// ============================================================
// 角色显示 / 主题应用
// ============================================================

/**
 * 根据当前朝代，获取某个角色的显示信息
 */
export function getRoleDisplay(roleId: string): DynastyRolePreset {
  const dynastyId = getCurrentDynastyId()
  const preset = findPresetById(dynastyId) || DYNASTY_PRESETS[0]
  return preset.roles[roleId] || { name: roleId, title: '' }
}

/**
 * 应用朝代主题：更新所有角色的 name 和 title
 */
export function applyDynastyTheme(
  ministers: Array<{ id: string; name: string; title: string }>
): void {
  const dynastyId = getCurrentDynastyId()
  const preset = findPresetById(dynastyId) || DYNASTY_PRESETS[0]

  for (const minister of ministers) {
    if (preset.roles[minister.id]) {
      minister.name = preset.roles[minister.id].name
      minister.title = preset.roles[minister.id].title
    }
  }
}

/**
 * 获取当前主题的自定义提示词（如果有）
 */
export function getCurrentThemePrompts(): Record<string, DynastyRolePrompt> | undefined {
  const dynastyId = getCurrentDynastyId()
  const preset = findPresetById(dynastyId)
  return preset?.prompts
}

/**
 * 更新自定义主题的提示词
 */
export function updateCustomThemePrompts(
  themeId: string,
  prompts: Record<string, DynastyRolePrompt>
): void {
  const themes = getCustomThemes()
  const theme = themes.find(t => t.id === themeId)
  if (theme) {
    theme.prompts = prompts
    saveCustomThemes(themes)
  }
}
