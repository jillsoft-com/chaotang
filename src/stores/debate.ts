import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type { Minister, Debate, Speech, DebateMode, DecisionReport, LLMConfig, Attachment } from '@/types'
import type { LLMProviderType } from '@/types/llm'
import { promptService } from '@/services/prompt-config'
import { postDebateExecutor } from '@/services/agent/post-debate'
import { llmService } from '@/services/llm-config'
import { backgroundScheduler } from '@/services/scheduler'
import { gepaEngine } from '@/services/learning'
import { parseActionItemsFromReport, parseActionItemsFromDecree, executeActionItems } from '@/services/agent/imperial-executor'
import type { ExecutionReport } from '@/services/agent/imperial-executor'
import {
  DYNASTY_PRESETS,
  getCurrentDynastyId,
  setCurrentDynastyId,
  applyDynastyTheme,
  getCustomThemes,
  saveCustomThemes,
  addCustomTheme,
  deleteCustomTheme,
  getAllPresets,
  generateCustomThemeId,
  updateCustomThemePrompts
} from '@/services/dynasty-presets'
import type { DynastyPreset, DynastyRolePrompt } from '@/services/dynasty-presets'

export const useDebateStore = defineStore('debate', () => {
  const ministers = ref<Minister[]>([])
  const sessions = ref<Debate[]>([])
  const activeSessionId = ref<string | null>(null)
  const debates = ref<Debate[]>([])

  // 朝议执行模式（全局偏好，所有朝议共享）
  const debateMode = ref<DebateMode>(
    (localStorage.getItem('debate_mode') as DebateMode) || 'serial'
  )

  // 加载历史朝议
  function loadDebates() {
    const saved = localStorage.getItem('debates_history')
    if (saved) {
      try {
        debates.value = JSON.parse(saved)
      } catch {
        debates.value = []
      }
    }
  }

  function saveDebates() {
    localStorage.setItem('debates_history', JSON.stringify(debates.value))
  }

  // 初始化时加载
  loadDebates()

  // Sprint D - #17：初始化 GEPA 自学习引擎
  gepaEngine.initialize()

  const sortedMinisters = computed(() =>
    [...ministers.value].sort((a, b) => a.order - b.order)
  )

  const activeSession = computed(() =>
    sessions.value.find(s => s.id === activeSessionId.value) || null
  )

  function initializeMinisters() {
    const savedConfig = localStorage.getItem('minister_llm_config')
    const customConfig = savedConfig ? JSON.parse(savedConfig) : {}

    const ministerDefs = [
      { id: 'chancellor', name: '丞相', title: '百官之长', avatar: '👑', order: 1 },
      { id: 'finance', name: '户部尚书', title: '财政大臣', avatar: '💰', order: 2 },
      { id: 'tutor', name: '太傅', title: '帝师元老', avatar: '📚', order: 3 },
      { id: 'general', name: '大将军', title: '武官之首', avatar: '⚔️', order: 4 },
      { id: 'censor', name: '御史', title: '监察御史', avatar: '🔍', order: 5 },
      { id: 'eunuch', name: '司礼监总管', title: '内廷心腹', avatar: '🏮', order: 6 }
    ]

    // 应用朝代主题
    applyDynastyTheme(ministerDefs)

    // 应用自定义头像覆盖
    const customAvatars = JSON.parse(localStorage.getItem('minister_custom_avatars') || '{}') as Record<string, string>

    ministers.value = ministerDefs.map(def => {
      const promptConfig = promptService.getPrompt(def.id)
      return {
        id: def.id,
        name: def.name,
        title: def.title,
        avatar: customAvatars[def.id] || def.avatar,
        systemPrompt: promptConfig.systemPrompt,
        llm: customConfig[def.id] || { provider: 'openai' as const, model: 'gpt-4o-mini' },
        order: def.order,
        description: promptConfig.description
      }
    })
  }

  // 获取当前朝代 ID
  const currentDynastyId = ref(getCurrentDynastyId())

  // 切换朝代主题
  function switchDynasty(dynastyId: string): void {
    setCurrentDynastyId(dynastyId)
    currentDynastyId.value = dynastyId
    initializeMinisters()  // 重新初始化大臣，应用新主题
  }

  // 设置角色自定义头像
  function setMinisterAvatar(ministerId: string, avatar: string): void {
    const saved = JSON.parse(localStorage.getItem('minister_custom_avatars') || '{}') as Record<string, string>
    if (avatar) {
      saved[ministerId] = avatar
    } else {
      delete saved[ministerId]
    }
    localStorage.setItem('minister_custom_avatars', JSON.stringify(saved))
    // 更新当前内存中的大臣对象
    const minister = ministers.value.find(m => m.id === ministerId)
    if (minister) {
      minister.avatar = avatar || getDefaultAvatar(ministerId)
    }
  }

  function getDefaultAvatar(ministerId: string): string {
    const defaults: Record<string, string> = {
      chancellor: '👑', finance: '💰', tutor: '📚',
      general: '⚔️', censor: '🔍', eunuch: '🏮'
    }
    return defaults[ministerId] || '👤'
  }

  // 保存自定义主题的角色名称并刷新
  function updateCustomThemeRole(themeId: string, roles: Record<string, { name: string; title: string }>): void {
    const themes = getCustomThemes()
    const theme = themes.find(t => t.id === themeId)
    if (theme) {
      theme.roles = roles
      saveCustomThemes(themes)
      // 如果当前选中的就是这个主题，刷新角色
      if (currentDynastyId.value === themeId) {
        initializeMinisters()
      }
    }
  }

  // 新增自定义主题
  function createCustomTheme(name: string, icon: string): string {
    const id = generateCustomThemeId()
    const defaultRoles = DYNASTY_PRESETS[0].roles // 以夏朝为基础复制
    addCustomTheme({ id, name, icon, roles: JSON.parse(JSON.stringify(defaultRoles)) })
    return id
  }

  // 删除自定义主题
  function removeCustomTheme(themeId: string): void {
    deleteCustomTheme(themeId)
    // 如果当前选中的被删了，回退到明朝
    if (currentDynastyId.value === themeId) {
      currentDynastyId.value = 'ming'
      initializeMinisters()
    }
  }

  // 更新自定义主题的提示词并刷新
  function updateCustomThemePrompt(
    themeId: string,
    prompts: Record<string, DynastyRolePrompt>
  ): void {
    updateCustomThemePrompts(themeId, prompts)
    if (currentDynastyId.value === themeId) {
      initializeMinisters()
    }
  }

  // 获取所有朝代预设（内置 + 自定义）
  function getDynastyPresets(): DynastyPreset[] {
    return getAllPresets()
  }

  // 角色问候语
  const greetings: Record<string, string> = {
    chancellor: '陛下召见，老臣即刻赶到。臣在！不知陛下有何圣谕？老臣愿为陛下分忧解愁，粉身碎骨在所不辞。',
    finance: '臣叩见陛下！户部账册已备妥，国库收支明细尽在掌握。陛下今日召见，可是要询问财政之事？',
    tutor: '老臣参见陛下。今日圣上召见，不知是想论经史典籍，还是有朝政之事垂询老臣？',
    general: '末将参见陛下！甲胄在身，未能全礼，望陛下恕罪。但凭陛下一声令下，末将赴汤蹈火，万死不辞！',
    censor: '臣参见陛下。臣近日察访百官言行，已有数本弹劾奏章待呈。不知陛下今日召臣，有何训示？',
    eunuch: '奴婢叩见万岁爷！奴婢时刻恭候主子差遣，宫中上下皆已安排妥帖，请主子示下。'
  }

  // 监听模式变化，持久化到 localStorage
  watch(debateMode, (mode) => {
    localStorage.setItem('debate_mode', mode)
  })

  function startDebate(topic: string, mode: 'court' | 'compare' = 'court', mentionedMinisters?: string[], workingDirectory?: string, attachments?: Attachment[]) {
    const session: Debate = {
      id: Date.now().toString(),
      topic,
      mode,
      debateMode: debateMode.value,  // 记录当前选择的执行模式
      speeches: [
        {
          id: `emperor-topic-${Date.now()}`,
          ministerId: 'emperor',
          content: topic,
          timestamp: Date.now(),
          status: 'completed'
        }
      ],
      status: 'running',
      createdAt: Date.now(),
      mentionedMinisters,
      workingDirectory: workingDirectory || undefined,
      attachments: attachments && attachments.length > 0 ? attachments : undefined
    }
    sessions.value.push(session)
    activeSessionId.value = session.id
  }

  function startPrivateAudience(ministerId: string) {
    const minister = ministers.value.find(m => m.id === ministerId)
    if (!minister) return

    const session: Debate = {
      id: Date.now().toString(),
      topic: `召见${minister.name}`,
      mode: 'private',
      speeches: [
        {
          id: `${ministerId}-greeting-${Date.now()}`,
          ministerId,
          content: greetings[ministerId] || `${minister.name}参见陛下，不知陛下有何吩咐？`,
          timestamp: Date.now(),
          status: 'completed'
        }
      ],
      status: 'running',
      createdAt: Date.now()
    }
    sessions.value.push(session)
    activeSessionId.value = session.id
  }

  function switchSession(id: string) {
    if (sessions.value.some(s => s.id === id)) {
      activeSessionId.value = id
    }
  }

  function closeSession(id: string) {
    const idx = sessions.value.findIndex(s => s.id === id)
    if (idx === -1) return

    sessions.value.splice(idx, 1)

    // 如果关闭的是当前激活的 session，切换到相邻的
    if (activeSessionId.value === id) {
      if (sessions.value.length > 0) {
        const newIdx = Math.min(idx, sessions.value.length - 1)
        activeSessionId.value = sessions.value[newIdx].id
      } else {
        activeSessionId.value = null
      }
    }
  }

  function addSpeech(speech: Speech, sessionId?: string) {
    const target = sessionId
      ? sessions.value.find(s => s.id === sessionId)
      : activeSession.value
    if (target) {
      target.speeches.push(speech)
    }
  }

  function updateSpeech(ministerId: string, content: string) {
    if (activeSession.value) {
      const speech = activeSession.value.speeches.find(
        s => s.ministerId === ministerId && s.status === 'streaming'
      )
      if (speech) {
        speech.content = content
      }
    }
  }

  function completeDebate(imperialDecree?: string, force?: boolean) {
    if (!activeSession.value) return

    const session = activeSession.value

    // 防护检查：确认所有预期的大臣都已发言完毕（force=true 时跳过，用于退朝/拍板）
    if (!force) {
      const mentioned = session.mentionedMinisters
      const expectedMinisters = mentioned && mentioned.length > 0
        ? ministers.value.filter(m => mentioned.includes(m.id))
        : ministers.value

      const allCompleted = expectedMinisters.every(m =>
        session.speeches.some(s => s.ministerId === m.id && (s.status === 'completed' || s.status === 'error'))
      )
      if (!allCompleted) {
        console.warn('[completeDebate] 跳过：并非所有大臣都已发言完毕',
          '预期:', expectedMinisters.map(m => m.id),
          '已发言:', session.speeches.filter(s => s.ministerId !== 'emperor' && s.status === 'completed').map(s => s.ministerId)
        )
        return
      }
    }

    session.status = 'completed'
    session.completedAt = Date.now()
    session.imperialDecree = imperialDecree

    // 深拷贝 speeches
    const snapshot = {
      ...session,
      speeches: [...session.speeches]
    }

    // 如果历史中已有同 ID 的记录，更新它；否则新增
    const existingIdx = debates.value.findIndex(d => d.id === session.id)
    if (existingIdx !== -1) {
      debates.value[existingIdx] = snapshot
    } else {
      debates.value.unshift(snapshot)
    }
    saveDebates()

    // Sprint A - #1：朝议模式自动触发决策报告生成（不阻塞主流程）
    if (session.mode === 'court') {
      generateDecisionReportAsync(session.id).catch(err => {
        console.warn('[completeDebate] 决策报告生成失败:', err)
      })
    }
  }

  /**
   * Sprint D - #3：执行圣旨/决策报告中的行动项
   */
  async function executeImperialDecree(debateId: string): Promise<ExecutionReport | null> {
    const debate = debates.value.find(d => d.id === debateId)
    if (!debate) return null

    // 优先从决策报告解析行动项，否则从圣旨文本解析
    let actionItems
    if (debate.decisionReport?.nextSteps && debate.decisionReport.nextSteps.length > 0) {
      actionItems = parseActionItemsFromReport(debate.decisionReport)
    } else if (debate.imperialDecree) {
      actionItems = parseActionItemsFromDecree(debate.imperialDecree)
    } else {
      return null
    }

    if (actionItems.length === 0) return null

    const report = await executeActionItems(actionItems, debate.workingDirectory)
    return report
  }

  /**
   * Sprint C - #9：为已完成的朝议安排“再上奏”跟踪任务
   * 调用后会在后台定期检查指标，条件触发时生成新奏报
   */
  function scheduleFollowUp(debateId: string, metrics: string[], triggerCondition: string, checkIntervalMs?: number): string | null {
    const debate = debates.value.find(d => d.id === debateId)
    if (!debate) return null
    const task = backgroundScheduler.scheduleFollowUp({
      debateId,
      metrics,
      triggerCondition,
      checkIntervalMs: checkIntervalMs || 30 * 60 * 1000,
      deadline: 0 // 永久跟踪
    })
    return task.id
  }

  /**
   * Sprint C - #9：为已完成的朝议安排长辩论（分阶段执行）
   */
  function scheduleLongDebate(debateId: string, topic: string, stages: string[], stageIntervalMs?: number): string | null {
    const debate = debates.value.find(d => d.id === debateId)
    if (!debate) return null
    const task = backgroundScheduler.scheduleLongDebate({
      debateId,
      topic,
      stages,
      stageIntervalMs: stageIntervalMs || 60 * 60 * 1000
    })
    return task.id
  }

  /**
   * 异步生成决策报告（四象限）
   * 拍板后由丞相的 LLM 汇总产出，结果写入 debates 并持久化
   */
  async function generateDecisionReportAsync(debateId: string): Promise<DecisionReport | null> {
    const debate = debates.value.find(d => d.id === debateId)
    if (!debate || debate.mode !== 'court') return null

    // 优先使用丞相模型，否则回退到默认 LLM
    const chancellor = ministers.value.find(m => m.id === 'chancellor')
    let resolved: LLMConfig | null = chancellor?.llm ? { ...chancellor.llm } : null

    // 尝试用 llmId 取回完整配置（含 apiKey/baseURL）
    if (resolved) {
      const llmId = (resolved as any).llmId
      if (llmId) {
        const fullConfig = llmService.getById(llmId)
        if (fullConfig) {
          resolved = {
            provider: fullConfig.provider,
            model: fullConfig.model,
            apiKey: fullConfig.apiKey,
            baseURL: fullConfig.baseURL
          }
        }
      }
    }

    // 无 apiKey 则回退到默认配置
    if (!resolved || !resolved.apiKey) {
      const defaultCfg = llmService.getAll().find(c => c.isDefault) || llmService.getAll()[0]
      if (!defaultCfg) return null
      resolved = {
        provider: defaultCfg.provider,
        model: defaultCfg.model,
        apiKey: defaultCfg.apiKey,
        baseURL: defaultCfg.baseURL
      }
    }

    if (!resolved) return null

    try {
      const report = await postDebateExecutor.generateDecisionReport(
        debate,
        ministers.value,
        resolved
      )
      // 把报告写回 debates 数组并持久化
      const idx = debates.value.findIndex(d => d.id === debateId)
      if (idx !== -1) {
        debates.value[idx].decisionReport = report
        saveDebates()
      }
      // 同步到 session（如果还开着）
      const sess = sessions.value.find(s => s.id === debateId)
      if (sess) sess.decisionReport = report

      // Sprint D - #17：从决策报告中学习经验模式
      gepaEngine.learnFromDebate(debate, report).catch(err => {
        console.warn('[GEPA] 自学习失败:', err)
      })

      return report
    } catch (err) {
      console.warn('[generateDecisionReportAsync] 失败:', err)
      return null
    }
  }

  function reopenSession(debateId: string) {
    // 如果该会话在 sessions 中已存在（tab 未关闭），直接切换过去
    const existingSession = sessions.value.find(s => s.id === debateId)
    if (existingSession) {
      activeSessionId.value = debateId
      return
    }

    const debate = debates.value.find(d => d.id === debateId)
    if (!debate) return

    // 创建副本加入会话列表，保留历史记录不消失
    const sessionCopy = {
      ...debate,
      status: 'running' as const,
      completedAt: undefined
    }
    sessions.value.push(sessionCopy)
    activeSessionId.value = sessionCopy.id
  }

  function saveMinisterLLMConfig(ministerId: string, llmConfig: { provider: LLMProviderType; model: string; llmId?: string }) {
    const savedConfig = localStorage.getItem('minister_llm_config')
    const config = savedConfig ? JSON.parse(savedConfig) : {}
    config[ministerId] = llmConfig
    localStorage.setItem('minister_llm_config', JSON.stringify(config))

    const minister = ministers.value.find(m => m.id === ministerId)
    if (minister) {
      minister.llm = llmConfig
    }
  }

  function resetMinisterLLMConfig() {
    localStorage.removeItem('minister_llm_config')
    initializeMinisters()
  }

  /**
   * 更新会话参与角色列表
   */
  function updateSessionMinisters(sessionId: string, ministerIds: string[]) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (session) {
      session.mentionedMinisters = ministerIds.length > 0 ? ministerIds : undefined
    }
  }

  /**
   * 更新会话工作目录
   */
  function updateWorkingDirectory(sessionId: string, dir: string) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (session) {
      session.workingDirectory = dir || undefined
    }
  }

  /**
   * 重命名会话
   */
  function renameSession(sessionId: string, newTopic: string) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (session && newTopic.trim()) {
      session.topic = newTopic.trim()
    }
    // 同步更新 debates 历史记录
    const debate = debates.value.find(d => d.id === sessionId)
    if (debate && newTopic.trim()) {
      debate.topic = newTopic.trim()
      saveDebates()
    }
  }

  /**
   * 复制整个会话（生成新 ID，保留所有发言）
   */
  function duplicateSession(sessionId: string) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return

    const newId = Date.now().toString()
    const copy: Debate = {
      ...JSON.parse(JSON.stringify(session)),
      id: newId,
      topic: `${session.topic}（副本）`,
      status: 'running' as const,
      completedAt: undefined
    }
    sessions.value.push(copy)
    activeSessionId.value = newId
  }

  /**
   * 从某个发言位置分叉新会话
   * 保留 speechIndex 之前的所有发言（含 speechIndex 位置的发言）
   */
  function forkSession(sessionId: string, speechIndex: number) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session || speechIndex < 0 || speechIndex >= session.speeches.length) return

    const newId = Date.now().toString()
    const forkedSpeeches = session.speeches.slice(0, speechIndex + 1)
    const fork: Debate = {
      id: newId,
      topic: `${session.topic}（分叉）`,
      mode: session.mode,
      debateMode: session.debateMode,
      speeches: JSON.parse(JSON.stringify(forkedSpeeches)),
      status: 'running' as const,
      createdAt: Date.now(),
      mentionedMinisters: session.mentionedMinisters ? [...session.mentionedMinisters] : undefined,
      workingDirectory: session.workingDirectory
    }
    sessions.value.push(fork)
    activeSessionId.value = newId
  }

  /**
   * 删除历史朝议记录
   */
  function deleteDebate(debateId: string) {
    const idx = debates.value.findIndex(d => d.id === debateId)
    if (idx !== -1) {
      debates.value.splice(idx, 1)
      saveDebates()
    }
    // 如果该会话同时在 sessions 中打开，也关闭它
    closeSession(debateId)
  }

  // ============ Sprint A - #10 会话历史全文搜索 + 标签 ============

  /**
   * 为某个历史朝议添加/移除标签（toggle）
   */
  function toggleDebateTag(debateId: string, tag: string) {
    const normalized = tag.trim()
    if (!normalized) return
    const debate = debates.value.find(d => d.id === debateId)
    if (!debate) return
    const tags = debate.tags ? [...debate.tags] : []
    const idx = tags.indexOf(normalized)
    if (idx >= 0) tags.splice(idx, 1)
    else tags.push(normalized)
    debate.tags = tags
    saveDebates()
    // 同步 session
    const sess = sessions.value.find(s => s.id === debateId)
    if (sess) sess.tags = tags
  }

  /**
   * 直接设置某个朝议的标签列表
   */
  function setDebateTags(debateId: string, tags: string[]) {
    const debate = debates.value.find(d => d.id === debateId)
    if (!debate) return
    debate.tags = tags.map(t => t.trim()).filter(Boolean)
    saveDebates()
    const sess = sessions.value.find(s => s.id === debateId)
    if (sess) sess.tags = debate.tags
  }

  /**
   * 获取所有已使用的标签（按使用次数降序）
   */
  function getAllTags(): Array<{ tag: string; count: number }> {
    const counter = new Map<string, number>()
    for (const d of debates.value) {
      if (Array.isArray(d.tags)) {
        for (const t of d.tags) counter.set(t, (counter.get(t) || 0) + 1)
      }
    }
    return Array.from(counter.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
  }

  /**
   * 全文搜索历史朝议（含活动会话）
   * - query: 关键词（空格分词，OR 匹配）
   * - tagFilter: 标签数组（AND 匹配，全部包含才返回）
   * - limit: 返回数量，默认 50
   */
  function searchDebates(query: string, tagFilter?: string[], limit: number = 50): Debate[] {
    const keywords = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const tagSet = tagFilter && tagFilter.length > 0
      ? new Set(tagFilter.map(t => t.toLowerCase()))
      : null

    // 合并历史朝议 + 活动会话（去重）
    const allDebates: Debate[] = [...debates.value]
    const ids = new Set(allDebates.map(d => d.id))
    for (const s of sessions.value) {
      if (!ids.has(s.id)) allDebates.push(s)
    }

    return allDebates
      .sort((a, b) => b.createdAt - a.createdAt)
      .filter(d => {
        // 标签筛选（AND）
        if (tagSet) {
          const dt = (d.tags || []).map(t => t.toLowerCase())
          for (const need of tagSet) {
            if (!dt.includes(need)) return false
          }
        }
        // 关键词筛选（OR，全匹配任一词即可）
        if (keywords.length === 0) return true
        const haystack = [
          d.topic || '',
          d.imperialDecree || '',
          ...(d.tags || []),
          ...(d.speeches || []).map(s => s.content || '')
        ].join(' ').toLowerCase()
        return keywords.some(k => haystack.includes(k))
      })
      .slice(0, limit)
  }

  /**
   * 确保某个 ID 在 sessions 中存在（如果是历史记录则先 reopen）
   * 返回 session 对象
   */
  function ensureSession(id: string): Debate | null {
    const existing = sessions.value.find(s => s.id === id)
    if (existing) return existing
    // 从 debates 中恢复
    const debate = debates.value.find(d => d.id === id)
    if (!debate) return null
    reopenSession(id)
    return sessions.value.find(s => s.id === id) || null
  }

  return {
    ministers,
    sessions,
    activeSessionId,
    activeSession,
    debates,
    debateMode,
    currentDynastyId,
    sortedMinisters,
    initializeMinisters,
    switchDynasty,
    updateCustomThemeRole,
    setMinisterAvatar,
    createCustomTheme,
    removeCustomTheme,
    updateCustomThemePrompt,
    getDynastyPresets,
    startDebate,
    startPrivateAudience,
    switchSession,
    closeSession,
    addSpeech,
    updateSpeech,
    completeDebate,
    reopenSession,
    saveMinisterLLMConfig,
    resetMinisterLLMConfig,
    updateSessionMinisters,
    updateWorkingDirectory,
    renameSession,
    duplicateSession,
    forkSession,
    deleteDebate,
    ensureSession,
    generateDecisionReportAsync,
    toggleDebateTag,
    setDebateTags,
    getAllTags,
    searchDebates,
    scheduleFollowUp,
    scheduleLongDebate,
    executeImperialDecree
  }
})
