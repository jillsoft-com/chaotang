<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useDebateStore } from '@/stores/debate'
import { llmService } from '@/services/llm-config'
import { promptService } from '@/services/prompt-config'
import { useTheme } from '@/composables/useTheme'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft, Plus, Edit, Delete, Star, RefreshRight, Sunny, Moon, Refresh } from '@element-plus/icons-vue'
import type { LLMConfig, LLMTestResult, LLMProviderType } from '@/types/llm'
import { skillRegistry } from '@/services/skills'
import { isCustomTheme, getPresetsByCategory, THEME_CATEGORIES } from '@/services/dynasty-presets'
import type { Skill } from '@/types'
import { SKILL_CATEGORY_LABELS } from '@/types'
import { pluginManager_getAll, pluginManager_reloadAll } from '@/services/plugins/plugin-manager'
import { importPluginFromFile } from '@/services/plugins/plugin-loader'
import type { LoadedPlugin } from '@/services/plugins/types'
import { getMessagingConfig, saveMessagingConfig, initMessaging, getWeComAdapter, startWebhookServer, stopWebhookServer } from '@/services/messaging'
import { estimateTokens, estimateCost, formatCost, formatTokens, formatDuration } from '@/utils/token-utils'
import type { Debate } from '@/types'

const router = useRouter()
const debateStore = useDebateStore()
const { isDark } = useTheme()

const activeTab = ref('general')

// Skill 管理
const allSkills = computed(() => skillRegistry.getAllSkills())

function getMinisterSkills(ministerId: string): Skill[] {
  return skillRegistry.getSkillsForMinister(ministerId)
}

function getSkillCategoryLabel(category: string): string {
  return (SKILL_CATEGORY_LABELS as Record<string, string>)[category] || category
}

function toggleSkillForMinister(skillId: string, ministerId: string, enabled: boolean) {
  if (enabled) {
    skillRegistry.bindSkillToMinister(skillId, ministerId)
  } else {
    skillRegistry.unbindSkillFromMinister(skillId, ministerId)
  }
  ElMessage.success(enabled ? '已启用' : '已禁用')
}

function isSkillBound(skillId: string, ministerId: string): boolean {
  const bindings = skillRegistry.getBindingsForMinister(ministerId)
  return bindings.some(b => b.skillId === skillId)
}
const showLLMDialog = ref(false)
const editingLLM = ref<LLMConfig | null>(null)
const testResult = ref<LLMTestResult | null>(null)
const testing = ref(false)

// 远程获取模型
const fetchedModels = ref<string[]>([])
const fetchingModels = ref(false)

// Prompt 配置
const editingPrompt = ref<string | null>(null)
const showPromptDialog = ref(false)
const promptForm = ref({
  name: '',
  title: '',
  systemPrompt: '',
  description: ''
})

function getPromptSource(ministerId: string): string {
  const config = promptService.getPrompt(ministerId)
  return config.source === 'custom' ? '自定义' : 'MD 文件'
}

// LLM 配置表单
const llmForm = ref({
  name: '',
  provider: 'openai' as LLMProviderType,
  model: '',
  apiKey: '',
  baseURL: '',
  temperature: 0.7,
  maxTokens: 4096
})

// 摘要模型
const summaryModelId = ref('')

// 工具调用最大轮次
const maxToolRounds = ref(30)

// 上下文压缩阈值（字符数）
const contextCompressThreshold = ref(50000)

// 字体大小
const MIN_FONT = 12
const MAX_FONT = 22
const messageFontSize = ref(parseInt(localStorage.getItem('message_font_size') || '15', 10))

function saveFontSize(val: number) {
  messageFontSize.value = val
  localStorage.setItem('message_font_size', String(val))
}

// 朝代主题
const dynastyPresets = ref(debateStore.getDynastyPresets())
const selectedDynasty = ref(debateStore.currentDynastyId)

// 按分类分组的内置预设
const categorizedPresets = computed(() => getPresetsByCategory())

// 自定义主题列表
const customThemes = computed(() => dynastyPresets.value.filter(p => isCustomTheme(p.id)))

// 当前选中的是否为自定义主题
const isCurrentCustom = computed(() => isCustomTheme(selectedDynasty.value))

// 当前正在编辑的自定义主题的角色数据
const editingThemeRoles = ref<Record<string, { name: string; title: string }>>({})

// 当前正在编辑的自定义主题的提示词数据
const editingThemePrompts = ref<Record<string, { systemPrompt: string; description?: string }>>({})

// 提示词展开状态（哪个角色的 prompt 编辑框是展开的）
const expandedPromptRole = ref<string | null>(null)

// 新建自定义主题对话框
const showNewThemeDialog = ref(false)
const newThemeForm = ref({ name: '', icon: '✏️' })

// 图标选择列表
const iconOptions = ['✏️', '💻', '📦', '🏭', '🎮', '🏥', '🎓', '⚖️', '🚀', '💰', '🌍', '🔬', '🎭', '🏗️', '🛒']

function onDynastyChange(dynastyId: string) {
  debateStore.switchDynasty(dynastyId)
  selectedDynasty.value = dynastyId
  const preset = dynastyPresets.value.find(p => p.id === dynastyId)
  ElMessage.success('已切换为' + (preset?.name || ''))
  // 加载自定义主题的角色数据用于编辑
  if (isCustomTheme(dynastyId)) {
    loadCustomThemeRoles(dynastyId)
  }
}

function ensureEditingThemeRoles() {
  // 确保 editingThemeRoles 中有完整的角色数据
  debateStore.ministers.forEach(m => {
    if (!editingThemeRoles.value[m.id]) {
      editingThemeRoles.value[m.id] = { name: m.name, title: m.title }
    }
  })
}

function getRoleData(roleId: string): { name: string; title: string } {
  if (!editingThemeRoles.value[roleId]) {
    const minister = debateStore.ministers.find(m => m.id === roleId)
    editingThemeRoles.value[roleId] = {
      name: minister?.name || '',
      title: minister?.title || ''
    }
  }
  return editingThemeRoles.value[roleId]
}

function loadCustomThemeRoles(themeId: string) {
  const theme = dynastyPresets.value.find(p => p.id === themeId)
  if (theme) {
    editingThemeRoles.value = JSON.parse(JSON.stringify(theme.roles))
    editingThemePrompts.value = JSON.parse(JSON.stringify(theme.prompts || {}))
  }
  ensureEditingThemeRoles()
}

function onCustomRoleFieldChange(roleId: string, field: 'name' | 'title', value: string) {
  if (!editingThemeRoles.value[roleId]) {
    editingThemeRoles.value[roleId] = { name: '', title: '' }
  }
  editingThemeRoles.value[roleId][field] = value
}

function saveCustomThemeRoles() {
  debateStore.updateCustomThemeRole(selectedDynasty.value, editingThemeRoles.value)
  dynastyPresets.value = debateStore.getDynastyPresets()
}

function onThemePromptChange(roleId: string, value: string) {
  if (!editingThemePrompts.value[roleId]) {
    editingThemePrompts.value[roleId] = { systemPrompt: '', description: '' }
  }
  editingThemePrompts.value[roleId].systemPrompt = value
}

function saveThemePrompts() {
  debateStore.updateCustomThemePrompt(selectedDynasty.value, editingThemePrompts.value)
  dynastyPresets.value = debateStore.getDynastyPresets()
  ElMessage.success('提示词已保存')
}

function togglePromptExpand(roleId: string) {
  expandedPromptRole.value = expandedPromptRole.value === roleId ? null : roleId
}

function getThemePrompt(roleId: string): string {
  return editingThemePrompts.value[roleId]?.systemPrompt || ''
}

async function createCustomTheme() {
  if (!newThemeForm.value.name.trim()) {
    ElMessage.warning('请填写主题名称')
    return
  }
  const id = debateStore.createCustomTheme(newThemeForm.value.name.trim(), newThemeForm.value.icon)
  showNewThemeDialog.value = false
  newThemeForm.value = { name: '', icon: '✏️' }
  // 刷新列表并切换过去
  dynastyPresets.value = debateStore.getDynastyPresets()
  selectedDynasty.value = id
  debateStore.switchDynasty(id)
  loadCustomThemeRoles(id)
  ElMessage.success('自定义主题已创建')
}

async function deleteCustomTheme(themeId: string) {
  try {
    await ElMessageBox.confirm('确定删除这个自定义主题吗？', '确认删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
    debateStore.removeCustomTheme(themeId)
    dynastyPresets.value = debateStore.getDynastyPresets()
    selectedDynasty.value = debateStore.currentDynastyId
    ElMessage.success('已删除')
  } catch {
    // 取消
  }
}

// 角色配置
const ministerLLMMap = ref<Record<string, string>>({})

// 角色自定义头像
const avatarEmojiOptions = [
  '👑', '💰', '📚', '⚔️', '🔍', '🏮', '🐲', '🦁', '🐯', '🦅',
  '🏛️', '⚖️', '📜', '🗡️', '🛡️', '🎭', '👤', '🧙', '🧑‍💼', '👨‍⚖️',
  '🎖️', '🏅', '💎', '🌟', '🔥', '❄️', '🌊', '⛰️', '🌙', '☀️'
]
const avatarUrlInputs = ref<Record<string, string>>({})

function isImageAvatar(avatar: string): boolean {
  return avatar.startsWith('http') || avatar.startsWith('data:')
}

function setAvatarFromEmoji(ministerId: string, emoji: string) {
  debateStore.setMinisterAvatar(ministerId, emoji)
  avatarUrlInputs.value[ministerId] = ''
  ElMessage.success('头像已更新')
}

function setAvatarFromUrl(ministerId: string) {
  const url = (avatarUrlInputs.value[ministerId] || '').trim()
  if (!url) {
    ElMessage.warning('请输入图片 URL')
    return
  }
  debateStore.setMinisterAvatar(ministerId, url)
  ElMessage.success('头像已更新')
}

function resetAvatar(ministerId: string) {
  debateStore.setMinisterAvatar(ministerId, '')
  avatarUrlInputs.value[ministerId] = ''
  ElMessage.success('已恢复默认头像')
}

const llmConfigs = computed(() => llmService.getAll())

const providerModels: Record<string, string[]> = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'o1', 'o1-mini', 'o3-mini'],
  claude: ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-opus-20240229', 'claude-3-haiku-20240307'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'],
  qwen: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long', 'qwen-coder-plus'],
  kimi: ['moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'],
  zhipu: ['glm-4-plus', 'glm-4', 'glm-4-flash', 'glm-4-long'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  baichuan: ['Baichuan4', 'Baichuan3-Turbo', 'Baichuan3-Turbo-128k'],
  yi: ['yi-large', 'yi-large-turbo', 'yi-medium', 'yi-spark'],
  spark: ['spark-4.0-ultra', 'spark-pro-128k', 'spark-max'],
  doubao: ['doubao-pro-32k', 'doubao-pro-128k', 'doubao-lite-32k'],
  ernie: ['ernie-4.0-8k', 'ernie-3.5-8k', 'ernie-speed-128k'],
  mistral: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'open-mistral-nemo'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  ollama: ['qwen2.5:7b', 'qwen2.5:14b', 'llama3.1:8b', 'llama3.1:70b', 'mistral:7b', 'mixtral:8x7b']
}

const providerOptions = [
  { label: 'OpenAI (ChatGPT)', value: 'openai' },
  { label: 'Claude (Anthropic)', value: 'claude' },
  { label: 'DeepSeek', value: 'deepseek' },
  { label: '通义千问 (Qwen)', value: 'qwen' },
  { label: 'Kimi (月之暗面)', value: 'kimi' },
  { label: '智谱 (GLM)', value: 'zhipu' },
  { label: 'Gemini (Google)', value: 'gemini' },
  { label: '百川 (Baichuan)', value: 'baichuan' },
  { label: '零一万物 (Yi)', value: 'yi' },
  { label: '讯飞星火 (Spark)', value: 'spark' },
  { label: '豆包 (字节)', value: 'doubao' },
  { label: '文心一言 (百度)', value: 'ernie' },
  { label: 'Mistral', value: 'mistral' },
  { label: 'Groq', value: 'groq' },
  { label: 'Ollama (本地)', value: 'ollama' }
]

function getProviderLabel(provider: string): string {
  return providerOptions.find(p => p.value === provider)?.label || provider
}

// 合并本地预设 + 远程获取的模型列表
const availableModels = computed(() => {
  const preset = providerModels[llmForm.value.provider] || []
  const remote = fetchedModels.value
  const merged = [...new Set([...preset, ...remote])]
  return merged.sort()
})

// 切换提供商时清空远程模型
watch(() => llmForm.value.provider, () => {
  fetchedModels.value = []
})

onMounted(() => {
  debateStore.initializeMinisters()
  loadMinisterLLMMap()
  loadSummaryModel()
  loadMaxToolRounds()
  loadCompressThreshold()
  // 如果当前是自定义主题，加载角色数据
  if (isCustomTheme(selectedDynasty.value)) {
    loadCustomThemeRoles(selectedDynasty.value)
  }
  // 加载插件列表
  loadPluginList()
  // 加载沙箱配置
  loadSandboxConfig()
  // 初始化并加载消息集成配置
  initMessaging()
  loadMessagingConfigValues()
})

function loadSummaryModel() {
  summaryModelId.value = localStorage.getItem('summary_model_id') || ''
}

function saveSummaryModel() {
  localStorage.setItem('summary_model_id', summaryModelId.value)
  ElMessage.success('摘要模型已保存')
}

function loadMaxToolRounds() {
  const saved = localStorage.getItem('max_tool_rounds')
  if (saved) {
    const val = parseInt(saved, 10)
    if (val > 0 && val <= 100) maxToolRounds.value = val
  }
}

function saveMaxToolRounds() {
  localStorage.setItem('max_tool_rounds', String(maxToolRounds.value))
  ElMessage.success('工具调用轮次已保存')
}

function loadCompressThreshold() {
  const saved = localStorage.getItem('context_compress_threshold')
  if (saved) {
    const val = parseInt(saved, 10)
    if (val > 10000 && val <= 200000) contextCompressThreshold.value = val
  }
}

function saveCompressThreshold() {
  localStorage.setItem('context_compress_threshold', String(contextCompressThreshold.value))
  ElMessage.success('压缩阈值已保存')
}

function loadMinisterLLMMap() {
  const saved = localStorage.getItem('minister_llm_map')
  if (saved) {
    ministerLLMMap.value = JSON.parse(saved)
  } else {
    const defaultLLM = llmConfigs.value.find(c => c.isDefault) || llmConfigs.value[0]
    if (defaultLLM) {
      debateStore.ministers.forEach(m => {
        ministerLLMMap.value[m.id] = defaultLLM.id
      })
      saveMinisterLLMMap()
    }
  }
}

function saveMinisterLLMMap() {
  localStorage.setItem('minister_llm_map', JSON.stringify(ministerLLMMap.value))
}

function openAddLLMDialog() {
  editingLLM.value = null
  llmForm.value = { name: '', provider: 'openai', model: 'gpt-4o-mini', apiKey: '', baseURL: '', temperature: 0.7, maxTokens: 4096 }
  testResult.value = null
  fetchedModels.value = []
  showLLMDialog.value = true
}

function openEditLLMDialog(config: LLMConfig) {
  editingLLM.value = config
  llmForm.value = {
    name: config.name,
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey || '',
    baseURL: config.baseURL || '',
    temperature: config.temperature || 0.7,
    maxTokens: config.maxTokens || 4096
  }
  testResult.value = null
  fetchedModels.value = []
  showLLMDialog.value = true
}

function closeLLMDialog() {
  showLLMDialog.value = false
  editingLLM.value = null
  testResult.value = null
}

async function fetchRemoteModels() {
  if (!llmForm.value.apiKey && llmForm.value.provider !== 'ollama') {
    ElMessage.warning('请先填写 API Key')
    return
  }

  fetchingModels.value = true
  try {
    const result = await llmService.fetchModels({
      provider: llmForm.value.provider,
      apiKey: llmForm.value.apiKey || undefined,
      baseURL: llmForm.value.baseURL || undefined
    })

    if (result.success) {
      fetchedModels.value = result.models
      ElMessage.success(result.message)
    } else {
      ElMessage.warning(result.message)
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '获取模型失败')
  } finally {
    fetchingModels.value = false
  }
}

async function saveLLMConfig() {
  if (!llmForm.value.name || !llmForm.value.model) {
    ElMessage.warning('请填写名称和模型')
    return
  }

  const config = {
    name: llmForm.value.name,
    provider: llmForm.value.provider,
    model: llmForm.value.model,
    apiKey: llmForm.value.apiKey || undefined,
    baseURL: llmForm.value.baseURL || undefined,
    temperature: llmForm.value.temperature,
    maxTokens: llmForm.value.maxTokens
  }

  try {
    if (editingLLM.value) {
      await llmService.update(editingLLM.value.id, config)
    } else {
      await llmService.add(config)
    }
    closeLLMDialog()
    ElMessage.success('LLM 配置已保存')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  }
}

async function testLLMConfig() {
  testing.value = true
  testResult.value = null

  const config: LLMConfig = {
    id: editingLLM.value?.id || 'test',
    ...llmForm.value
  }

  try {
    testResult.value = await llmService.test(config)
  } catch (error) {
    testResult.value = {
      success: false,
      message: error instanceof Error ? error.message : '测试失败'
    }
  } finally {
    testing.value = false
  }
}

async function deleteLLMConfig(id: string) {
  try {
    await ElMessageBox.confirm('确定要删除此 LLM 配置吗？', '确认删除', { type: 'warning' })
    await llmService.delete(id)
    ElMessage.success('已删除')
  } catch (error) {
    if (error instanceof Error) ElMessage.error(error.message)
  }
}

function setDefaultLLM(id: string) {
  llmService.setDefault(id)
  ElMessage.success('已设为默认')
}

function saveMinisterConfig(ministerId: string) {
  const llmId = ministerLLMMap.value[ministerId]
  const llmConfig = llmService.getById(llmId)

  if (llmConfig) {
    debateStore.saveMinisterLLMConfig(ministerId, {
      provider: llmConfig.provider,
      model: llmConfig.model,
      llmId: llmConfig.id
    })
    saveMinisterLLMMap()
    ElMessage.success('配置已保存')
  }
}

async function resetAllConfigs() {
  try {
    await ElMessageBox.confirm('确定要重置所有角色配置为默认值吗？', '确认重置', { type: 'warning' })
    const defaultLLM = llmConfigs.value.find(c => c.isDefault) || llmConfigs.value[0]
    if (defaultLLM) {
      debateStore.ministers.forEach(m => {
        ministerLLMMap.value[m.id] = defaultLLM.id
      })
      saveMinisterLLMMap()
      ElMessage.success('已重置')
    }
  } catch {
    // cancelled
  }
}

// Prompt 配置函数
function openEditPromptDialog(ministerId: string) {
  const minister = debateStore.ministers.find(m => m.id === ministerId)
  if (minister) {
    editingPrompt.value = ministerId
    promptForm.value = {
      name: minister.name,
      title: minister.title,
      systemPrompt: minister.systemPrompt,
      description: minister.description
    }
    showPromptDialog.value = true
  }
}

function closePromptDialog() {
  showPromptDialog.value = false
  editingPrompt.value = null
}

function savePromptConfig() {
  if (!editingPrompt.value) return

  promptService.saveCustom(
    editingPrompt.value,
    promptForm.value.systemPrompt,
    promptForm.value.description
  )

  const minister = debateStore.ministers.find(m => m.id === editingPrompt.value)
  if (minister) {
    minister.systemPrompt = promptForm.value.systemPrompt
    minister.description = promptForm.value.description
  }

  closePromptDialog()
  ElMessage.success('Prompt 已保存')
}

async function resetPrompt(ministerId: string) {
  try {
    await ElMessageBox.confirm('确定要重置此角色的 Prompt 为默认值吗？', '确认重置', { type: 'warning' })
    promptService.removeCustom(ministerId)
    debateStore.initializeMinisters()
    ElMessage.success('已重置为默认 Prompt')
  } catch {
    // cancelled
  }
}

// ============ 插件管理 ============

const pluginsLoading = ref(false)
const loadedPlugins = ref<LoadedPlugin[]>([])
const pluginErrors = ref<Array<{ filePath: string; error: string }>>([])

function loadPluginList() {
  loadedPlugins.value = pluginManager_getAll()
}

async function reloadPlugins() {
  pluginsLoading.value = true
  try {
    const result = await pluginManager_reloadAll()
    loadedPlugins.value = result.plugins
    pluginErrors.value = result.errors
    ElMessage.success(`已重新加载 ${result.count} 个插件`)
  } catch (error) {
    ElMessage.error('重载插件失败')
  } finally {
    pluginsLoading.value = false
  }
}

async function openPluginDir() {
  if (window.electronAPI?.openPluginDir) {
    await window.electronAPI.openPluginDir()
  } else {
    ElMessage.warning('当前环境不支持打开插件目录（需要 Electron 桌面版）')
  }
}

const importingPlugin = ref(false)

async function importPlugin() {
  importingPlugin.value = true
  try {
    const result = await importPluginFromFile()
    if (result.success) {
      ElMessage.success(`已导入插件「${result.pluginName}」，正在加载…`)
      // 自动重新加载插件
      await reloadPlugins()
    } else if (result.error && result.error !== '已取消导入') {
      ElMessage.error(result.error)
    }
  } catch (error) {
    ElMessage.error('导入插件失败: ' + (error instanceof Error ? error.message : '未知错误'))
  } finally {
    importingPlugin.value = false
  }
}

// ============ 沙箱配置 ============

const sandboxEnabled = ref(true)
const sandboxBlockNetwork = ref(false)
const sandboxMaxMemory = ref(512)
const sandboxMaxTimeout = ref(120000)

async function loadSandboxConfig() {
  if (window.electronAPI?.getSandboxConfig) {
    const config = await window.electronAPI.getSandboxConfig()
    sandboxEnabled.value = config.enabled
    sandboxBlockNetwork.value = config.blockNetwork
    sandboxMaxMemory.value = config.maxMemoryMB
    sandboxMaxTimeout.value = config.maxTimeout
  }
}

async function onSandboxChange() {
  if (window.electronAPI?.saveSandboxConfig) {
    await window.electronAPI.saveSandboxConfig({
      enabled: sandboxEnabled.value,
      blockNetwork: sandboxBlockNetwork.value,
      maxMemoryMB: sandboxMaxMemory.value,
      maxTimeout: sandboxMaxTimeout.value
    })
    ElMessage.success('沙箱配置已保存')
  }
}

// ============ 消息集成 ============

const wecomWebhookUrl = ref('')
const wecomConnected = ref(false)
const testingWeCom = ref(false)
const autoPushResults = ref(false)
const webhookPort = ref(9527)
const webhookServerRunning = ref(false)
const serverLoading = ref(false)

function loadMessagingConfigValues() {
  const config = getMessagingConfig()
  wecomWebhookUrl.value = config.wecomWebhookUrl || ''
  autoPushResults.value = config.autoPushResults
  webhookPort.value = config.webhookPort
}

function saveMessagingConfigValues() {
  // 配置企业微信适配器
  if (wecomWebhookUrl.value) {
    getWeComAdapter().configure(wecomWebhookUrl.value)
  }
  saveMessagingConfig({
    wecomWebhookUrl: wecomWebhookUrl.value,
    autoPushResults: autoPushResults.value,
    webhookPort: webhookPort.value
  })
  ElMessage.success('消息集成配置已保存')
}

async function testWeComConnection() {
  testingWeCom.value = true
  try {
    if (wecomWebhookUrl.value) {
      getWeComAdapter().configure(wecomWebhookUrl.value)
    }
    const result = await getWeComAdapter().testConnection()
    wecomConnected.value = result.success
    if (result.success) {
      ElMessage.success(result.message)
    } else {
      ElMessage.error(result.message)
    }
  } catch (error) {
    ElMessage.error('测试连接失败')
  } finally {
    testingWeCom.value = false
  }
}

async function startServer() {
  serverLoading.value = true
  try {
    const result = await startWebhookServer(webhookPort.value)
    webhookServerRunning.value = result.success
    if (result.success) {
      ElMessage.success(result.message)
    } else {
      ElMessage.error(result.message)
    }
  } catch (error) {
    ElMessage.error('启动服务器失败')
  } finally {
    serverLoading.value = false
  }
}

async function stopServer() {
  serverLoading.value = true
  try {
    const result = await stopWebhookServer()
    webhookServerRunning.value = false
    ElMessage.success(result.message || '服务器已停止')
  } catch (error) {
    ElMessage.error('停止服务器失败')
  } finally {
    serverLoading.value = false
  }
}

// ============ 数据洞察（v0.6） ============

/** 所有历史会话（含当前活跃会话） */
const allDebates = computed<Debate[]>(() => {
  const history = debateStore.debates || []
  const active = debateStore.activeSession
  // 合并去重
  const ids = new Set(history.map(d => d.id))
  const result = [...history]
  if (active && !ids.has(active.id)) result.unshift(active)
  return result.sort((a, b) => b.createdAt - a.createdAt)
})

/** 统计所有会话的 token / 费用 / 模型使用 */
const globalStats = computed(() => {
  let totalPromptTokens = 0
  let totalCompletionTokens = 0
  let totalCost = 0
  let totalDuration = 0
  let speechCount = 0
  const modelUsage = new Map<string, { count: number; tokens: number; cost: number }>()

  for (const debate of allDebates.value) {
    for (const speech of debate.speeches) {
      if (speech.ministerId === 'emperor') continue
      speechCount++

      const tu = speech.tokenUsage
      const model = speech.model || 'unknown'
      const promptT = tu?.promptTokens || estimateTokens(speech.content) // fallback: estimate
      const completionT = tu?.completionTokens || estimateTokens(speech.content)
      const totalT = tu?.totalTokens || promptT + completionT
      const cost = estimateCost(promptT, completionT, model)

      totalPromptTokens += promptT
      totalCompletionTokens += completionT
      totalCost += cost
      totalDuration += speech.durationMs || 0

      if (!modelUsage.has(model)) {
        modelUsage.set(model, { count: 0, tokens: 0, cost: 0 })
      }
      const mu = modelUsage.get(model)!
      mu.count++
      mu.tokens += totalT
      mu.cost += cost
    }
  }

  const modelBreakdown = [...modelUsage.entries()]
    .map(([model, data]) => ({ model, ...data }))
    .sort((a, b) => b.tokens - a.tokens)

  return {
    totalDebates: allDebates.value.length,
    completedDebates: allDebates.value.filter(d => d.status === 'completed').length,
    speechCount,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens: totalPromptTokens + totalCompletionTokens,
    totalCost,
    avgDuration: speechCount > 0 ? totalDuration / speechCount : 0,
    modelBreakdown
  }
})

/** 决策时间线：已完成的会话按时间排列 */
const decisionTimeline = computed(() => {
  return allDebates.value
    .filter(d => d.status === 'completed')
    .slice(0, 20) // 最近 20 条
    .map(d => {
      const ministerSpeeches = d.speeches.filter(s => s.ministerId !== 'emperor')
      const totalTokens = ministerSpeeches.reduce((sum, s) => {
        const tu = s.tokenUsage
        return sum + (tu?.totalTokens || estimateTokens(s.content) * 2)
      }, 0)
      const totalCost = ministerSpeeches.reduce((sum, s) => {
        const tu = s.tokenUsage
        return sum + estimateCost(tu?.promptTokens || 0, tu?.completionTokens || estimateTokens(s.content), s.model || 'unknown')
      }, 0)
      return {
        id: d.id,
        topic: d.topic,
        createdAt: d.createdAt,
        completedAt: d.completedAt,
        imperialDecree: d.imperialDecree,
        speechCount: ministerSpeeches.length,
        totalTokens,
        totalCost,
        tags: d.tags || []
      }
    })
})

function formatDate(ts: number): string {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}
</script>

<template>
  <div class="settings-container">
    <div class="settings-content">
      <header class="settings-header">
        <el-button :icon="ArrowLeft" text @click="router.push('/')" />
        <h1 class="settings-title">设置</h1>
      </header>

      <el-tabs v-model="activeTab" class="settings-tabs">
        <!-- 通用设置 -->
        <el-tab-pane label="通用" name="general">
          <div class="tab-header">
            <div>
              <h2 class="section-title">通用设置</h2>
              <p class="section-desc">应用外观和基本设置</p>
            </div>
          </div>

          <div class="settings-sections">
            <!-- 外观设置 -->
            <el-card shadow="never" class="settings-card">
              <h3 class="card-title">外观</h3>
              <div class="settings-item">
                <div class="settings-item-info">
                  <span class="settings-item-label">主题模式</span>
                  <span class="settings-item-desc">切换深色或浅色主题</span>
                </div>
                <el-switch
                  v-model="isDark"
                  :active-icon="Moon"
                  :inactive-icon="Sunny"
                  inline-prompt
                  active-text="暗"
                  inactive-text="亮"
                />
              </div>
              <div class="settings-item">
                <div class="settings-item-info">
                  <span class="settings-item-label">消息字体大小</span>
                  <span class="settings-item-desc">调整会话中消息正文的字号（{{ messageFontSize }}px，默认 15px）</span>
                </div>
                <div class="font-size-setting">
                  <el-slider
                    v-model="messageFontSize"
                    :min="MIN_FONT"
                    :max="MAX_FONT"
                    :step="1"
                    :show-tooltip="true"
                    style="width: 160px"
                    @change="saveFontSize"
                  />
                  <el-button size="small" text @click="messageFontSize = 15; saveFontSize(15)" :disabled="messageFontSize === 15">
                    重置
                  </el-button>
                </div>
              </div>
            </el-card>

            <!-- 摘要模型设置 -->
            <el-card shadow="never" class="settings-card">
              <h3 class="card-title">摘要模型</h3>
              <div class="settings-item">
                <div class="settings-item-info">
                  <span class="settings-item-label">选择摘要模型</span>
                  <span class="settings-item-desc">用于会话摘要生成的 LLM 模型</span>
                </div>
                <div class="summary-model-select">
                  <el-select
                    v-model="summaryModelId"
                    placeholder="选择模型"
                    clearable
                    @change="saveSummaryModel"
                  >
                    <el-option
                      v-for="llm in llmConfigs"
                      :key="llm.id"
                      :value="llm.id"
                      :label="`${llm.name} (${llm.model})`"
                    />
                  </el-select>
                </div>
              </div>
            </el-card>

            <!-- 工具调用轮次设置 -->
            <el-card shadow="never" class="settings-card">
              <h3 class="card-title">工具调用</h3>
              <div class="settings-item">
                <div class="settings-item-info">
                  <span class="settings-item-label">最大工具调用轮次</span>
                  <span class="settings-item-desc">大臣使用工具的最大回合数，超出后要求总结（默认 30）</span>
                </div>
                <div class="max-rounds-control">
                  <el-input-number
                    v-model="maxToolRounds"
                    :min="1"
                    :max="100"
                    :step="1"
                    size="small"
                    @change="saveMaxToolRounds"
                  />
                </div>
              </div>
              <div class="settings-item">
                <div class="settings-item-info">
                  <span class="settings-item-label">上下文压缩阈值</span>
                  <span class="settings-item-desc">工具调用过程中消息总字符数超过此值时自动压缩历史（10K~200K，默认 50000）</span>
                </div>
                <div class="max-rounds-control">
                  <el-input-number
                    v-model="contextCompressThreshold"
                    :min="10000"
                    :max="200000"
                    :step="5000"
                    size="small"
                    @change="saveCompressThreshold"
                  />
                </div>
              </div>
            </el-card>

            <!-- 朝廷风格 -->
            <el-card shadow="never" class="settings-card">
              <h3 class="card-title">朝廷风格</h3>
              <div class="settings-item">
                <div class="settings-item-info">
                  <span class="settings-item-label">朝代主题</span>
                  <span class="settings-item-desc">选择预设朝代或创建自定义主题</span>
                </div>
                <div class="dynasty-select-row">
                  <el-select v-model="selectedDynasty" @change="onDynastyChange" style="width: 180px">
                    <el-option-group
                      v-for="(presets, catKey) in categorizedPresets"
                      :key="catKey"
                      :label="THEME_CATEGORIES[catKey as keyof typeof THEME_CATEGORIES]"
                    >
                      <el-option
                        v-for="preset in presets"
                        :key="preset.id"
                        :value="preset.id"
                        :label="`${preset.icon} ${preset.name}`"
                      />
                    </el-option-group>
                    <el-option-group v-if="customThemes.length > 0" label="✏️ 自定义主题">
                      <el-option
                        v-for="preset in customThemes"
                        :key="preset.id"
                        :value="preset.id"
                        :label="`${preset.icon} ${preset.name}`"
                      />
                    </el-option-group>
                  </el-select>
                  <el-button size="small" :icon="Plus" @click="showNewThemeDialog = true">新建主题</el-button>
                  <el-button
                    v-if="isCurrentCustom"
                    size="small"
                    type="danger"
                    :icon="Delete"
                    @click="deleteCustomTheme(selectedDynasty)"
                  >删除</el-button>
                </div>
              </div>

              <!-- 当前主题的角色预览（非自定义） -->
              <div class="dynasty-roles-preview" v-if="!isCurrentCustom">
                <div class="dynasty-role-item" v-for="minister in debateStore.ministers" :key="minister.id">
                  <span class="dynasty-role-avatar">{{ minister.avatar }}</span>
                  <span class="dynasty-role-name">{{ minister.name }}</span>
                  <span class="dynasty-role-title">{{ minister.title }}</span>
                </div>
              </div>

              <!-- 自定义主题的角色编辑 -->
              <div class="custom-roles-editor" v-if="isCurrentCustom">
                <p class="custom-hint">编辑每位角色的官职、头衔和提示词：</p>
                <div class="custom-theme-role-block" v-for="minister in debateStore.ministers" :key="minister.id">
                  <div class="custom-role-row">
                    <span class="custom-role-avatar">{{ minister.avatar }}</span>
                    <el-input
                      :model-value="getRoleData(minister.id).name"
                      @update:model-value="(val: string) => onCustomRoleFieldChange(minister.id, 'name', val)"
                      @change="() => saveCustomThemeRoles()"
                      placeholder="官职名"
                      size="small"
                      style="width: 120px"
                    />
                    <el-input
                      :model-value="getRoleData(minister.id).title"
                      @update:model-value="(val: string) => onCustomRoleFieldChange(minister.id, 'title', val)"
                      @change="() => saveCustomThemeRoles()"
                      placeholder="头衔"
                      size="small"
                      style="width: 140px"
                    />
                    <el-button
                      size="small"
                      text
                      :type="expandedPromptRole === minister.id ? 'primary' : 'default'"
                      @click="togglePromptExpand(minister.id)"
                    >
                      {{ getThemePrompt(minister.id) ? '✏️ 提示词' : '➕ 提示词' }}
                    </el-button>
                  </div>
                  <!-- 展开的提示词编辑框 -->
                  <div v-if="expandedPromptRole === minister.id" class="custom-prompt-expand">
                    <el-input
                      :model-value="getThemePrompt(minister.id)"
                      @update:model-value="(val: string) => onThemePromptChange(minister.id, val)"
                      type="textarea"
                      :rows="5"
                      placeholder="输入该角色的 System Prompt，留空则使用默认提示词..."
                    />
                    <div class="custom-prompt-actions">
                      <span class="custom-prompt-hint">留空将回退到全局自定义或 MD 文件默认提示词</span>
                      <el-button size="small" type="primary" @click="saveThemePrompts">保存提示词</el-button>
                    </div>
                  </div>
                </div>
              </div>
            </el-card>

            <!-- 预留：其他设置 -->
            <!-- 未来可以在这里添加更多设置项 -->
          </div>
        </el-tab-pane>

        <!-- LLM 管理 -->
        <el-tab-pane label="LLM 管理" name="llm">
          <div class="tab-header">
            <div>
              <h2 class="section-title">LLM 配置管理</h2>
              <p class="section-desc">添加、管理和测试 LLM 配置</p>
            </div>
            <el-button type="primary" :icon="Plus" @click="openAddLLMDialog">添加 LLM</el-button>
          </div>

          <div class="llm-list">
            <el-card v-for="config in llmConfigs" :key="config.id" shadow="never" class="llm-card">
              <div class="llm-card-row">
                <div class="llm-info">
                  <h3 class="llm-name">{{ config.name }}</h3>
                  <el-tag v-if="config.isDefault" type="warning" size="small" effect="dark">默认</el-tag>
                  <el-tag size="small" effect="plain">{{ getProviderLabel(config.provider) }}</el-tag>
                </div>
                <div class="llm-actions">
                  <el-button v-if="!config.isDefault" :icon="Star" size="small" @click="setDefaultLLM(config.id)">设为默认</el-button>
                  <el-button :icon="Edit" size="small" @click="openEditLLMDialog(config)">编辑</el-button>
                  <el-button :icon="Delete" size="small" type="danger" @click="deleteLLMConfig(config.id)">删除</el-button>
                </div>
              </div>
              <div class="llm-details">
                <span>模型: {{ config.model }}</span>
                <span v-if="config.baseURL"> | URL: {{ config.baseURL }}</span>
              </div>
            </el-card>
          </div>

          <el-empty v-if="llmConfigs.length === 0" description="暂无 LLM 配置，请添加新的配置" />
        </el-tab-pane>

        <!-- 角色配置 -->
        <el-tab-pane label="角色配置" name="ministers">
          <div class="tab-header">
            <div>
              <h2 class="section-title">角色配置</h2>
              <p class="section-desc">为每位朝臣配置 LLM 和 System Prompt</p>
            </div>
            <el-button :icon="RefreshRight" @click="resetAllConfigs">恢复默认</el-button>
          </div>

          <div class="ministers-list">
            <el-card v-for="minister in debateStore.ministers" :key="minister.id" shadow="never" class="minister-card">
              <!-- 角色信息 -->
              <div class="minister-header">
                <div class="minister-info">
                  <el-popover trigger="click" placement="bottom" :width="320">
                    <template #reference>
                      <span class="minister-avatar minister-avatar-clickable" :title="'点击更换头像'">
                        <img v-if="isImageAvatar(minister.avatar)" :src="minister.avatar" class="minister-avatar-img" />
                        <span v-else>{{ minister.avatar }}</span>
                      </span>
                    </template>
                    <div class="avatar-editor">
                      <div class="avatar-editor-title">选择头像</div>
                      <div class="avatar-emoji-grid">
                        <span
                          v-for="emoji in avatarEmojiOptions"
                          :key="emoji"
                          class="avatar-emoji-option"
                          :class="{ active: minister.avatar === emoji }"
                          @click="setAvatarFromEmoji(minister.id, emoji)"
                        >{{ emoji }}</span>
                      </div>
                      <div class="avatar-url-row">
                        <el-input
                          v-model="avatarUrlInputs[minister.id]"
                          placeholder="图片 URL"
                          size="small"
                          @keydown.enter="setAvatarFromUrl(minister.id)"
                        />
                        <el-button size="small" type="primary" @click="setAvatarFromUrl(minister.id)">应用</el-button>
                      </div>
                      <div class="avatar-reset-row">
                        <el-button size="small" text type="danger" @click="resetAvatar(minister.id)">恢复默认</el-button>
                      </div>
                    </div>
                  </el-popover>
                  <div>
                    <h3 class="minister-name">{{ minister.name }}</h3>
                    <p class="minister-title">{{ minister.title }}</p>
                  </div>
                </div>
                <div class="minister-desc">
                  {{ minister.description }}
                  <el-tag
                    :type="getPromptSource(minister.id) === '自定义' ? 'warning' : 'info'"
                    size="small"
                    effect="plain"
                  >
                    {{ getPromptSource(minister.id) }}
                  </el-tag>
                </div>
              </div>

              <!-- LLM 选择 -->
              <div class="config-section">
                <label class="config-section-label">LLM 模型</label>
                <div class="config-row">
                  <el-select v-model="ministerLLMMap[minister.id]" class="flex-1" placeholder="选择 LLM">
                    <el-option
                      v-for="llm in llmConfigs"
                      :key="llm.id"
                      :value="llm.id"
                      :label="`${llm.name} (${llm.model})`"
                    />
                  </el-select>
                  <el-button type="primary" @click="saveMinisterConfig(minister.id)">保存</el-button>
                </div>
              </div>

              <!-- Prompt 配置 -->
              <div class="config-section">
                <label class="config-section-label">System Prompt</label>
                <div class="prompt-preview">{{ minister.systemPrompt }}</div>
                <div class="prompt-actions">
                  <el-button :icon="Edit" size="small" @click="openEditPromptDialog(minister.id)">编辑 Prompt</el-button>
                  <el-button
                    size="small"
                    :disabled="getPromptSource(minister.id) === 'MD 文件'"
                    @click="resetPrompt(minister.id)"
                  >
                    重置
                  </el-button>
                </div>
              </div>

              <!-- 技能绑定 -->
              <div class="config-section">
                <label class="config-section-label">绑定技能</label>
                <div class="minister-skills" v-if="getMinisterSkills(minister.id).length > 0">
                  <el-tag
                    v-for="skill in getMinisterSkills(minister.id)"
                    :key="skill.id"
                    size="small"
                    effect="plain"
                    class="minister-skill-tag"
                  >
                    {{ skill.icon }} {{ skill.name }}
                  </el-tag>
                </div>
                <span v-else class="skill-empty-hint">未绑定技能，请在“技能管理”标签中配置</span>
              </div>
            </el-card>
          </div>
        </el-tab-pane>

        <!-- 技能管理 -->
        <el-tab-pane label="技能管理" name="skills">
          <div class="tab-header">
            <div>
              <h2 class="section-title">技能管理 (Skill)</h2>
              <p class="section-desc">管理角色可用的工具技能，每个 Skill 包含一组 Function Call 工具</p>
            </div>
          </div>

          <!-- 已注册技能列表 -->
          <div class="skills-overview">
            <el-card v-for="skill in allSkills" :key="skill.id" shadow="never" class="skill-card">
              <div class="skill-header">
                <div class="skill-info">
                  <span class="skill-icon">{{ skill.icon }}</span>
                  <div>
                    <h3 class="skill-name">{{ skill.name }}</h3>
                    <p class="skill-desc">{{ skill.description }}</p>
                  </div>
                </div>
                <div class="skill-meta">
                  <el-tag size="small" effect="plain">{{ getSkillCategoryLabel(skill.category) }}</el-tag>
                  <el-tag size="small" type="info">{{ skill.tools.length }} 个工具</el-tag>
                </div>
              </div>

              <!-- 绑定到角色 -->
              <div class="skill-bindings">
                <span class="binding-label">绑定角色：</span>
                <div class="binding-chips">
                  <el-check-tag
                    v-for="minister in debateStore.ministers"
                    :key="minister.id"
                    :checked="isSkillBound(skill.id, minister.id)"
                    @change="(checked: boolean) => toggleSkillForMinister(skill.id, minister.id, checked)"
                  >
                    {{ minister.avatar }} {{ minister.name }}
                  </el-check-tag>
                </div>
              </div>

              <!-- 工具详情 -->
              <div class="skill-tools">
                <div v-for="tool in skill.tools" :key="tool.function.name" class="tool-item">
                  <code class="tool-name">{{ tool.function.name }}</code>
                  <span class="tool-desc">{{ tool.function.description }}</span>
                </div>
              </div>
            </el-card>
          </div>

          <el-empty v-if="allSkills.length === 0" description="暂无已注册的技能" />
        </el-tab-pane>

        <!-- 插件管理 -->
        <el-tab-pane label="插件管理" name="plugins">
          <div class="tab-header">
            <div>
              <h2 class="section-title">自定义工具插件</h2>
              <p class="section-desc">通过 SKILL.md 文件定义自定义工具，插件放在 plugins 目录中自动发现</p>
            </div>
            <div style="display: flex; gap: 8px">
              <el-button @click="importPlugin" :loading="importingPlugin">导入插件</el-button>
              <el-button @click="reloadPlugins" :loading="pluginsLoading">重新加载</el-button>
              <el-button type="primary" @click="openPluginDir">打开插件目录</el-button>
            </div>
          </div>

          <!-- 已加载的插件列表 -->
          <div class="plugins-list" v-if="loadedPlugins.length > 0">
            <el-card v-for="plugin in loadedPlugins" :key="plugin.manifest.id" shadow="never" class="plugin-card">
              <div class="plugin-header">
                <div class="plugin-info">
                  <span class="plugin-icon">{{ plugin.manifest.icon || '🔌' }}</span>
                  <div>
                    <h3 class="plugin-name">{{ plugin.manifest.name }}</h3>
                    <p class="plugin-desc">{{ plugin.manifest.description }}</p>
                  </div>
                </div>
                <div class="plugin-meta">
                  <el-tag size="small" type="success">已加载</el-tag>
                  <el-tag size="small" type="info">{{ plugin.toolDefinitions.length }} 个工具</el-tag>
                  <span v-if="plugin.manifest.version" class="plugin-version">v{{ plugin.manifest.version }}</span>
                </div>
              </div>
              <div class="plugin-tools">
                <div v-for="tool in plugin.toolDefinitions" :key="tool.function.name" class="tool-item">
                  <code class="tool-name">{{ tool.function.name }}</code>
                  <span class="tool-desc">{{ tool.function.description }}</span>
                </div>
              </div>
            </el-card>
          </div>

          <!-- 插件错误列表 -->
          <div v-if="pluginErrors.length > 0" style="margin-top: 16px">
            <el-alert
              v-for="(err, idx) in pluginErrors"
              :key="idx"
              :title="`插件加载失败: ${err.filePath}`"
              :description="err.error"
              type="error"
              show-icon
              :closable="false"
              style="margin-bottom: 8px"
            />
          </div>

          <el-empty v-if="loadedPlugins.length === 0 && pluginErrors.length === 0" description="暂无自定义插件，请在插件目录中创建 SKILL.md 文件" />

          <!-- 插件格式说明 -->
          <el-card shadow="never" class="settings-card" style="margin-top: 16px">
            <h3 class="card-title">SKILL.md 格式说明</h3>
            <pre class="plugin-format-example">---
id: my_plugin
name: 我的插件
description: 自定义工具描述
icon: 🔧
category: system
tools:
  - name: my_tool
    description: 工具功能描述
    parameters:
      type: object
      properties:
        input:
          type: string
          description: 输入参数
      required: [input]
handler: |
  async function my_tool(args) {
    return { result: args.input.toUpperCase() }
  }
---</pre>
          </el-card>
        </el-tab-pane>

        <!-- 沙箱安全 -->
        <el-tab-pane label="沙箱安全" name="sandbox">
          <div class="tab-header">
            <div>
              <h2 class="section-title">沙箱安全配置</h2>
              <p class="section-desc">命令执行的安全隔离策略，限制文件访问、网络和系统资源</p>
            </div>
          </div>

          <div class="settings-sections">
            <el-card shadow="never" class="settings-card">
              <h3 class="card-title">沙箱开关</h3>
              <div class="settings-item">
                <div class="settings-item-info">
                  <span class="settings-item-label">启用沙箱隔离</span>
                  <span class="settings-item-desc">命令在受限环境中执行，限制文件访问和危险操作</span>
                </div>
                <el-switch v-model="sandboxEnabled" @change="onSandboxChange" />
              </div>
              <div class="settings-item">
                <div class="settings-item-info">
                  <span class="settings-item-label">网络隔离</span>
                  <span class="settings-item-desc">禁止子进程访问网络（通过设置无效代理实现）</span>
                </div>
                <el-switch v-model="sandboxBlockNetwork" @change="onSandboxChange" :disabled="!sandboxEnabled" />
              </div>
            </el-card>

            <el-card shadow="never" class="settings-card">
              <h3 class="card-title">资源限制</h3>
              <div class="settings-item">
                <div class="settings-item-info">
                  <span class="settings-item-label">子进程最大内存 (MB)</span>
                  <span class="settings-item-desc">限制命令执行时的内存使用，默认 512MB</span>
                </div>
                <el-input-number
                  v-model="sandboxMaxMemory"
                  :min="128"
                  :max="2048"
                  :step="128"
                  size="small"
                  @change="onSandboxChange"
                  :disabled="!sandboxEnabled"
                />
              </div>
              <div class="settings-item">
                <div class="settings-item-info">
                  <span class="settings-item-label">最大超时时间 (ms)</span>
                  <span class="settings-item-desc">命令执行的最大等待时间，默认 120000ms (2分钟)</span>
                </div>
                <el-input-number
                  v-model="sandboxMaxTimeout"
                  :min="10000"
                  :max="300000"
                  :step="10000"
                  size="small"
                  @change="onSandboxChange"
                  :disabled="!sandboxEnabled"
                />
              </div>
            </el-card>

            <el-card shadow="never" class="settings-card">
              <h3 class="card-title">安全策略说明</h3>
              <ul class="sandbox-strategy-list">
                <li><strong>文件系统：</strong>仅允许访问用户选择的工作目录</li>
                <li><strong>危险命令：</strong>屏蔽 format、fdisk、rm -rf /、shutdown 等危险操作</li>
                <li><strong>管道注入：</strong>屏蔽 curl|bash、eval 等注入模式</li>
                <li><strong>超时强制：</strong>超时后强制终止进程树（taskkill /T /F）</li>
                <li><strong>审批机制：</strong>所有命令执行前需用户确认</li>
              </ul>
            </el-card>
          </div>
        </el-tab-pane>

        <!-- 消息集成 -->
        <el-tab-pane label="消息集成" name="messaging">
          <div class="tab-header">
            <div>
              <h2 class="section-title">消息平台集成</h2>
              <p class="section-desc">将朝议结果推送到企业微信等消息平台，支持接收消息触发辩论</p>
            </div>
          </div>

          <div class="settings-sections">
            <!-- 企业微信配置 -->
            <el-card shadow="never" class="settings-card">
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 16px">
                <span style="font-size: 20px">💬</span>
                <h3 class="card-title" style="margin: 0">企业微信 Webhook</h3>
                <el-tag :type="wecomConnected ? 'success' : 'info'" size="small">
                  {{ wecomConnected ? '已连接' : '未连接' }}
                </el-tag>
              </div>

              <div class="settings-item">
                <div class="settings-item-info">
                  <span class="settings-item-label">Webhook URL</span>
                  <span class="settings-item-desc">企业微信群机器人的 Webhook 地址</span>
                </div>
              </div>
              <el-input
                v-model="wecomWebhookUrl"
                placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
                style="margin-bottom: 12px"
              />

              <div class="settings-item">
                <div class="settings-item-info">
                  <span class="settings-item-label">辩论完成后自动推送</span>
                  <span class="settings-item-desc">朝议结束后自动将结果摘要发送到群聊</span>
                </div>
                <el-switch v-model="autoPushResults" @change="saveMessagingConfigValues" />
              </div>

              <div style="display: flex; gap: 8px; margin-top: 12px">
                <el-button @click="saveMessagingConfigValues" type="primary">保存配置</el-button>
                <el-button @click="testWeComConnection" :loading="testingWeCom">测试连接</el-button>
              </div>
            </el-card>

            <!-- Webhook 服务器 -->
            <el-card shadow="never" class="settings-card">
              <h3 class="card-title">Webhook 回调服务器</h3>
              <p class="card-desc">启动本地 HTTP 服务器接收企业微信的回调消息，实现双向消息交互</p>

              <div class="settings-item">
                <div class="settings-item-info">
                  <span class="settings-item-label">回调端口</span>
                  <span class="settings-item-desc">本地 HTTP 服务器监听端口，默认 9527</span>
                </div>
                <el-input-number
                  v-model="webhookPort"
                  :min="1024"
                  :max="65535"
                  size="small"
                />
              </div>

              <div class="settings-item">
                <div class="settings-item-info">
                  <span class="settings-item-label">服务器状态</span>
                  <el-tag :type="webhookServerRunning ? 'success' : 'info'" size="small">
                    {{ webhookServerRunning ? '运行中' : '已停止' }}
                  </el-tag>
                </div>
                <div style="display: flex; gap: 8px">
                  <el-button
                    v-if="!webhookServerRunning"
                    type="primary"
                    size="small"
                    @click="startServer"
                    :loading="serverLoading"
                  >启动</el-button>
                  <el-button
                    v-else
                    type="danger"
                    size="small"
                    @click="stopServer"
                    :loading="serverLoading"
                  >停止</el-button>
                </div>
              </div>
            </el-card>
          </div>
        </el-tab-pane>

        <!-- 数据洞察 -->
        <el-tab-pane label="数据洞察" name="insights">
          <div class="tab-header">
            <div>
              <h2 class="section-title">数据洞察</h2>
              <p class="section-desc">Token 统计、费用估算、模型使用分析和决策时间线</p>
            </div>
          </div>

          <div class="settings-sections">
            <!-- 总览卡片 -->
            <el-card shadow="never" class="settings-card">
              <h3 class="card-title">全局统计</h3>
              <div class="stats-grid">
                <div class="stat-item">
                  <span class="stat-value">{{ globalStats.totalDebates }}</span>
                  <span class="stat-label">总会话数</span>
                </div>
                <div class="stat-item">
                  <span class="stat-value">{{ globalStats.completedDebates }}</span>
                  <span class="stat-label">已完成</span>
                </div>
                <div class="stat-item">
                  <span class="stat-value">{{ globalStats.speechCount }}</span>
                  <span class="stat-label">大臣发言</span>
                </div>
                <div class="stat-item">
                  <span class="stat-value">{{ formatTokens(globalStats.totalTokens) }}</span>
                  <span class="stat-label">总 Token</span>
                </div>
                <div class="stat-item">
                  <span class="stat-value">{{ formatTokens(globalStats.totalPromptTokens) }}</span>
                  <span class="stat-label">输入 Token</span>
                </div>
                <div class="stat-item">
                  <span class="stat-value">{{ formatTokens(globalStats.totalCompletionTokens) }}</span>
                  <span class="stat-label">输出 Token</span>
                </div>
                <div class="stat-item">
                  <span class="stat-value">{{ formatCost(globalStats.totalCost) }}</span>
                  <span class="stat-label">估算总费用</span>
                </div>
                <div class="stat-item">
                  <span class="stat-value">{{ formatDuration(globalStats.avgDuration) }}</span>
                  <span class="stat-label">平均响应时间</span>
                </div>
              </div>
            </el-card>

            <!-- 模型使用比例 -->
            <el-card shadow="never" class="settings-card" v-if="globalStats.modelBreakdown.length > 0">
              <h3 class="card-title">模型使用分析</h3>
              <div class="model-breakdown-list">
                <div v-for="item in globalStats.modelBreakdown" :key="item.model" class="model-breakdown-item">
                  <div class="model-breakdown-info">
                    <span class="model-breakdown-name">{{ item.model }}</span>
                    <span class="model-breakdown-count">{{ item.count }} 次发言</span>
                  </div>
                  <div class="model-breakdown-stats">
                    <span>{{ formatTokens(item.tokens) }} tokens</span>
                    <span>{{ formatCost(item.cost) }}</span>
                  </div>
                  <div class="model-breakdown-bar">
                    <div
                      class="model-breakdown-bar-fill"
                      :style="{ width: (item.tokens / globalStats.totalTokens * 100) + '%' }"
                    ></div>
                  </div>
                </div>
              </div>
            </el-card>

            <!-- 决策时间线 -->
            <el-card shadow="never" class="settings-card" v-if="decisionTimeline.length > 0">
              <h3 class="card-title">决策时间线（最近 {{ decisionTimeline.length }} 次）</h3>
              <div class="timeline-list">
                <div v-for="item in decisionTimeline" :key="item.id" class="timeline-item">
                  <div class="timeline-dot"></div>
                  <div class="timeline-content">
                    <div class="timeline-header">
                      <span class="timeline-topic">{{ item.topic }}</span>
                      <span class="timeline-date">{{ formatDate(item.createdAt) }}</span>
                    </div>
                    <div class="timeline-meta">
                      <span>{{ item.speechCount }} 次发言</span>
                      <span>{{ formatTokens(item.totalTokens) }} tokens</span>
                      <span>{{ formatCost(item.totalCost) }}</span>
                      <el-tag v-for="tag in item.tags" :key="tag" size="small" effect="plain">{{ tag }}</el-tag>
                    </div>
                    <div v-if="item.imperialDecree" class="timeline-decree">
                      📜 {{ item.imperialDecree.length > 60 ? item.imperialDecree.slice(0, 60) + '…' : item.imperialDecree }}
                    </div>
                  </div>
                </div>
              </div>
            </el-card>

            <el-empty
              v-if="globalStats.totalDebates === 0"
              description="暂无会话数据，开始一次朝议后将自动生成统计"
            />
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>

    <!-- LLM 配置弹窗 -->
    <el-dialog
      v-model="showLLMDialog"
      :title="editingLLM ? '编辑 LLM 配置' : '添加 LLM 配置'"
      width="520px"
      destroy-on-close
    >
      <el-form :model="llmForm" label-position="top">
        <el-form-item label="名称 *">
          <el-input v-model="llmForm.name" placeholder="例如：我的 GPT-4" />
        </el-form-item>

        <el-form-item label="提供商 *">
          <el-select v-model="llmForm.provider" style="width: 100%">
            <el-option
              v-for="opt in providerOptions"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="模型 *">
          <div class="model-select-row">
            <el-select
              v-model="llmForm.model"
              filterable
              allow-create
              default-first-option
              :reserve-keyword="false"
              placeholder="选择或手动输入模型名称"
              style="flex: 1"
            >
              <el-option-group label="可用模型">
                <el-option
                  v-for="model in availableModels"
                  :key="model"
                  :label="model"
                  :value="model"
                />
              </el-option-group>
            </el-select>
            <el-button
              :icon="Refresh"
              :loading="fetchingModels"
              @click="fetchRemoteModels"
              title="从 API 获取可用模型"
            >
              {{ fetchingModels ? '' : '获取' }}
            </el-button>
          </div>
          <div class="form-hint" v-if="fetchedModels.length > 0">
            已从远程获取 {{ fetchedModels.length }} 个模型
          </div>
        </el-form-item>

        <el-form-item label="API Key">
          <el-input v-model="llmForm.apiKey" type="password" show-password placeholder="sk-..." autocomplete="new-password" />
        </el-form-item>

        <el-form-item label="自定义 API 地址（可选）">
          <el-input v-model="llmForm.baseURL" placeholder="https://api.openai.com/v1" />
        </el-form-item>

        <el-form-item>
          <div class="form-row">
            <div class="form-col">
              <label class="form-col-label">温度 (0-2)</label>
              <el-input-number v-model="llmForm.temperature" :min="0" :max="2" :step="0.1" :precision="1" style="width: 100%" />
            </div>
            <div class="form-col">
              <label class="form-col-label">最大 Token</label>
              <el-input-number v-model="llmForm.maxTokens" :min="1" style="width: 100%" />
            </div>
          </div>
        </el-form-item>

        <el-alert
          v-if="testResult"
          :title="testResult.message"
          :type="testResult.success ? 'success' : 'error'"
          show-icon
          :closable="false"
        >
          <template v-if="testResult.latency" #default>
            延迟: {{ testResult.latency }}ms
          </template>
        </el-alert>
      </el-form>

      <template #footer>
        <el-button @click="closeLLMDialog">取消</el-button>
        <el-button :loading="testing" @click="testLLMConfig">
          {{ testing ? '测试中...' : '测试连接' }}
        </el-button>
        <el-button type="primary" @click="saveLLMConfig">保存</el-button>
      </template>
    </el-dialog>

    <!-- Prompt 编辑弹窗 -->
    <el-dialog
      v-model="showPromptDialog"
      :title="`编辑 Prompt - ${promptForm.name}`"
      width="600px"
      destroy-on-close
    >
      <el-form label-position="top">
        <el-form-item label="角色名称">
          <el-input v-model="promptForm.name" disabled />
        </el-form-item>

        <el-form-item label="角色头衔">
          <el-input v-model="promptForm.title" disabled />
        </el-form-item>

        <el-form-item label="角色描述">
          <el-input v-model="promptForm.description" type="textarea" :rows="2" placeholder="简短描述角色特点" />
        </el-form-item>

        <el-form-item label="System Prompt *">
          <el-input v-model="promptForm.systemPrompt" type="textarea" :rows="8" placeholder="设置此角色的系统提示词..." />
          <div class="form-hint">提示：详细描述角色的性格、说话风格、职责等</div>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="closePromptDialog">取消</el-button>
        <el-button type="primary" @click="savePromptConfig">保存</el-button>
      </template>
    </el-dialog>

    <!-- 新建自定义主题弹窗 -->
    <el-dialog
      v-model="showNewThemeDialog"
      title="新建自定义主题"
      width="420px"
      destroy-on-close
    >
      <el-form label-position="top">
        <el-form-item label="主题名称 *">
          <el-input v-model="newThemeForm.name" placeholder="例如：IT开发、大宗贸易、医疗团队" />
        </el-form-item>

        <el-form-item label="图标">
          <div class="icon-picker">
            <span
              v-for="icon in iconOptions"
              :key="icon"
              class="icon-option"
              :class="{ 'icon-option-active': newThemeForm.icon === icon }"
              @click="newThemeForm.icon = icon"
            >{{ icon }}</span>
          </div>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="showNewThemeDialog = false">取消</el-button>
        <el-button type="primary" @click="createCustomTheme">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.settings-container {
  min-height: 100vh;
  background: var(--ct-bg);
  padding: 24px;
}

.settings-content {
  max-width: 1000px;
  margin: 0 auto;
}

.settings-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
}

.settings-title {
  font-size: 28px;
  font-weight: 700;
  color: var(--ct-accent);
  margin: 0;
}

.settings-tabs :deep(.el-tabs__header) {
  margin-bottom: 24px;
}

.settings-tabs :deep(.el-tabs__nav-wrap::after) {
  background-color: var(--ct-border);
}

.tab-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
}

.section-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--ct-text-primary);
  margin-bottom: 4px;
}

.section-desc {
  font-size: 14px;
  color: var(--ct-text-secondary);
  margin: 0;
}

/* LLM 列表 */
.llm-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.llm-card {
  --el-card-bg-color: var(--ct-bg-secondary);
  --el-card-border-color: var(--ct-border);
}

.llm-card-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.llm-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.llm-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--ct-text-primary);
  margin: 0;
}

.llm-actions {
  display: flex;
  gap: 6px;
}

.llm-details {
  font-size: 13px;
  color: var(--ct-text-secondary);
}

/* 角色卡片 */
.ministers-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.minister-card {
  --el-card-bg-color: var(--ct-bg-secondary);
  --el-card-border-color: var(--ct-border);
}

.minister-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
}

.minister-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.minister-avatar {
  font-size: 36px;
  cursor: default;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  overflow: hidden;
  flex-shrink: 0;
}

.minister-avatar-clickable {
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
}

.minister-avatar-clickable:hover {
  transform: scale(1.1);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.minister-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 12px;
}

/* 头像编辑器弹出层 */
.avatar-editor-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ct-text-primary);
  margin-bottom: 10px;
}

.avatar-emoji-grid {
  display: grid;
  grid-template-columns: repeat(10, 1fr);
  gap: 4px;
  margin-bottom: 12px;
}

.avatar-emoji-option {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
  border: 2px solid transparent;
}

.avatar-emoji-option:hover {
  background: var(--ct-bg-tertiary);
  transform: scale(1.15);
}

.avatar-emoji-option.active {
  border-color: var(--ct-accent);
  background: var(--ct-bg-tertiary);
}

.avatar-url-row {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}

.avatar-reset-row {
  display: flex;
  justify-content: flex-end;
}

.minister-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--ct-text-primary);
  margin: 0;
}

.minister-title {
  font-size: 13px;
  color: var(--ct-text-secondary);
  margin: 2px 0 0 0;
}

.minister-desc {
  font-size: 13px;
  color: var(--ct-text-secondary);
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 配置分区 */
.config-section {
  padding-top: 16px;
  border-top: 1px solid var(--ct-border);
  margin-top: 12px;
}

.config-section:first-of-type {
  border-top: none;
  margin-top: 0;
}

.config-section-label {
  display: block;
  font-size: 12px;
  color: var(--ct-text-secondary);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}

.config-row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.config-row .flex-1 {
  flex: 1;
}

/* Prompt 预览 */
.prompt-preview {
  padding: 12px;
  background: var(--ct-bg);
  border: 1px solid var(--ct-border);
  border-radius: 6px;
  color: var(--ct-text-primary);
  font-size: 13px;
  line-height: 1.6;
  font-family: 'Courier New', monospace;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow-y: auto;
  margin-bottom: 8px;
}

.prompt-actions {
  display: flex;
  gap: 8px;
}

/* 表单辅助 */
.form-row {
  display: flex;
  gap: 16px;
  width: 100%;
}

.form-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-col-label {
  font-size: 14px;
  color: var(--ct-text-primary);
}

.form-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--ct-text-secondary);
}

.model-select-row {
  display: flex;
  gap: 8px;
  align-items: center;
  width: 100%;
}

/* 通用设置 */
.settings-sections {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.settings-card {
  --el-card-bg-color: var(--ct-bg-secondary);
  --el-card-border-color: var(--ct-border);
}

.card-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--ct-text-primary);
  margin: 0 0 16px 0;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--ct-border);
}

.settings-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
}

.settings-item + .settings-item {
  border-top: 1px solid var(--ct-border-light);
}

.settings-item-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.settings-item-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--ct-text-primary);
}

.settings-item-desc {
  font-size: 12px;
  color: var(--ct-text-secondary);
}

.summary-model-select {
  min-width: 240px;
}

.max-rounds-control {
  flex-shrink: 0;
}

.font-size-setting {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

/* Skill 管理 */
.skills-overview {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.skill-card {
  --el-card-bg-color: var(--ct-bg-secondary);
  --el-card-border-color: var(--ct-border);
}

.skill-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 12px;
}

.skill-info {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.skill-icon {
  font-size: 28px;
  flex-shrink: 0;
}

.skill-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--ct-text-primary);
  margin: 0 0 4px 0;
}

.skill-desc {
  font-size: 13px;
  color: var(--ct-text-secondary);
  margin: 0;
}

.skill-meta {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.skill-bindings {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 0;
  border-top: 1px solid var(--ct-border);
  flex-wrap: wrap;
}

.binding-label {
  font-size: 12px;
  color: var(--ct-text-secondary);
  font-weight: 600;
  flex-shrink: 0;
}

.binding-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.skill-tools {
  padding-top: 12px;
  border-top: 1px solid var(--ct-border);
}

.tool-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
}

.tool-name {
  background: var(--ct-bg-tertiary);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--ct-accent);
  flex-shrink: 0;
}

.tool-desc {
  color: var(--ct-text-secondary);
  font-size: 12px;
}

/* 角色卡片中的技能标签 */
.minister-skills {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.minister-skill-tag {
  font-size: 11px;
}

/* 朝代风格预览 */
.dynasty-roles-preview {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--ct-border);
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.dynasty-role-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--ct-bg-tertiary);
  border-radius: 8px;
}

.dynasty-role-avatar {
  font-size: 20px;
  flex-shrink: 0;
}

.dynasty-role-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--ct-text-primary);
}

.dynasty-role-title {
  font-size: 12px;
  color: var(--ct-text-secondary);
  margin-left: auto;
}

/* 自定义角色编辑 */
.custom-roles-editor {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--ct-border);
}

.custom-hint {
  font-size: 13px;
  color: var(--ct-text-secondary);
  margin: 0 0 12px;
}

.custom-role-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
}

.custom-role-avatar {
  font-size: 20px;
  width: 28px;
  text-align: center;
  flex-shrink: 0;
}

/* 朝代选择行 */
.dynasty-select-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 图标选择器 */
.icon-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.icon-option {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  border-radius: 8px;
  cursor: pointer;
  border: 2px solid transparent;
  background: var(--ct-bg-tertiary);
  transition: all 0.15s;
}

.icon-option:hover {
  background: var(--ct-bg-secondary);
  border-color: var(--ct-border);
}

.icon-option-active {
  border-color: var(--ct-accent);
  background: var(--ct-bg-secondary);
}

/* 自定义主题角色块 */
.custom-theme-role-block {
  margin-bottom: 8px;
}

.custom-prompt-expand {
  margin: 8px 0 12px 36px;
  padding: 12px;
  background: var(--ct-bg-tertiary);
  border-radius: 8px;
}

.custom-prompt-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
}

.custom-prompt-hint {
  font-size: 12px;
  color: var(--ct-text-secondary);
}

/* 插件管理样式 */
.plugin-card {
  margin-bottom: 12px;
}

.plugin-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.plugin-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.plugin-icon {
  font-size: 24px;
}

.plugin-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--ct-text-primary);
  margin: 0;
}

.plugin-desc {
  font-size: 13px;
  color: var(--ct-text-secondary);
  margin: 2px 0 0;
}

.plugin-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.plugin-version {
  font-size: 12px;
  color: var(--ct-text-secondary);
}

.plugin-tools {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--ct-border);
}

.plugin-format-example {
  font-size: 12px;
  background: var(--ct-bg-tertiary);
  padding: 12px;
  border-radius: 6px;
  overflow-x: auto;
  line-height: 1.5;
  margin: 0;
  color: var(--ct-text-primary);
}

/* 沙箱安全样式 */
.sandbox-strategy-list {
  margin: 0;
  padding-left: 20px;
  font-size: 14px;
  color: var(--ct-text-secondary);
  line-height: 2;
}

.sandbox-strategy-list strong {
  color: var(--ct-text-primary);
}

.card-desc {
  font-size: 13px;
  color: var(--ct-text-secondary);
  margin: 0 0 12px;
}

/* 数据洞察 - 统计网格 */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 12px;
  background: var(--ct-bg-tertiary);
  border-radius: 8px;
}

.stat-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--ct-accent);
}

.stat-label {
  font-size: 12px;
  color: var(--ct-text-secondary);
}

/* 模型使用分析 */
.model-breakdown-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.model-breakdown-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.model-breakdown-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.model-breakdown-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--ct-text-primary);
}

.model-breakdown-count {
  font-size: 12px;
  color: var(--ct-text-secondary);
}

.model-breakdown-stats {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--ct-text-secondary);
}

.model-breakdown-bar {
  height: 4px;
  background: var(--ct-bg-tertiary);
  border-radius: 2px;
  overflow: hidden;
}

.model-breakdown-bar-fill {
  height: 100%;
  background: var(--ct-accent);
  border-radius: 2px;
  transition: width 0.3s;
}

/* 决策时间线 */
.timeline-list {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.timeline-item {
  display: flex;
  gap: 12px;
  padding: 12px 0;
  position: relative;
}

.timeline-item + .timeline-item {
  border-top: 1px solid var(--ct-border-light);
}

.timeline-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ct-accent);
  flex-shrink: 0;
  margin-top: 6px;
}

.timeline-content {
  flex: 1;
  min-width: 0;
}

.timeline-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 6px;
}

.timeline-topic {
  font-size: 14px;
  font-weight: 600;
  color: var(--ct-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.timeline-date {
  font-size: 12px;
  color: var(--ct-text-secondary);
  flex-shrink: 0;
}

.timeline-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--ct-text-secondary);
  flex-wrap: wrap;
  align-items: center;
}

.timeline-decree {
  margin-top: 6px;
  font-size: 12px;
  color: var(--ct-text-secondary);
  padding: 6px 10px;
  background: var(--ct-bg-tertiary);
  border-radius: 6px;
  border-left: 3px solid var(--ct-accent);
}
</style>
