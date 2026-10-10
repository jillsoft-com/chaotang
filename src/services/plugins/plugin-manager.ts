/**
 * PluginManager — 插件生命周期管理
 *
 * 管理自定义工具插件的加载、卸载、重载。
 * 将插件中的 Skill 注册到 SkillRegistry。
 */

import type { LoadedPlugin, PluginScanResult } from './types'
import type { Skill } from '@/types'
import { skillRegistry } from '@/services/skills/registry'
import { loadAllPlugins } from './plugin-loader'

/** 已加载的插件集合 */
const loadedPlugins = new Map<string, LoadedPlugin>()

/**
 * 加载所有插件并注册到 SkillRegistry
 */
export async function pluginManager_loadAll(): Promise<PluginScanResult> {
  const result = await loadAllPlugins()

  for (const plugin of result.plugins) {
    try {
      registerPluginSkill(plugin)
      loadedPlugins.set(plugin.manifest.id, plugin)
    } catch (error) {
      result.errors.push({
        filePath: plugin.filePath,
        error: `注册失败: ${error instanceof Error ? error.message : '未知错误'}`
      })
    }
  }

  console.log(`[Plugins] 已加载 ${result.count} 个插件，${result.errors.length} 个失败`)
  return result
}

/**
 * 将插件注册为 Skill
 */
function registerPluginSkill(plugin: LoadedPlugin): void {
  const { manifest, toolDefinitions, handlers } = plugin

  // 构建 Skill 对象
  const skill: Skill = {
    id: `plugin_${manifest.id}`,
    name: manifest.name,
    description: manifest.description,
    icon: manifest.icon || '🔌',
    category: manifest.category || 'system',
    tools: toolDefinitions,
    config: { timeout: 30000 },
    enabled: true
  }

  // 构建 handler 映射
  const handlerMap: Record<string, (args: Record<string, any>) => Promise<any>> = {}
  for (const tool of toolDefinitions) {
    const fnName = tool.function.name
    if (handlers[fnName]) {
      handlerMap[fnName] = handlers[fnName]
    }
  }

  // 注册到 SkillRegistry
  skillRegistry.register(skill, handlerMap)

  // 自动绑定到指定角色
  if (manifest.bindTo && manifest.bindTo.length > 0) {
    for (const ministerId of manifest.bindTo) {
      skillRegistry.bindSkillToMinister(`plugin_${manifest.id}`, ministerId)
    }
  }
}

/**
 * 卸载一个插件
 */
export function pluginManager_unload(pluginId: string): void {
  const plugin = loadedPlugins.get(pluginId)
  if (!plugin) return

  skillRegistry.unregister(`plugin_${pluginId}`)
  loadedPlugins.delete(pluginId)
  console.log(`[Plugins] 已卸载插件: ${pluginId}`)
}

/**
 * 重载所有插件（先卸载全部，再重新加载）
 */
export async function pluginManager_reloadAll(): Promise<PluginScanResult> {
  // 卸载所有已加载的插件
  for (const pluginId of loadedPlugins.keys()) {
    pluginManager_unload(pluginId)
  }

  // 重新加载
  return await pluginManager_loadAll()
}

/**
 * 获取所有已加载的插件
 */
export function pluginManager_getAll(): LoadedPlugin[] {
  return Array.from(loadedPlugins.values())
}

/**
 * 获取指定插件
 */
export function pluginManager_get(pluginId: string): LoadedPlugin | undefined {
  return loadedPlugins.get(pluginId)
}

/**
 * 获取插件数量
 */
export function pluginManager_count(): number {
  return loadedPlugins.size
}
