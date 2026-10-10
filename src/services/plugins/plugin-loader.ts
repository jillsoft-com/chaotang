/**
 * PluginLoader — 插件加载器
 *
 * 扫描插件目录中的 SKILL.md 文件，解析并加载为 LoadedPlugin。
 * 通过 Electron IPC 访问文件系统（主进程侧）。
 */

import type { LoadedPlugin, PluginScanResult } from './types'
import { parseSkillMd, toToolDefinition, compileHandler } from './skill-parser'

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
