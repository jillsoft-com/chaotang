# 朝堂 - 桌面应用使用说明

## ✅ Electron 桌面壳已添加完成！

## 🚀 启动方式

### 方式一：使用批处理脚本（推荐 Windows）
双击运行：
```
start-electron.bat
```

### 方式二：命令行启动
```bash
# 1. 先启动 Web 服务
npm run dev

# 2. 在新的终端窗口启动 Electron
set NODE_ENV=development
npx electron .
```

### 方式三：同时启动（可能因 Node 版本有兼容问题）
```bash
npm run electron:dev
```

## 📦 打包桌面应用

### Windows
```bash
npm run electron:build
```
生成的安装包在 `release/` 目录下

### macOS
```bash
npm run electron:build
```

### Linux
```bash
npm run electron:build
```

## ⚙️ 配置说明

### 窗口设置
- 默认尺寸：1400 x 900
- 最小尺寸：1024 x 768
- 开发模式：自动打开 DevTools
- 生产模式：加载构建后的文件

### 安全设置
- ✅ 启用上下文隔离
- ✅ 禁用 Node 集成
- ✅ 限制外部链接跳转

## 🎨 应用图标

请在 `public/` 目录下放置 `icon.png` 文件：
- 推荐尺寸：512x512 像素
- 格式：PNG（支持透明背景）
- 详见：`public/ICON-README.md`

## 📝 已知问题和解决方案

### 1. ERR_REQUIRE_ESM 错误
如果出现 `Error [ERR_REQUIRE_ESM]: require() of ES Module` 错误：
```bash
# 解决方案：已自动修复
npm install electron-builder@24.0.0 --save-dev
```

### 2. Node.js 版本兼容性
由于 Node.js 20.14.0 版本限制：
- ✅ 已测试：Electron 28.0.0 + electron-builder 24.0.0
- ✅ 已解决：依赖版本兼容性问题
- 💡 建议：如需使用更新版本，请升级 Node.js 到 22+

## 🔧 开发技巧

1. **调试模式**：Electron 窗口会自动打开 DevTools
2. **热重载**：修改代码后 Web 内容会自动刷新
3. **查看日志**：在终端查看运行状态

---

**朝堂桌面版** - 享受原生应用体验！
