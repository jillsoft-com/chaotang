/**
 * 角色-Skill 默认绑定配置
 *
 * 定义每个角色初始绑定的 Skills，以及每个 Skill 的元信息。
 * 在应用初始化时调用 initializeSkills() 注册所有 Skills。
 */

import type { Skill } from '@/types'
import { skillRegistry } from './registry'
import {
  webSearchTool, knowledgeQueryTool, calculateTool,
  readFileTool, summarizeResultsTool,
  writeFileTool, createDirectoryTool, readDirectoryTool, readDocumentTool, executeCommandTool,
  searchCodeTool, gitOperationTool, runTestsTool,
  saveMemoryTool, searchMemoryTool,
  factCheckTool, traceSourceTool, chartGeneratorTool, historySearchTool,
  lintCheckTool, typeCheckTool, refactorRenameTool,
  webSearchHandler, knowledgeQueryHandler, calculateHandler,
  readFileHandler, summarizeResultsHandler,
  writeFileHandler, createDirectoryHandler, readDirectoryHandler, readDocumentHandler, executeCommandHandler,
  searchCodeHandler, gitOperationHandler, runTestsHandler,
  saveMemoryHandler, searchMemoryHandler,
  factCheckHandler, traceSourceHandler, chartGeneratorHandler, historySearchHandler,
  lintCheckHandler, typeCheckHandler, refactorRenameHandler
} from '@/services/tools/handlers/minimal'
import {
  browserToolDefinitions, browserToolHandlers
} from '@/services/browser/browser-tools'

// ============ Skill 定义 ============

const allSkills: Array<{ skill: Skill; handlers: Record<string, any> }> = [
  {
    skill: {
      id: 'web_search',
      name: '网络搜索',
      description: '搜索互联网上的信息，获取实时数据、新闻和资料',
      icon: '🔍',
      category: 'information',
      tools: [webSearchTool],
      config: { timeout: 15000, maxCallsPerRound: 3 },
      enabled: true
    },
    handlers: { web_search: webSearchHandler }
  },
  {
    skill: {
      id: 'knowledge_base',
      name: '知识库检索',
      description: '从本地知识库中检索相关信息和资料',
      icon: '📚',
      category: 'information',
      tools: [knowledgeQueryTool],
      config: { timeout: 10000 },
      enabled: true
    },
    handlers: { knowledge_query: knowledgeQueryHandler }
  },
  {
    skill: {
      id: 'calculator',
      name: '计算器',
      description: '进行数学计算，包括基本运算、百分比、幂运算等',
      icon: '🧮',
      category: 'analysis',
      tools: [calculateTool],
      config: { timeout: 5000 },
      enabled: true
    },
    handlers: { calculate: calculateHandler }
  },
  {
    skill: {
      id: 'file_reader',
      name: '文件读取',
      description: '读取本地文本文件的内容',
      icon: '📄',
      category: 'system',
      tools: [readFileTool],
      config: { timeout: 10000, requireConfirmation: true },
      enabled: true
    },
    handlers: { read_file: readFileHandler }
  },
  {
    skill: {
      id: 'task_coordinator',
      name: '任务协调',
      description: '汇总多个信息源的结果，生成综合摘要报告',
      icon: '📋',
      category: 'generation',
      tools: [summarizeResultsTool],
      config: { timeout: 30000 },
      enabled: true
    },
    handlers: { summarize_results: summarizeResultsHandler }
  },
  {
    skill: {
      id: 'file_ops',
      name: '文件操作',
      description: '写入文件、创建目录、读取目录内容，用于保存报告和管理文件',
      icon: '📁',
      category: 'system',
      tools: [writeFileTool, createDirectoryTool, readDirectoryTool],
      config: { timeout: 10000, requireConfirmation: true },
      enabled: true
    },
    handlers: {
      write_file: writeFileHandler,
      create_directory: createDirectoryHandler,
      read_directory: readDirectoryHandler
    }
  },
  {
    skill: {
      id: 'document_reader',
      name: '文档解析',
      description: '读取 Office 文档和 PDF 文件的文本内容，支持 doc/docx/pdf/xls/xlsx/pptx 格式',
      icon: '📑',
      category: 'system',
      tools: [readDocumentTool],
      config: { timeout: 30000, requireConfirmation: true },
      enabled: true
    },
    handlers: { read_document: readDocumentHandler }
  },
  {
    skill: {
      id: 'command_executor',
      name: '命令行',
      description: '执行 PowerShell/CMD/bash 命令，适合运行构建、测试、git 操作、环境检查等',
      icon: '💻',
      category: 'system',
      tools: [executeCommandTool],
      config: { timeout: 60000, requireConfirmation: true },
      enabled: true
    },
    handlers: { execute_command: executeCommandHandler }
  },
  {
    skill: {
      id: 'code_search',
      name: '代码搜索',
      description: '在项目中搜索代码内容，支持普通文本和正则表达式，类似 grep 命令',
      icon: '🔎',
      category: 'system',
      tools: [searchCodeTool],
      config: { timeout: 30000 },
      enabled: true
    },
    handlers: { search_code: searchCodeHandler }
  },
  {
    skill: {
      id: 'git_ops',
      name: 'Git 操作',
      description: '执行 Git 操作：查看状态、差异、日志、分支、提交等',
      icon: '🌿',
      category: 'system',
      tools: [gitOperationTool],
      config: { timeout: 30000, requireConfirmation: true },
      enabled: true
    },
    handlers: { git_operation: gitOperationHandler }
  },
  {
    skill: {
      id: 'test_runner',
      name: '测试运行',
      description: '运行项目测试套件，自动检测测试框架，支持反复运行直到通过',
      icon: '🧪',
      category: 'system',
      tools: [runTestsTool],
      config: { timeout: 120000 },
      enabled: true
    },
    handlers: { run_tests: runTestsHandler }
  },
  {
    skill: {
      id: 'memory',
      name: '持久记忆',
      description: '跨会话记忆系统，可以保存和搜索项目知识、用户偏好、重要决策等',
      icon: '🧠',
      category: 'system',
      tools: [saveMemoryTool, searchMemoryTool],
      config: { timeout: 5000 },
      enabled: true
    },
    handlers: { save_memory: saveMemoryHandler, search_memory: searchMemoryHandler }
  },
  {
    skill: {
      id: 'browser',
      name: '浏览器自动化',
      description: '打开网页、截图、获取页面结构、点击元素、填写表单、执行 JavaScript',
      icon: '🌐',
      category: 'information',
      tools: browserToolDefinitions,
      config: { timeout: 30000 },
      enabled: true
    },
    handlers: browserToolHandlers
  },
  // ============ 角色专属 Skill（Sprint A - #4） ============
  {
    skill: {
      id: 'fact_checking',
      name: '事实核查',
      description: '验证说法真伪、交叉验证信息源、追溯来源。御史专属能力。',
      icon: '⚖️',
      category: 'verification',
      tools: [factCheckTool, traceSourceTool],
      config: { timeout: 20000, maxCallsPerRound: 5 },
      enabled: true
    },
    handlers: { fact_check: factCheckHandler, trace_source: traceSourceHandler }
  },
  {
    skill: {
      id: 'data_visualization',
      name: '数据可视化',
      description: '将数据转化为表格、排行榜、预算分配、进度条、矩阵等可视化文本图表。户部尚书专属能力。',
      icon: '📊',
      category: 'analysis',
      tools: [chartGeneratorTool],
      config: { timeout: 10000 },
      enabled: true
    },
    handlers: { generate_chart: chartGeneratorHandler }
  },
  {
    skill: {
      id: 'history_cases',
      name: '历史案例库',
      description: '检索历史朝议记录，查找过去的相关案例和经验。太傅专属能力，便于"引经据典"。',
      icon: '📜',
      category: 'information',
      tools: [historySearchTool],
      config: { timeout: 10000 },
      enabled: true
    },
    handlers: { history_search: historySearchHandler }
  },
  // ============ 代码质量 Skill（Sprint B - #11） ============
  {
    skill: {
      id: 'code_quality',
      name: '代码质量检查',
      description: '运行 ESLint / Pylint / Ruff 等代码质量检查工具，发现代码问题并可选自动修复',
      icon: '🔧',
      category: 'system',
      tools: [lintCheckTool],
      config: { timeout: 60000 },
      enabled: true
    },
    handlers: { lint_check: lintCheckHandler }
  },
  {
    skill: {
      id: 'type_safety',
      name: '类型检查',
      description: '运行 TypeScript / MyPy / Cargo check 等类型检查工具，确保代码类型安全',
      icon: '🛡️',
      category: 'system',
      tools: [typeCheckTool],
      config: { timeout: 120000 },
      enabled: true
    },
    handlers: { type_check: typeCheckHandler }
  },
  {
    skill: {
      id: 'refactoring',
      name: '代码重构',
      description: '跨文件重命名标识符（变量名、函数名、类名等），支持预览模式',
      icon: '♻️',
      category: 'system',
      tools: [refactorRenameTool],
      config: { timeout: 30000, requireConfirmation: true },
      enabled: true
    },
    handlers: { refactor_rename: refactorRenameHandler }
  }
]

// ============ 角色默认绑定 ============

/**
 * 角色 → Skill ID 列表
 * 定义每个角色初始可用的技能
 */
export const defaultMinisterSkills: Record<string, string[]> = {
  // 丞相：全局搜索 + 知识库 + 任务协调 + 文件操作 + 文档解析 + 命令行 + 代码搜索 + Git + 浏览器 + 历史案例 + 代码质量 + 类型检查 + 重构
  chancellor: ['web_search', 'knowledge_base', 'task_coordinator', 'file_ops', 'document_reader', 'command_executor', 'code_search', 'git_ops', 'test_runner', 'memory', 'browser', 'history_cases', 'code_quality', 'type_safety', 'refactoring'],
  // 户部尚书：数据计算 + 数据可视化 + 搜索 + 文件读取 + 文件操作 + 文档解析 + 命令行 + Git + 测试 + 记忆
  finance: ['calculator', 'data_visualization', 'web_search', 'file_reader', 'file_ops', 'document_reader', 'command_executor', 'git_ops', 'test_runner', 'memory'],
  // 太傅：知识库 + 搜索 + 历史案例 + 文件读取 + 文件操作 + 文档解析 + 命令行 + 代码搜索 + Git + 测试 + 记忆 + 浏览器
  tutor: ['knowledge_base', 'web_search', 'history_cases', 'file_reader', 'file_ops', 'document_reader', 'command_executor', 'code_search', 'git_ops', 'test_runner', 'memory', 'browser'],
  // 大将军：搜索 + 知识库 + 命令行 + Git + 代码质量 + 类型检查 + 重构（编码核心角色）
  general: ['web_search', 'knowledge_base', 'command_executor', 'git_ops', 'memory', 'code_quality', 'type_safety', 'refactoring'],
  // 御史：搜索 + 知识库 + 文档解析 + 代码搜索 + 事实核查（御史专属核心能力） + 代码质量
  censor: ['web_search', 'knowledge_base', 'document_reader', 'code_search', 'memory', 'fact_checking', 'code_quality'],
  // 总管：搜索 + 知识库 + 文件读取 + 文件操作 + 文档解析 + 命令行 + 代码搜索 + Git + 记忆
  eunuch: ['web_search', 'knowledge_base', 'file_reader', 'file_ops', 'document_reader', 'command_executor', 'code_search', 'git_ops', 'test_runner', 'memory']
}

/**
 * 初始化所有 Skills 并建立默认绑定
 * 在应用启动时调用
 */
export function initializeSkills(): void {
  // 1. 注册所有 Skills
  for (const { skill, handlers } of allSkills) {
    skillRegistry.register(skill, handlers)
  }

  // 2. 建立默认绑定（仅在首次初始化时，版本控制确保新技能能补绑）
  const initialized = localStorage.getItem('skills_initialized_v10')
  if (!initialized) {
    // 清除旧版本标记
    localStorage.removeItem('skills_initialized')
    localStorage.removeItem('skills_initialized_v2')
    localStorage.removeItem('skills_initialized_v3')
    localStorage.removeItem('skills_initialized_v4')
    localStorage.removeItem('skills_initialized_v5')
    localStorage.removeItem('skills_initialized_v6')
    localStorage.removeItem('skills_initialized_v7')
    localStorage.removeItem('skills_initialized_v8')
    localStorage.removeItem('skills_initialized_v9')
    localStorage.removeItem('minister_skill_bindings')
    // 重新加载绑定（清除后为空）
    for (const [ministerId, skillIds] of Object.entries(defaultMinisterSkills)) {
      for (const skillId of skillIds) {
        skillRegistry.bindSkillToMinister(skillId, ministerId)
      }
    }
    localStorage.setItem('skills_initialized_v10', 'true')
  }

  // 3. 加载自定义插件
  import('@/services/plugins/plugin-manager').then(({ pluginManager_loadAll }) => {
    pluginManager_loadAll().catch(err => {
      console.warn('[Skills] 插件加载失败:', err)
    })
  })

  console.log(`[Skills] 已注册 ${allSkills.length} 个 Skill（含浏览器自动化 + 角色专属工具 + 代码质量），完成角色绑定`)
}
