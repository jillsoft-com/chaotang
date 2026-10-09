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

  if (editingLLM.value) {
    llmService.update(editingLLM.value.id, config)
  } else {
    llmService.add(config)
  }

  closeLLMDialog()
  ElMessage.success('LLM 配置已保存')
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
    llmService.delete(id)
    ElMessage.success('已删除')
  } catch {
    // cancelled
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
                  <span class="minister-avatar">{{ minister.avatar }}</span>
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
</style>
