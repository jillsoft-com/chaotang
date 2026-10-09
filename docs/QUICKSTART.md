# 🚀 快速启动指南

## ⚡ 立即体验

### 方式一：PowerShell 启动（推荐）
在文件资源管理器中，右键点击 `start-electron.ps1`，选择"使用 PowerShell 运行"

或在 PowerShell 终端中：
```powershell
.\start-electron.ps1
```

### 方式二：批处理启动
双击 `start-electron.bat`

### 方式三：纯 Web 版本
```bash
npm run dev
```
访问 http://localhost:3000

## 🔧 故障排除

### 问题 1: ERR_REQUIRE_ESM 错误
```
Error [ERR_REQUIRE_ESM]: require() of ES Module...
```

**解决方案**（已自动修复）：
```bash
npm install electron-builder@24.0.0 --save-dev
```

### 问题 2: Electron 启动失败
**解决方案**：
```bash
# 重新安装 Electron
npm install electron@28.0.0 --save-dev --force
```

### 问题 3: 端口 3000 被占用
**解决方案**：
```bash
# 杀掉占用端口的进程
netstat -ano | findstr :3000
taskkill /PID [进程ID] /F
```

## 📦 打包桌面应用

```bash
# 构建生产版本
npm run build

# 打包 Electron 应用
npm run electron:build
```

生成的安装包在 `release/` 目录下

## ⚙️ 配置 API Key

首次使用需要配置 LLM API Key：

1. 启动应用后，点击首页的"设置"按钮
2. 输入对应的 API Key：
   - OpenAI API Key（必需）
   - Claude API Key（可选）
   - DeepSeek API Key（可选）
   - Ollama 服务地址（如果使用本地模型）
3. 点击"保存设置"

所有密钥仅保存在本地，安全可靠！

## 🎯 开始朝议

1. 返回首页
2. 输入议题（例如："是否应该增加军费开支？"）
3. 选择模式（朝议/对比）
4. 点击"开启朝议"
5. 观看各位大臣依次进言
6. 可以颁布圣旨（拍板决定）

---

**百官进言，圣裁由你！** 🎉
