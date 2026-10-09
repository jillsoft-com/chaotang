# 朝堂 - 多角色辩论式 AI 对话工具

> 百官进言，圣裁由你

## 📚 文档导航

**欢迎使用朝堂！** 请先查看 [📖 文档索引](./INDEX.md) 找到你需要的文档。

### 🚀 快速开始
- **新手用户**：[QUICKSTART.md](./QUICKSTART.md) → 5 分钟快速上手
- **桌面应用**：[ELECTRON-USAGE.md](./ELECTRON-USAGE.md) → Electron 使用指南
- **打包发布**：[BUILD-GUIDE.md](./BUILD-GUIDE.md) → 打包桌面应用

---

## 项目简介

朝堂是一个创新的多角色辩论式 AI 对话工具。用户扮演皇上，提出议题后，多个朝臣角色依次进言，用户可以拍板定夺或点名追问。

## 核心功能

### 🏛️ 朝议模式
- 6 个角色串行发言，后发言者能看到前文
- 体验真实的朝堂辩论氛围
- 每个角色有独特的说话风格和立场

### 📊 模型对比模式
- 同一问题发给多个模型
- 结果并排展示
- 方便横向评测不同 AI 的表现

## 角色设计

| 角色 | 功能 | 推荐模型 |
|------|------|----------|
| 👑 丞相 | 总揽全局，先讲利弊，再给折中方案 | GPT-4o / GPT-4o-mini |
| 💰 户部尚书 | 讲账目、预算、执行细节 | DeepSeek-V3 |
| 📚 太傅 | 引经据典，讲祖制、名分和长远影响 | Claude Haiku / GPT-4o |
| ⚔️ 大将军 | 强硬直接，主战、主防、主秩序 | Qwen2.5-7B（本地） |
| 🔍 御史 | 专挑毛病，指出风险与漏洞 | Claude Sonnet |
| 🏮 司礼监总管 | 揣摩圣意，提醒宫廷、舆情和执行阻力 | GPT-4o-mini |

## 技术栈

- **前端框架**：Vue 3 + TypeScript
- **构建工具**：Vite
- **状态管理**：Pinia
- **路由**：Vue Router
- **样式**：Tailwind CSS
- **LLM 集成**：支持 OpenAI、Claude、DeepSeek、Ollama
- **桌面壳**：Electron 28.0.0

## 项目结构

```
ChaoTang/
├── src/                 # 前端源码
│   ├── assets/         # 静态资源
│   ├── components/     # 公共组件
│   ├── views/          # 页面视图
│   ├── stores/         # Pinia 状态管理
│   ├── services/       # API 服务
│   ├── types/          # TypeScript 类型定义
│   ├── utils/          # 工具函数
│   ├── router/         # 路由配置
│   ├── App.vue
│   └── main.ts
├── electron/            # Electron 桌面应用
│   ├── main.js         # Electron 主进程
│   └── preload.js      # 预加载脚本
├── docs/               # 项目文档
├── public/             # 公共静态资源
├── package.json
├── tsconfig.json
├── vite.config.ts
└── tailwind.config.js
```

## 安装与运行

### Web 版本

#### 安装依赖
```bash
npm install
```

#### 启动开发服务器
```bash
npm run dev
```

访问 http://localhost:3000

#### 构建生产版本
```bash
npm run build
```

### 🖥️ 桌面应用版本

#### 启动桌面应用（Windows 推荐）
双击运行：
```
start-electron.bat
```

#### 命令行启动桌面应用
```bash
# 方式1：分别启动
npm run dev                    # 终端1：启动 Web 服务
set NODE_ENV=development       # 终端2：设置环境变量
npx electron .                 # 终端2：启动 Electron

# 方式2：同时启动（可能有兼容性问题）
npm run electron:dev
```

#### 打包桌面应用
```bash
npm run electron:build
```

详细说明请查看 [ELECTRON-USAGE.md](./ELECTRON-USAGE.md)

## 配置说明

首次使用需要在设置页面配置各 LLM 提供商的 API Key：

1. 点击首页的"设置"按钮
2. 输入对应的 API Key：
   - OpenAI API Key
   - Claude API Key
   - DeepSeek API Key
   - Ollama 服务地址（如果使用本地模型）
3. 点击"保存设置"

所有密钥仅保存在浏览器本地存储中，不会上传到任何服务器。

## 使用说明

1. 在首页输入您想讨论的议题
2. 选择模式（朝议模式或对比模式）
3. 点击"开启朝议"
4. 等待各位大臣依次进言
5. 可以颁布圣旨（拍板决定）或查看历史记录

## 开发计划

- [ ] 实现流式对话渲染
- [ ] 添加更多 LLM 提供商支持
- [ ] 完善对比模式功能
- [ ] 添加语音朗读功能
- [ ] 支持自定义角色
- [ ] 导出朝议记录

## 许可证

MIT License

---

**朝堂** - 让 AI 辩论更有趣！
