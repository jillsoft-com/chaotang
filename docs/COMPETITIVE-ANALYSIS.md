# 朝堂 vs 市面主流 AI Agent / Coding Agent 竞品对比分析报告

> 编写时间：2026-10-10
> 对比产品：朝堂 (ChaoTang) · Qoder · OpenAI Codex (CLI / Web) · Claude Code · Trae · DeepSeek Harness · CodeWhale · Hermes Agent
> 信息来源：各产品官方文档、2026 年公开报道、仓库 FEATURE-GAP.md 与项目源码

---

## 一、产品定位矩阵

| 产品 | 厂商 / 团队 | 核心定位 | 主形态 | 模型绑定 | 开源协议 |
|------|-------------|----------|--------|----------|----------|
| **朝堂 ChaoTang** | 独立项目 | 多角色辩论式 AI 决策辅助 | Electron 桌面 + Web | 多 LLM（角色独立） | MIT |
| **Qoder** | 阿里巴巴 | 面向真实软件开发的 Agentic Coding 平台 | VS Code 系 IDE / JetBrains 插件 / CLI / 云 / 移动端 | 多模型 | 部分开源（插件协议） |
| **OpenAI Codex** | OpenAI | 终端优先的通用 Coding Agent | CLI（Rust）/ VS Code、Cursor、Windsurf 扩展 / 桌面 App / Codex Web 云端 | OpenAI 系 | Apache-2.0（CLI 开源） |
| **Claude Code** | Anthropic | 长任务 / 自主编码 Agent | CLI + VS Code / JetBrains 插件 + 桌面 App | Claude 系 | 闭源 |
| **Trae** | 字节跳动 | AI 原生中文 IDE | VS Code 系 IDE / CLI / TraeWork / SOLO | 豆包 / DeepSeek / GPT-4o / Claude 多模型 | 部分开源（Trae-Agent） |
| **DeepSeek Harness** | 深度求索 | "一切皆插件"的 Agent 框架 | Web UI / Headless CLI / Python SDK / 桌面端 | 多模型（默认 DeepSeek） | MIT |
| **CodeWhale** | 独立开发者 | 终端原生 Rust 编程 Agent（原 DeepSeek-TUI） | CLI（Rust） | DeepSeek V4 为主，多模型可切 | MIT |
| **Hermes Agent** | Nous Research | 自进化通用 AI Agent | TUI / 云端 VPS / Telegram / 桌面 | 39+ 提供商 | 开源 |

**小结**：朝堂在"辩论式决策"维度独一无二；Qoder、Codex、Claude Code、Trae、CodeWhale 主要争夺"Coding Agent"赛道；DeepSeek Harness 主打架构可塑性；Hermes 主打自学习闭环与跨平台消息。

---

## 二、能力维度横向对比

### 2.1 Agent 核心编排

| 能力 | 朝堂 | Qoder | Codex | Claude Code | Trae | DS Harness | CodeWhale | Hermes |
|------|:----:|:-----:|:-----:|:-----------:|:----:|:----------:|:---------:|:------:|
| 多轮工具循环 | ✅ ≤30 轮 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Plan-then-Execute | ✅ 弹窗确认 | Quest Mode | ✅ Checklist | ✅ | Builder | ✅ PTC | ✅ Plan/Agent/YOLO | ✅ |
| 多 Agent 协作 | ✅ Coordinator+Worker | ✅ | ✅ /agents 视图 | ✅ Managed Agents | ✅ 智能体团队 | ✅ 智能体团队 | ✅ 子 Agent | ✅ delegate_task |
| 并行子任务 | ✅ 辩论并行 | ✅ | ✅ 多任务 | ✅ | ✅ | ✅ | ✅ fork | ✅ |
| Sandbox 沙箱 | ⚠️ 轻量黑名单+超时 | ✅ 内核级 | ✅ 隔离环境 | ✅ 自动模式分类器 | ✅ | ✅ 插件化 | ✅ | ✅ |
| Approval 审批 | ✅ 危险命令确认 | ✅ | ✅ 三级 | ✅ 自动+手动 | ✅ | ✅ 自动授权插件 | ✅ 三级模式 | ✅ |
| 后台/定时任务 | ❌ | ❌ | ✅ 云端并行 | ✅ 长任务 | ❌ | ✅ 自动化任务插件 | ❌ | ✅ Cron |
| 会话管理 | ✅ fork/复制/重命名 | ✅ | ✅ /resume | ✅ /resume | ✅ | ✅ | ✅ | ✅ 完善 |
| 上下文压缩 | ✅ 截断+摘要 | ✅ | ✅ | ✅ 原生 | ✅ | ✅ 微压缩 | ✅ 前缀缓存 | ✅ |

### 2.2 工具 & 扩展生态

| 能力 | 朝堂 | Qoder | Codex | Claude Code | Trae | DS Harness | CodeWhale | Hermes |
|------|:----:|:-----:|:-----:|:-----------:|:----:|:----------:|:---------:|:------:|
| 自定义插件/Skill | ✅ SKILL.md | ✅ 插件市场 | ✅ 远程市场 | ✅ MCP Server | ✅ MCP | ✅ 一切皆插件 | ❌ | ✅ Python |
| MCP 协议 | ❌ | ✅ | ✅ | ✅ MCP 主导者 | ✅ | ✅ | ✅ | ✅ |
| 浏览器自动化 | ✅ Playwright 6 工具 | ✅ Browser Agent | ❌ 需扩展 | ✅ | ✅ Webview | ❌ 规划中 | ✅ Web 搜索/浏览 | ✅ 8 后端+12 工具 |
| 文件读写 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 代码语义搜索 | ✅ search_code | ✅ RepoWiki | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 文档解析 (pdf/docx/xls) | ✅ **领先** | ⚠️ 部分 | ❌ | ❌ | ⚠️ | ❌ 需插件 | ❌ | ❌ 需插件 |
| 图像/视频生成 | ❌ | ❌ | ❌ | ✅ Claude Design | ❌ | ❌ | ❌ | ✅ |
| TTS 语音 | ❌ | ❌ | ✅ 语音对话 | ❌ | ❌ | ✅ 语音输入插件 | ❌ | ✅ |
| Computer Use 桌面控制 | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ |
| 网络搜索 | ✅ DuckDuckGo | ✅ | ❌ 需扩展 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 知识库 RAG | ⚠️ 关键词 | ✅ RepoWiki | ❌ | ❌ | ❌ | ❌ 需插件 | ❌ | ✅ memory |

### 2.3 编码闭环

| 能力 | 朝堂 | Qoder | Codex | Claude Code | Trae | DS Harness | CodeWhale | Hermes |
|------|:----:|:-----:|:-----:|:-----------:|:----:|:----------:|:---------:|:------:|
| 仓库级理解 | ⚠️ 手动 | ✅ 10 万文件级引擎 | ✅ 自动 | ✅ 自动 | ✅ | ✅ | ✅ | ✅ |
| 跨文件重构 | ⚠️ 基础 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Lint / 类型检查 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ LSP |
| 测试循环（跑→修→再跑） | ✅ 自动检测框架 | ✅ | ✅ | ✅ 强 | ✅ | ✅ | ✅ | ✅ |
| Git 工作流 | ✅ git_operation | ✅ | ✅ PR 管理 | ✅ | ✅ | ✅ | ✅ | ✅ |
| AGENTS.md / Rules | ✅ | ✅ Rules | ✅ AGENTS.md | ✅ CLAUDE.md | ✅ Rules | ✅ | ✅ Constitution | ✅ |
| Diff 预览 | ✅ 行级 + 统计 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ patch |
| 代码补全（行间/NES） | ❌ | ✅ NEXT/NES | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |

### 2.4 多模型 & 生态接入

| 能力 | 朝堂 | Qoder | Codex | Claude Code | Trae | DS Harness | CodeWhale | Hermes |
|------|:----:|:-----:|:-----:|:-----------:|:----:|:----------:|:---------:|:------:|
| 多 LLM 供应商 | ✅ OpenAI 兼容 | ✅ | OpenAI 系 | Claude 系 | ✅ 豆包+DS+GPT+Claude | ✅ 40+ | ✅ 多模型 | ✅ 39+ |
| 本地 Ollama | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| 角色/任务独立模型 | ✅ **领先** | ⚠️ | ❌ | ❌ | ❌ | ⚠️ | ❌ | ❌ |
| IDE 插件 | ❌ | ✅ VS Code + JetBrains | ✅ VS Code / Cursor / Windsurf | ✅ VS Code + JetBrains | ✅ 自有 IDE | ❌ | ❌ | ❌ |
| CLI 终端模式 | ❌ | ✅ | ✅ 核心 | ✅ 核心 | ✅ | ✅ | ✅ 核心 | ✅ |
| 桌面 App | ✅ Electron | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| 移动端 | ❌ | ✅ | ✅ Codex Web | ❌ | ✅ 手机 | ❌ 规划中 | ❌ | ✅ Telegram |
| 跨平台消息 | ⚠️ 企微 Webhook | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ 28+ 平台 |

### 2.5 学习与进化

| 能力 | 朝堂 | Qoder | Codex | Claude Code | Trae | DS Harness | CodeWhale | Hermes |
|------|:----:|:-----:|:-----:|:-----------:|:----:|:----------:|:---------:|:------:|
| 跨会话持久记忆 | ✅ save/search_memory | ✅ Memory | ❌ | ✅ Memory | ❌ | ❌ 规划中 | ❌ | ✅ 核心 |
| 自学习循环（技能自动沉淀） | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ GEPA 核心 |
| 会话历史搜索 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 用户画像 | ❌ | ⚠️ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

---

## 三、朝堂的核心优势（差异化护城河）

1. **多角色辩论机制**（独有）
   六位 AI 大臣（丞相、户部、御史、大将军、太傅、总管）从不同立场分析同一议题，互相辩驳。Qoder、Codex、Claude Code、Trae 均无此设计；DeepSeek Harness 与 Hermes 虽支持多 Agent，但都是"任务分工"而非"立场对抗"。

2. **角色独立模型绑定**（独有）
   每个角色可用不同 LLM（如丞相 GPT-4o、御史 Claude Opus、户部 DeepSeek），让用户在一场朝议里同时享受不同模型的风格与强项。市面竞品绝大多数是"任务级"模型切换。

3. **古代朝堂文化 UI + 仪式感**
   "圣旨 / 拍板 / 点名 / 退朝"等交互词汇，配合深金暗红主题，形成强烈品牌识别。对比 Qoder/Trae 的工具化 UI、Codex/CodeWhale 的终端极简，文化辨识度极高。

4. **内置文档解析（doc/docx/pdf/xls/xlsx）**
   其他 Agent 大多需要插件才能实现；朝堂作为一等工具内置，适合"会议决策 + 资料分析"场景。

5. **拍板后的"圣旨"行动清单**
   post-debate 生成行动清单与报告，可继续执行（规划中），形成"议事 → 决策 → 执行"闭环。

6. **企业微信 Webhook 双向通信**
   可将辩论结论推送到企微群，并接收群内消息触发新一轮朝议，适配国内团队沟通场景。

7. **串行/并行/Agent 三模式节奏**
   同一议题多种辩论节奏，兼顾仪式感与效率。

8. **轻量本地 + 开源 MIT**
   相比 Qoder、Codex、Claude Code 的厂商锁定，朝堂完全本地运行、API Key 加密保存、MIT 许可，对注重数据隐私的团队友好。

---

## 四、朝堂的核心短板（与竞品差距）

### 4.1 编码能力偏弱

| 短板 | 说明 | 参考竞品 |
|------|------|----------|
| 无代码补全 / NES | 缺少行间预测，日常编码体验远弱于 Qoder、Trae | Qoder NEXT、Trae 补全 |
| 仓库级上下文自动加载 | 当前需手动指定工作目录，缺"项目全仓自动理解" | Qoder 10 万文件引擎、Codex、Claude Code |
| 无 Lint / 类型检查闭环 | 跑测试有了，但 eslint/tsc 未接入 | Codex、Claude Code、Hermes |
| 重构能力基础 | 跨文件重命名/移动/符号重构缺失 | Qoder、Claude Code |

### 4.2 Agent 工程化不足

| 短板 | 说明 | 参考竞品 |
|------|------|----------|
| **无 MCP 协议** | 无法复用社区工具生态（Figma、数据库、GitHub 等） | Claude Code（主导者）、Qoder、Codex、Trae、DS Harness、Hermes、CodeWhale |
| **无后台/定时任务** | 退朝后无法持续运行长任务或定时触发 | Codex Web、Hermes Cron、DS Harness 自动化任务插件 |
| **无 CLI 终端模式** | 失去开发者最常用入口 | Codex CLI、Claude Code、Hermes TUI、CodeWhale、Qoder CLI、Trae CLI |
| **无 IDE 插件** | 开发者需要在现有 IDE 中使用 | Qoder JetBrains、Codex 多 IDE、Claude Code 多 IDE、Trae IDE |
| 子 Agent 动态委派弱 | Coordinator 已实现，但缺运行时灵活 handoff | Codex /agents、Hermes delegate、DS Harness 智能体团队 |

### 4.3 学习进化层缺失

| 短板 | 说明 | 参考竞品 |
|------|------|----------|
| **无自学习循环** | 不能从交互中自动沉淀 Skill | Hermes GEPA（ICLR 2026 Oral） |
| **无用户画像** | 记忆是工具级，不是用户级 | Hermes user.md + Honcho |
| 无会话历史搜索 | 过往朝议难以检索复用 | 竞品均有 |

### 4.4 生态覆盖不足

| 短板 | 说明 | 参考竞品 |
|------|------|----------|
| 无移动端 | 辩论无法在手机上进行或旁听 | Qoder 移动端、Trae 手机、Hermes Telegram |
| 仅企业微信消息通道 | 缺钉钉、飞书、Slack、Discord、Telegram 等 | Hermes 28+ 平台 |
| 无插件市场 | SKILL.md 只能本地手工放置，无发现与安装机制 | Codex 远程市场、DS Harness 插件市场、Qoder 插件市场 |
| 缺 Computer Use / 图像视频生成 | 多模态能力弱 | Claude Computer Use、Hermes imagegen/TTS |

---

## 五、SWOT 总结

| 维度 | 内容 |
|------|------|
| **优势 Strengths** | 多角色辩论（独有）、角色独立模型、古代朝堂 IP、文档解析、本地 MIT、企微集成、轻量沙箱、持久记忆、Skill 系统已搭好骨架 |
| **劣势 Weaknesses** | 编码能力（补全/重构/Lint）弱、无 MCP、无 CLI/IDE 插件、无后台任务、无自学习循环、无移动端、消息通道窄 |
| **机会 Opportunities** | ① "AI 决策辅助"赛道尚未被主流 Coding Agent 覆盖；② MCP 协议普及，可低成本接入大量工具；③ 国内"信创+私有化"场景对开源本地 Agent 需求强；④ 多 Agent 辩论可拓展到企业治理、投研、教育、法律、咨询等垂直领域 |
| **威胁 Threats** | ① Qoder、Trae、DS Harness 等国内玩家迭代极快，插件生态可能吞并"决策类"场景；② Hermes、Claude Code 持续强化多 Agent 与长任务；③ 模型价格下降让"多角色并行"成本优势减弱；④ 辩论机制如果不能转化为可验证决策质量，易被视作"演示型产品" |

---

## 六、改进与升级建议（路线图）

按 **"护城河加固 → 补齐底线 → 差异化扩张"** 三条主线，分四个优先级给出建议。

### P0 — 护城河加固（1~2 个月，让"辩论"真正成为决策工具）✅ 本批次全量启动

| # | 建议 | 价值 | 工作量 | 状态 |
|---|------|------|--------|------|
| 1 | **决策质量可视化**：拍板后自动生成"共识点 / 分歧点 / 风险清单 / 待验证假设"四象限 | 让辩论结果可执行、可复盘，区别于"多模型并排展示" | 中 | ✅ 已完成 |
| 2 | **辩论主题模板库**：投研、技术方案评审、产品取舍、法律合规、个人重大决策 5 套 preset 角色组 | 降低冷启动成本，拓展垂直场景 | 低 | ✅ 已完成 |
| 3 | **圣旨 → 执行闭环**：拍板后一键生成 Todo / 邮件草稿 / 企微群通知 / Markdown 报告 | 把"仪式感"转化为"产出物"，用户粘性核心 | 中 | ✅ 已完成 |
| 4 | **角色专属工具深化**：御史 → fact_check + 来源追溯；户部 → 图表/预算；太傅 → 历史案例库 | 把 v2 方案里的角色专属工具落地，让辩论内容有"事实支撑" | 中 | ✅ 已完成 |

### P1 — 补齐 Agent 底线（3~6 个月，追平竞品基本盘）

| # | 建议 | 价值 | 工作量 | 状态 |
|---|------|------|--------|------|
| 5 | **接入 MCP 协议** | 直接复用 Figma、GitHub、数据库、搜索引擎等 200+ 现成 Server，生态互通 | 大 | ✅ 已完成 |
| 6 | **CLI 终端模式** (`chaotang-cli`) | 开发者最常用入口；可挂到 CI、脚本、自动化流水线 | 大 | ⬜ 未启动 |
| 7 | **VS Code / JetBrains 插件** | 把"@角色"带进 IDE，在编辑器里直接点名御史 review 代码 | 大 | ⬜ 未启动 |
| 8 | **仓库级自动上下文** | 打开项目自动索引，让丞相回答"这个项目要不要重构 X 模块"时无需手动喂文件 | 大 | ✅ 已完成 |
| 9 | **后台任务 + 长辩论** | 退朝后丞相持续跟踪指标，触发"再上奏"；可类比 Codex Web 并行任务 | 中 | ✅ 已完成 |
| 10 | **会话历史全文搜索 + 标签** | 复用历史朝议，形成个人"决策案例库" | 低 | ✅ 已完成 |
| 11 | **Lint / 类型检查 / 重构工具** | 让大将军 / 丞相能直接做跨文件重命名、ESLint 修复 | 中 | ✅ 已完成 |

### P2 — 差异化扩张（6~12 个月，从"个人决策工具"走向"组织级决策平台"）

| # | 建议 | 价值 | 工作量 | 状态 |
|---|------|------|--------|------|
| 12 | **多端协同**：移动端旁听 + Web 分享链接 + 实时观察室 | 把"朝议"变成团队会议，扩大受众 | 大 | ⬜ 未启动 |
| 13 | **跨平台消息扩展**：钉钉、飞书、Slack、Discord、Telegram Adapter | 复用现有 Adapter 架构，进入团队协作场景 | 中 | ⬜ 未启动 |
| 14 | **插件市场**（SKILL.md + 一键安装 + 版本管理） | 社区共建工具，对抗 DS Harness / Codex 市场 | 大 | ✅ 已完成 |
| 15 | **辩论数据集 + 微调模型** | 用历史优质朝议训练"朝堂专用模型"，形成数据护城河 | 大 | ⬜ 未启动 |
| 16 | **Computer Use + 图像/视频/TTS** | 补齐多模态，让御史能"看到"网页、总管能"播报"圣旨 | 大 | ✅ 已完成 |
| 17 | **自学习循环**（参考 Hermes GEPA） | 跨会话沉淀"决策经验"Skill，越用越懂你的偏好 | 大 | ✅ 已完成 |

### P3 — 长期生态（12 个月以上，建立壁垒）

| # | 建议 | 价值 | 工作量 | 状态 |
|---|------|------|--------|------|
| 18 | **企业版：多用户朝议 + 权限 + 审计** | 进入咨询、投研、法律、产品评审等企业高客单价场景 | 大 | ⬜ 未启动 |
| 19 | **API / SDK 开放** | 让第三方在自己产品里嵌入"朝议"组件 | 中 | ⬜ 未启动 |
| 20 | **私有化部署 + 信创适配** | 政府、国企、金融等强付费场景 | 大 | ⬜ 未启动 |
| 21 | **Agent-to-Agent（A2A）协议** | 让朝堂与其他 Agent（Codex、Hermes、Qoder）互派任务 | 中 | ✅ 已完成 |

---

## 七、差异化定位建议（一句话战略）

> **不要在"Coding Agent"赛道跟 Qoder / Codex / Claude Code / Trae 硬碰硬。**
> 朝堂的真正蓝海是：**"多人称视角的决策辅助 Agent 平台"**——
> 把"六位大臣辩论"做成 **个人/团队重大决策的标准化工作流**，
> 让每一次拍板都留下 **共识、分歧、风险、行动** 四件套。

具体而言：

1. **品牌关键词**：从 "AI 辩论工具" 升级为 "**AI 议事厅 / AI 参谋部**"
2. **目标用户**：产品经理、投资研究员、咨询顾问、法务合规、创业者、技术负责人 —— **需要做复杂决策的人**，而非单纯写代码的人
3. **典型场景包装**：
   - "该不该砍掉这个功能？" —— 产品评审
   - "A 轮该拿谁的钱？" —— 创业决策
   - "这个合同有哪些隐患？" —— 法务预审
   - "技术栈选 Rust 还是 Go？" —— 架构评审
4. **商业化锚点**：以"一场朝议 = 一份可交付的决策报告"计价，而非 token 或席位

---

## 八、一句话总结

- **护城河**：多角色辩论 + 角色独立模型 + 朝堂文化 IP，**市面无直接对手**。
- **最大风险**：若只停留在"演示好看"，会被 Qoder / Trae / Codex 的"多 Agent 协作"功能顺手吞掉。
- **下一步最重要的 3 件事**：
  1. **把辩论结果变成可执行的决策报告**（P0-#1、#3）；
  2. **接入 MCP 协议**（P1-#5），让工具生态一步追上；
  3. **发布 CLI + IDE 插件**（P1-#6、#7），进入开发者日常工具链。

完成这三步，朝堂就能从"有趣的 AI 辩论工具"升级为"不可或缺的 AI 决策参谋"。

---

## 九、当前批次任务追踪（2026-10-10 启动）

> 本批次共启动 13 项任务，状态说明：⬜ 未启动 | 🚧 进行中 | ✅ 已完成 | ⏸️ 挂起
> 状态更新约定：每完成一个子任务或到达一个里程碑，更新本表并在对应模块开发文档中记录。

| 优先级 | # | 任务名称 | 主要涉及模块 / 文件 | 状态 | 备注 |
|--------|---|----------|---------------------|------|------|
| P0 | 1 | 决策质量可视化（共识/分歧/风险/假设 四象限） | `services/agent/post-debate.ts`、`ChatSession.vue` | ✅ 已完成 | DecisionReport 类型 + generateDecisionReport + ChatSession UI |
| P0 | 2 | 辩论主题模板库（5 套 preset 角色组） | `services/topic-templates.ts` | ✅ 已完成 | 17 个预设模板 + 分类搜索 + 占位符替换 + 推荐角色 |
| P0 | 3 | 圣旨 → 执行闭环（Todo / 邮件 / 企微 / MD） | `services/agent/imperial-executor.ts`、`stores/debate.ts` | ✅ 已完成 | 行动项解析 + 自动执行 + 执行报告生成 |
| P0 | 4 | 角色专属工具深化（御史/户部/太傅） | `services/tools/handlers/`、`skills/defaults.ts` | ✅ 已完成 | fact_check / chart_generator / history_search 已注册 |
| P1 | 5 | 接入 MCP 协议 | 新增 `services/mcp/` | ✅ 已完成 | MCPClient + MCPService + JSON-RPC + SSE/stdio + 工具注册/注销 |
| P1 | 8 | 仓库级自动上下文 | `services/agent/repository-context.ts`、`ChatSession.vue` | ✅ 已完成 | 项目扫描 + 分块索引 + TF-IDF 检索 + 自动注入 system prompt |
| P1 | 9 | 后台任务 + 长辩论 | 新增 `services/scheduler/`、`stores/debate.ts` | ✅ 已完成 | BackgroundScheduler + 再上奏 + 长辩论 + localStorage 持久化 |
| P1 | 10 | 会话历史全文搜索 + 标签 | `views/HistoryView.vue`、`stores/` | ✅ 已完成 | 搜索栏 + 标签云 + 标签管理 + store 操作方法 |
| P1 | 11 | Lint / 类型检查 / 重构工具 | `services/tools/handlers/minimal.ts`、`skills/defaults.ts` | ✅ 已完成 | lint_check / type_check / refactor_rename + Skill 注册给大将军/丞相 |
| P2 | 14 | 插件市场（SKILL.md + 安装 + 版本） | `services/plugins/marketplace.ts`、`plugins/index.ts` | ✅ 已完成 | 内置插件目录 + 搜索/分类 + 安装/卸载 + 版本跟踪 |
| P2 | 16 | Computer Use + 图像/视频/TTS | `services/multimodal/`、`services/browser/` | ✅ 已完成 | 图像分析 + TTS 语音合成 + 文档增强 + 圣旨播报 |
| P2 | 17 | 自学习循环（GEPA 机制） | `services/learning/gepa-engine.ts` | ✅ 已完成 | 模式提取 + 经验强化 + Skill 升级 + 持久化存储 |
| P3 | 21 | Agent-to-Agent（A2A）协议 | 新增 `services/a2a/` | ✅ 已完成 | AgentCard + Task 派发 + 远程发现 + 入站任务处理 |

> 合计：本批次共 13 项（P0: 4 项、P1: 5 项、P2: 3 项、P3: 1 项）

### 9.1 执行节奏建议

| 阶段 | 周期 | 聚焦任务 | 交付物 |
|------|------|----------|--------|
| **Sprint A** | 第 1–2 周 | #1 决策可视化、#4 角色专属工具、#10 历史搜索 | 拍板后生成四象限报告；御史能 fact_check；历史页可搜可标 |
| **Sprint B** | 第 3–6 周 | #5 MCP、#8 仓库上下文、#11 Lint/重构 | MCP Client 跑通；项目自动索引；大将军能做 ESLint 修复 |
| **Sprint C** | 第 7–10 周 | #9 后台任务、#14 插件市场、#21 A2A 协议 | 退朝后长任务；插件可搜索安装；能与 Hermes 互派任务 |
| **Sprint D** | 第 11–16 周 | #16 多模态、#17 自学习循环 | Computer Use 落地；自动沉淀决策经验 Skill |

### 9.2 变更日志

| 日期 | 变更内容 |
|------|----------|
| 2026-10-10 | 启动首批 13 项任务：#1, #2, #3, #4, #5, #8, #9, #10, #11, #14, #16, #17, #21（全部标记为 🚧 进行中） |
| 2026-10-10 | **Sprint A 完成 #1、#4、#10**：决策报告四象限（类型 + 生成 + UI）、角色专属工具（fact_check / chart_generator / history_search）、历史搜索+标签；build 验证通过 |
| 2026-10-10 | **Sprint B 完成 #5、#8、#11**：MCP Client（SSE/stdio + JSON-RPC + 工具自动注册）、仓库上下文（文件索引 + TF-IDF 检索 + 自动注入）、Lint/TypeCheck/Refactor 工具；build 验证通过 |
| 2026-10-10 | **Sprint C 完成 #9、#14、#21**：后台任务调度器（延时/周期/再上奏/长辩论）、插件市场（内置目录 + 搜索 + 安装）、A2A 协议（AgentCard + Task 派发）；build 验证通过 |
| 2026-10-10 | **Sprint D 完成 #2、#3、#16、#17**：辩论主题模板库（17 个预设模板）、圣旨执行闭环（行动项解析 + 自动执行）、多模态增强（图像分析 + TTS）、GEPA 自学习引擎；build 验证通过 |
