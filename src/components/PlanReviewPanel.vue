<template>
  <div class="plan-review-wrapper">
    <div class="plan-review-panel">
      <!-- 头部 -->
      <header class="plan-header">
        <h3 class="plan-title">📋 执行计划审阅</h3>
        <span class="plan-subtitle">丞相已完成任务拆解，请审阅后批准执行</span>
      </header>

      <!-- 1. 计划概述 -->
      <section class="plan-section">
        <h4 class="plan-section-title" @click="planExpanded = !planExpanded">
          <span>📝 计划概述</span>
          <span class="plan-toggle">{{ planExpanded ? '▾' : '▸' }}</span>
        </h4>
        <div v-if="planExpanded" class="plan-overview">
          <div class="plan-markdown" v-html="renderedPlan"></div>
        </div>
      </section>

      <!-- 2. 子任务列表 -->
      <section class="plan-section">
        <h4 class="plan-section-title">
          <span>🛠️ 子任务 ({{ localTasks.length }})</span>
          <el-button type="primary" link size="small" @click.stop="addTask">
            + 添加任务
          </el-button>
        </h4>
        <div class="plan-tasks">
          <div v-if="localTasks.length === 0" class="plan-empty">
            无子任务，请添加至少一个任务后批准执行
          </div>
          <div
            v-for="(task, index) in localTasks"
            :key="index"
            class="plan-task-item"
          >
            <div class="plan-task-header">
              <span class="plan-task-index">#{{ index + 1 }}</span>
              <el-button
                type="danger"
                link
                size="small"
                @click="removeTask(index)"
                :disabled="localTasks.length <= 1"
              >
                删除
              </el-button>
            </div>

            <!-- 任务描述 -->
            <div class="plan-task-field">
              <label class="plan-label">任务描述</label>
              <el-input
                v-model="task.task"
                type="textarea"
                :autosize="{ minRows: 2, maxRows: 6 }"
                placeholder="输入子任务描述..."
              />
            </div>

            <!-- 分配者 + 模式 -->
            <div class="plan-task-row">
              <div class="plan-task-field plan-field-assignee">
                <label class="plan-label">执行者</label>
                <el-select v-model="task.ministerId" placeholder="选择执行者" size="small">
                  <el-option
                    v-for="m in availableWorkers"
                    :key="m.id"
                    :label="`${m.name}（${m.title}）`"
                    :value="m.id"
                  />
                </el-select>
              </div>
              <div class="plan-task-field plan-field-mode">
                <label class="plan-label">执行模式</label>
                <div class="plan-mode-toggles">
                  <el-tooltip content="自主执行：可迭代多轮（写代码→验证→修复→重跑）" placement="top">
                    <el-button
                      :type="task.autonomous ? 'primary' : 'default'"
                      size="small"
                      @click="task.autonomous = !task.autonomous"
                    >
                      🔧 自主执行
                    </el-button>
                  </el-tooltip>
                  <el-tooltip content="只读模式：仅分析/调研，不修改文件" placement="top">
                    <el-button
                      :type="task.readOnly ? 'warning' : 'default'"
                      size="small"
                      @click="task.readOnly = !task.readOnly"
                    >
                      👁️ 只读
                    </el-button>
                  </el-tooltip>
                </div>
              </div>
            </div>

            <!-- 补充说明（可选） -->
            <div class="plan-task-field">
              <label class="plan-label">
                补充说明
                <span class="plan-label-optional">（可选）</span>
              </label>
              <el-input
                v-model="task.context"
                type="textarea"
                :autosize="{ minRows: 1, maxRows: 3 }"
                placeholder="补充说明..."
              />
            </div>
          </div>
        </div>
      </section>

      <!-- 3. 操作按钮 -->
      <footer class="plan-actions">
        <el-button @click="handleCancel" size="default">
          取消
        </el-button>
        <el-button
          type="primary"
          size="default"
          :disabled="localTasks.length === 0 || !localTasks.some(t => t.task.trim())"
          @click="handleApprove"
        >
          ✅ 批准执行
        </el-button>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { renderSafeMarkdown } from '@/utils/sanitize-markdown'
import type { Minister } from '@/types'

/** 子任务（与 WorkerTask 对齐） */
interface PlanTask {
  ministerId: string
  task: string
  context?: string
  autonomous?: boolean
  readOnly?: boolean
}

/** 计划审阅数据 */
interface PlanData {
  plan: string
  tasks: PlanTask[]
}

const props = defineProps<{
  plan: PlanData
  workers: Minister[]
}>()

const emit = defineEmits<{
  (e: 'approve', data: PlanData): void
  (e: 'cancel'): void
}>()

// ============ 状态 ============

const planExpanded = ref(true)

// 本地可编辑副本
const localTasks = ref<PlanTask[]>(
  props.plan.tasks.map(t => ({ ...t }))
)

// ============ 计算属性 ============

const renderedPlan = computed(() => {
  return renderSafeMarkdown(props.plan.plan)
})

const availableWorkers = computed(() => {
  return props.workers
})

// ============ 方法 ============

function addTask() {
  // 默认分配给第一个 worker
  const defaultMinisterId = props.workers[0]?.id || ''
  localTasks.value.push({
    ministerId: defaultMinisterId,
    task: '',
    context: '',
    autonomous: true,
    readOnly: false
  })
}

function removeTask(index: number) {
  if (localTasks.value.length <= 1) return
  localTasks.value.splice(index, 1)
}

function handleApprove() {
  // 过滤掉空任务
  const validTasks = localTasks.value.filter(t => t.task.trim())
  emit('approve', {
    plan: props.plan.plan,
    tasks: validTasks
  })
}

function handleCancel() {
  emit('cancel')
}
</script>

<style scoped>
.plan-review-wrapper {
  padding: 0 24px 12px;
  max-width: 1100px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}

.plan-review-panel {
  border: 1px solid var(--ct-border);
  border-radius: 12px;
  padding: 18px;
  background: var(--ct-bg-secondary);
}

.plan-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-bottom: 1px solid var(--ct-border);
  padding-bottom: 10px;
  margin-bottom: 12px;
}

.plan-title {
  margin: 0;
  font-size: 18px;
  color: var(--ct-accent);
}

.plan-subtitle {
  font-size: 13px;
  color: var(--ct-text-muted);
}

.plan-section {
  margin-bottom: 14px;
}

.plan-section-title {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--ct-text-primary);
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
  user-select: none;
}

.plan-toggle {
  font-size: 12px;
  color: var(--ct-text-muted);
}

.plan-overview {
  border: 1px solid var(--ct-border);
  border-radius: 6px;
  padding: 10px 14px;
  background: var(--ct-bg);
  max-height: 200px;
  overflow: auto;
}

.plan-markdown {
  font-size: 13px;
  line-height: 1.6;
  color: var(--ct-text-primary);
}

.plan-markdown :deep(p) {
  margin: 0 0 8px;
}

.plan-markdown :deep(p:last-child) {
  margin-bottom: 0;
}

/* 任务列表 */
.plan-tasks {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.plan-empty {
  color: var(--ct-text-muted);
  font-size: 13px;
  text-align: center;
  padding: 12px 0;
}

.plan-task-item {
  border: 1px solid var(--ct-border);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--ct-bg);
}

.plan-task-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.plan-task-index {
  font-size: 13px;
  font-weight: 600;
  color: var(--ct-accent);
}

.plan-task-field {
  margin-bottom: 8px;
}

.plan-task-field:last-child {
  margin-bottom: 0;
}

.plan-label {
  display: block;
  font-size: 12px;
  color: var(--ct-text-secondary);
  margin-bottom: 4px;
}

.plan-label-optional {
  color: var(--ct-text-muted);
  font-weight: normal;
}

.plan-task-row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.plan-field-assignee {
  flex: 1;
  min-width: 0;
}

.plan-field-mode {
  flex-shrink: 0;
}

.plan-mode-toggles {
  display: flex;
  gap: 6px;
}

/* 操作按钮 */
.plan-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding-top: 12px;
  border-top: 1px solid var(--ct-border);
}
</style>
