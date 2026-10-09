# 🎯 LLM 管理系统重构

## 功能需求

### 1. LLM 配置管理
- ✅ 添加自定义 LLM 配置
- ✅ 编辑现有 LLM 配置
- ✅ 删除 LLM 配置
- ✅ 设置默认 LLM
- ✅ 测试 LLM 连接

### 2. 角色配置
- ✅ 为每个角色选择已添加的 LLM
- ✅ 显示所有可用的 LLM 列表
- ✅ 保存角色配置

## 界面设计

### 三个标签页

1. **LLM 管理**
   - 显示所有已添加的 LLM 配置
   - 添加新的 LLM 配置
   - 编辑/删除 LLM 配置
   - 测试连接
   - 设置默认 LLM

2. **角色配置**
   - 显示 6 个朝臣角色
   - 每个角色从已添加的 LLM 中选择
   - 保存配置

3. **API 密钥**（保留原有）
   - OpenAI API Key
   - Claude API Key
   - DeepSeek API Key
   - Ollama 服务地址

## 数据结构

### LLM 配置
```typescript
interface LLMConfig {
  id: string                          // 唯一 ID
  name: string                        // 显示名称
  provider: 'openai' | 'claude' | 'deepseek' | 'ollama'
  model: string                       // 模型名称
  apiKey?: string                     // API 密钥
  baseURL?: string                    // 自定义 API 地址
  temperature?: number                // 温度参数
  maxTokens?: number                  // 最大 token
  isDefault?: boolean                 // 是否默认
}
```

### 测试结果
```typescript
interface LLMTestResult {
  success: boolean                    // 是否成功
  message: string                     // 消息
  latency?: number                    // 延迟（ms）
  model?: string                      // 实际使用的模型
}
```

## 服务层

### llm-config.ts
提供以下方法：
- `getAll()` - 获取所有配置
- `getById(id)` - 根据 ID 获取
- `add(config)` - 添加配置
- `update(id, config)` - 更新配置
- `delete(id)` - 删除配置
- `setDefault(id)` - 设置默认
- `test(config)` - 测试连接

## 使用流程

### 1. 添加 LLM 配置
```
1. 点击"LLM 管理"标签
2. 点击"添加 LLM"按钮
3. 填写配置表单：
   - 名称（如："我的 GPT-4"）
   - 提供商（OpenAI/Claude/DeepSeek/Ollama）
   - 模型（从下拉列表或手动输入）
   - API Key（如需要）
   - 自定义 API 地址（可选）
   - 温度（0-2，可选）
   - 最大 Token（可选）
4. 点击"测试连接"验证
5. 点击"保存"
```

### 2. 测试 LLM
```
1. 在 LLM 列表中找到要测试的配置
2. 点击"测试"按钮
3. 等待测试结果：
   - 成功：显示延迟和模型信息
   - 失败：显示错误信息
```

### 3. 为角色选择 LLM
```
1. 切换到"角色配置"标签
2. 查看已添加的 LLM 列表
3. 为每个角色选择要使用的 LLM
4. 点击"保存"
```

### 4. 设置默认 LLM
```
1. 在 LLM 列表中找到要设为默认的配置
2. 点击"设为默认"按钮
3. 新添加的角色将使用默认 LLM
```

## 界面截图说明

### LLM 管理标签
```
┌─────────────────────────────────────┐
│ LLM 管理                [+ 添加 LLM]│
├─────────────────────────────────────┤
│ ┌─────────────────────────────────┐ │
│ │ 🤖 OpenAI GPT-4o Mini  [默认] │ │
│ │ Provider: openai               │ │
│ │ Model: gpt-4o-mini             │ │
│ │ [编辑] [测试] [删除]          │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ 🎯 我的 Claude                 │ │
│ │ Provider: claude               │ │
│ │ Model: claude-3-5-sonnet       │ │
│ │ [设为默认] [编辑] [测试] [删除]│ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

### 添加/编辑 LLM 弹窗
```
┌─────────────────────────────────────┐
│ 添加 LLM 配置                       │
├─────────────────────────────────────┤
│ 名称:                               │
│ [我的 GPT-4                     ]   │
│                                     │
│ 提供商:                             │
│ [OpenAI ▾]                          │
│                                     │
│ 模型:                               │
│ [gpt-4o ▾]                          │
│                                     │
│ API Key:                            │
│ [sk-...                         ]   │
│                                     │
│ 自定义 API 地址（可选）:            │
│ [https://api.openai.com/v1     ]   │
│                                     │
│ 温度（0-2，可选）:                  │
│ [0.7                            ]   │
│                                     │
│ 最大 Token（可选）:                 │
│ [4096                           ]   │
│                                     │
│      [取消]  [测试连接]  [保存]     │
└─────────────────────────────────────┘
```

### 角色配置标签
```
┌─────────────────────────────────────┐
│ 角色 LLM 配置         [恢复默认]    │
├─────────────────────────────────────┤
│ ┌─────────────────────────────────┐ │
│ │ 👑 丞相 - 百官之长             │ │
│ │ 总揽全局，先讲利弊             │ │
│ │ 选择 LLM: [OpenAI GPT-4o Mini▾]│ │
│ │                     [保存]      │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ 💰 户部尚书 - 财政大臣         │ │
│ │ 讲账目、预算、执行细节         │ │
│ │ 选择 LLM: [我的 Claude ▾]      │ │
│ │                     [保存]      │ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

## 数据存储

### localStorage 键值
- `llm_configs` - 所有 LLM 配置（JSON 数组）
- `minister_llm_config` - 角色配置（角色 ID 到 LLM ID 的映射）

## 迁移方案

### 从旧配置迁移
如果用户之前使用 API Key 方式：
1. 自动创建默认 LLM 配置
2. 使用保存的 API Key
3. 保持角色配置不变

## 代码示例

### 添加 LLM 配置
```typescript
import { llmService } from '@/services/llm-config'

const newConfig = llmService.add({
  name: '我的 GPT-4',
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: 'sk-...',
  temperature: 0.7,
  maxTokens: 4096
})
```

### 测试 LLM
```typescript
const result = await llmService.test(config)
if (result.success) {
  console.log(`连接成功，延迟 ${result.latency}ms`)
} else {
  console.error(`连接失败: ${result.message}`)
}
```

### 为角色设置 LLM
```typescript
debateStore.saveMinisterLLMConfig('chancellor', {
  provider: 'openai',
  model: 'gpt-4o',
  llmId: newConfig.id  // 关联到 LLM 配置
})
```

## 下一步

1. ✅ 创建 LLM 配置类型和服务
2. ⏳ 重构 SettingsView，添加 LLM 管理界面
3. ⏳ 添加测试连接功能
4. ⏳ 更新角色配置，使用 LLM ID 关联
5. ⏳ 更新 debate store，使用 LLM 配置
6. ⏳ 测试完整流程

---

**设计理念**: 让用户灵活管理 LLM 资源，支持多个模型和配置，并提供测试功能确保可用性。
