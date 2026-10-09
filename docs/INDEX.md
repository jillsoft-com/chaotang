# 📚 朝堂项目文档索引

## 文档列表

### 📘 主文档
- **[README.md](./README.md)** - 项目说明和介绍
  - 项目简介
  - 核心功能
  - 角色设计
  - 技术栈
  - 快速开始

### 🚀 快速上手
- **[QUICKSTART.md](./QUICKSTART.md)** - 快速启动指南
  - 立即体验（三种启动方式）
  - 故障排除
  - 打包桌面应用
  - 配置 API Key
  - 开始朝议

- **[ROLE-LLM-CONFIG.md](./ROLE-LLM-CONFIG.md)** - 角色 LLM 配置指南
  - 为每个角色指定 LLM 模型
  - 支持的模型列表
  - 推荐配置方案
  - 性能对比和建议

- **[LLM-MANAGEMENT-GUIDE.md](./LLM-MANAGEMENT-GUIDE.md)** - LLM 管理系统使用指南 ⭐
  - 添加自定义 LLM 配置
  - 测试 LLM 连接
  - 为角色选择 LLM
  - 最佳实践方案

### 🖥️ Electron 相关
- **[ELECTRON-USAGE.md](./ELECTRON-USAGE.md)** - Electron 详细使用说明
  - 启动方式（三种方式）
  - 打包桌面应用
  - 配置说明（窗口、安全）
  - 应用图标
  - 已知问题和解决方案
  - 开发技巧

- **[BUILD-GUIDE.md](./BUILD-GUIDE.md)** - 打包发布指南
  - 打包步骤
  - 添加应用图标
  - 打包配置说明
  - 自定义打包选项
  - 常见问题
  - 分发应用
  - 版本更新

### 📊 项目信息
- **[PROJECT-SUMMARY.md](./PROJECT-SUMMARY.md)** - 项目总览
  - 已完成的所有功能
  - 项目结构
  - 启动指南
  - 下一步建议
  - 技术亮点
  - 使用说明

- **[FEATURE-GAP.md](./FEATURE-GAP.md)** - 竞品功能对比分析 ⭐
  - 朝堂 vs Codex CLI / Hermes / DeepSeek Harness
  - Agent 核心能力矩阵
  - 工具 & 技能系统对比
  - 编码能力对比
  - 优先级建议（P0/P1/P2）
  - 朝堂独特优势

- **[STATUS.md](./STATUS.md)** - 项目完整状态报告
  - 错误修复历史
  - 构建测试结果
  - 依赖版本清单
  - 可用命令
  - 功能完成度
  - 项目统计
  - 验证清单

### 🛠️ 开发相关
- **[FIXES.md](./FIXES.md)** - 错误修复记录
  - 问题 1: ERR_REQUIRE_ESM 错误
  - 问题 2: ES Module 作用域错误
  - 问题 3: PowerShell 脚本中文乱码
  - 问题 4: Cannot find module '@electron/rebuild' 错误
  - 最终配置清单
  - 启动测试
  - 打包配置

### 🎨 资源说明
- **[ICON-README.md](../public/ICON-README.md)** - 应用图标说明（位于 public 目录）
  - 图标尺寸要求
  - 设计建议
  - 临时方案

- **[UI-REDESIGN.md](./UI-REDESIGN.md)** - 新界面设计说明
  - ChatGPT/千问 风格设计
  - 界面特性和动画
  - 配色和布局
  - 使用流程

## 📖 推荐阅读顺序

### 新手用户
1. [README.md](./README.md) - 了解项目
2. [QUICKSTART.md](./QUICKSTART.md) - 快速启动
3. [ELECTRON-USAGE.md](./ELECTRON-USAGE.md) - 使用桌面应用

### 开发者
1. [PROJECT-SUMMARY.md](./PROJECT-SUMMARY.md) - 了解项目结构
2. [ELECTRON-USAGE.md](./ELECTRON-USAGE.md) - Electron 开发
3. [BUILD-GUIDE.md](./BUILD-GUIDE.md) - 打包发布
4. [FIXES.md](./FIXES.md) - 问题解决记录

### 项目维护者
1. [STATUS.md](./STATUS.md) - 项目状态
2. [BUILD-GUIDE.md](./BUILD-GUIDE.md) - 打包配置
3. [FIXES.md](./FIXES.md) - 历史问题

## 🎯 快速查找

### 我想知道...

**如何启动应用？**
→ [QUICKSTART.md](./QUICKSTART.md)

**如何打包桌面应用？**
→ [BUILD-GUIDE.md](./BUILD-GUIDE.md)

**遇到错误怎么办？**
→ [FIXES.md](./FIXES.md) 或 [QUICKSTART.md](./QUICKSTART.md#故障排除)

**项目有哪些功能？**
→ [README.md](./README.md) 或 [PROJECT-SUMMARY.md](./PROJECT-SUMMARY.md)

**如何配置 API Key？**
→ [QUICKSTART.md](./QUICKSTART.md#配置-api-key)

**如何添加应用图标？**
→ [ICON-README.md](../public/ICON-README.md) 或 [BUILD-GUIDE.md](./BUILD-GUIDE.md#添加应用图标重要)

**Electron 如何配置？**
→ [ELECTRON-USAGE.md](./ELECTRON-USAGE.md)

**项目当前状态如何？**
→ [STATUS.md](./STATUS.md)

## 📁 文档统计

- **总文档数**: 14 个
- **总字数**: 约 25,000+ 字
- **涵盖内容**: 
  - 项目介绍
  - 快速启动
  - 详细使用指南
  - LLM 管理系统
  - 角色配置
  - 开发文档
  - 打包发布
  - 问题解决
  - 项目状态
  - 界面设计

## 🔗 相关资源

### 外部链接
- [Vue 3 官方文档](https://vuejs.org/)
- [Vite 官方文档](https://vitejs.dev/)
- [Electron 官方文档](https://www.electronjs.org/)
- [Tailwind CSS](https://tailwindcss.com/)

### 项目目录
```
ChaoTang/
├── docs/                    # 📚 所有文档都在这里
│   ├── 朝堂产品完整方案_更新版.htm  # 产品方案
│   ├── README.md           # 项目说明
│   ├── QUICKSTART.md       # 快速启动
│   ├── ELECTRON-USAGE.md   # Electron 使用
│   ├── BUILD-GUIDE.md      # 打包指南
│   ├── PROJECT-SUMMARY.md  # 项目总览
│   ├── STATUS.md           # 项目状态
│   ├── FIXES.md            # 修复记录
│   └── INDEX.md            # 本文件
├── src/                     # 源代码
├── electron/                # Electron 代码
└── public/                  # 静态资源
    └── ICON-README.md      # 图标说明
```

---

**所有文档已整理完毕，方便查阅！** 📖✨

如有疑问，请先在文档中查找，或查看 STATUS.md 了解项目最新状态。
