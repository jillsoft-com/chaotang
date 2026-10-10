/**
 * PluginLoader — 插件加载器
 *
 * 扫描插件目录中的 SKILL.md 文件，解析并加载为 LoadedPlugin。
 * 通过 Electron IPC 访问文件系统（主进程侧）。
 */

import type { LoadedPlugin, PluginScanResult } from './types'
import { parseSkillMd, toToolDefinition, compileHandler, extractFrontmatter, parseSimpleYaml } from './skill-parser'

/**
 * 扫描插件目录，返回所有 SKILL.md 文件的路径
 * 通过 Electron IPC 实现
 */
export async function scanPluginDirectory(): Promise<string[]> {
  if (!window.electronAPI?.scanPlugins) {
    return []
  }
  return await window.electronAPI.scanPlugins()
}

/**
 * 读取指定路径的 SKILL.md 文件内容
 */
export async function readPluginFile(filePath: string): Promise<string> {
  if (!window.electronAPI?.readPlugin) {
    throw new Error('当前环境不支持读取插件文件')
  }
  const result = await window.electronAPI.readPlugin(filePath)
  if (!result.success) {
    throw new Error(result.error || '读取插件文件失败')
  }
  return result.content!
}

/**
 * 加载单个插件
 * @param filePath SKILL.md 文件的完整路径
 */
export async function loadPlugin(filePath: string): Promise<LoadedPlugin> {
  const dirPath = filePath.replace(/[\\/][^\\/]+$/, '')

  try {
    // 1. 读取文件内容
    const content = await readPluginFile(filePath)

    // 2. 解析 YAML frontmatter
    const manifest = parseSkillMd(content)

    // 3. 转换工具定义
    const toolDefinitions = manifest.tools.map(toToolDefinition)

    // 4. 编译 handler
    const toolNames = manifest.tools.map(t => t.name)
    let handlers: Record<string, (args: Record<string, any>) => Promise<any>> = {}

    if (manifest.handler) {
      handlers = compileHandler(manifest.handler, toolNames)
    } else {
      // 没有 handler，为每个工具创建占位函数
      for (const name of toolNames) {
        handlers[name] = async () => ({
          message: `工具 ${name} 未实现 handler，请在 SKILL.md 中定义 handler 代码`
        })
      }
    }

    return {
      manifest,
      filePath,
      dirPath,
      toolDefinitions,
      handlers,
      status: 'loaded',
      loadedAt: Date.now()
    }
  } catch (error) {
    return {
      manifest: {
        id: 'unknown',
        name: '未知插件',
        description: '',
        tools: []
      },
      filePath,
      dirPath,
      toolDefinitions: [],
      handlers: {},
      status: 'error',
      error: error instanceof Error ? error.message : '加载失败',
      loadedAt: Date.now()
    }
  }
}

/**
 * 扫描并加载所有插件
 */
export async function loadAllPlugins(): Promise<PluginScanResult> {
  const filePaths = await scanPluginDirectory()

  const plugins: LoadedPlugin[] = []
  const errors: Array<{ filePath: string; error: string }> = []

  for (const filePath of filePaths) {
    const plugin = await loadPlugin(filePath)
    if (plugin.status === 'loaded') {
      plugins.push(plugin)
    } else {
      errors.push({ filePath, error: plugin.error || '未知错误' })
    }
  }

  return {
    pluginDir: '', // 由调用方填充
    count: plugins.length,
    plugins,
    errors
  }
}

// ============ 插件导入 ============

export interface ImportPluginResult {
  success: boolean
  pluginId?: string
  pluginName?: string
  error?: string
}

/**
 * 通过文件对话框选择并导入 SKILL.md 插件文件
 *
 * 流程：
 * 1. 打开文件选择对话框（过滤 .md 文件）
 * 2. 读取并解析 YAML frontmatter 提取插件 ID
 * 3. 在 plugins/<id>/ 下写入 SKILL.md
 * 4. 返回导入结果
 */
export async function importPluginFromFile(): Promise<ImportPluginResult> {
  // 1. 打开文件选择对话框
  if (!window.electronAPI?.showOpenDialog) {
    return { success: false, error: '当前环境不支持文件选择（需要 Electron 桌面版）' }
  }

  const dialogResult = await window.electronAPI.showOpenDialog({
    title: '导入插件 — 选择 SKILL.md 文件',
    properties: ['openFile'],
    filters: [
      { name: 'SKILL.md', extensions: ['md'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  })

  if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
    return { success: false, error: '已取消导入' }
  }

  const sourcePath = dialogResult.filePaths[0]

  // 2. 读取文件内容
  try {
    const readResult = await window.electronAPI!.readFile(sourcePath)
    if (!readResult.success || !readResult.content) {
      return { success: false, error: `读取文件失败: ${readResult.error || '文件内容为空'}` }
    }

    // 3. 解析 frontmatter 提取插件 ID
    const { frontmatter } = extractFrontmatter(readResult.content)
    if (!frontmatter) {
      return { success: false, error: '文件格式无效：未找到 YAML frontmatter（需要以 --- 开头）' }
    }

    const yaml = parseSimpleYaml(frontmatter)
    const pluginId = yaml.id as string
    const pluginName = (yaml.name as string) || pluginId || '未命名插件'

    if (!pluginId) {
      return { success: false, error: 'YAML 中缺少 id 字段，无法导入' }
    }

    // 4. 获取插件目录并创建子目录
    const pluginDir = await window.electronAPI!.getPluginDir()
    const targetDir = `${pluginDir}/${pluginId}`
    await window.electronAPI!.createDirectory(targetDir)

    // 5. 写入 SKILL.md
    const targetPath = `${targetDir}/SKILL.md`
    const writeResult = await window.electronAPI!.writeFile(targetPath, readResult.content)
    if (!writeResult.success) {
      return { success: false, error: `写入文件失败: ${writeResult.error || '未知错误'}` }
    }

    console.log(`[Plugins] 已导入插件: ${pluginId} → ${targetPath}`)
    return { success: true, pluginId, pluginName }
  } catch (error) {
    return {
      success: false,
      error: `导入失败: ${error instanceof Error ? error.message : '未知错误'}`
    }
  }
}
