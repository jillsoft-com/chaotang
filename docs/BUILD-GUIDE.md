# 📦 朝堂 - 打包发布指南

## ✅ 已修复所有打包问题

所有依赖版本兼容性问题已解决：
- ✅ electron-builder@24.0.0
- ✅ @electron/rebuild@3.2.13
- ✅ electron@28.0.0

## 🚀 打包步骤

### 第一步：构建前端

```bash
npm run build
```

这会生成 `dist/` 目录，Electron 会打包这些文件。

### 第二步：打包 Electron 应用

#### Windows
```bash
npm run electron:build
```

#### macOS
```bash
npm run electron:build
```

#### Linux
```bash
npm run electron:build
```

### 输出位置

打包完成后，生成的文件在：
```
ChaoTang/
└── release/
    ├── win-unpacked/              # Windows 未打包版本
    ├── 朝堂 Setup 0.1.0.exe      # Windows 安装包 (NSIS)
    ├── mac/                       # macOS 版本
    └── linux-unpacked/            # Linux 版本
```

## 🎨 添加应用图标（重要）

在打包前，请确保添加应用图标：

1. 准备一个 PNG 图标（推荐 512x512 像素）
2. 保存到：`public/icon.png`
3. 重新运行打包命令

详见：`public/ICON-README.md`

## 📋 打包配置说明

### package.json 中的 build 配置

```json
{
  "build": {
    "appId": "com.chaotang.app",           // 应用 ID
    "productName": "朝堂",                  // 产品名称
    "directories": {
      "output": "release"                   // 输出目录
    },
    "files": [
      "dist/**/*",                          // 前端构建文件
      "electron/**/*.cjs"                   // Electron 文件
    ],
    "win": {
      "target": ["nsis"],                   // Windows 安装包格式
      "icon": "public/icon.png"
    },
    "mac": {
      "target": ["dmg"],                    // macOS 镜像格式
      "icon": "public/icon.png"
    },
    "linux": {
      "target": ["AppImage"],               // Linux 便携格式
      "icon": "public/icon.png"
    }
  }
}
```

## 🔧 自定义打包选项

### 修改安装包信息

编辑 `package.json`：

```json
{
  "build": {
    "win": {
      "target": {
        "target": "nsis",
        "arch": ["x64"]                     // 只打包 64 位
      },
      "publisherName": "朝堂团队",           // 发布者名称
      "icon": "public/icon.png"
    },
    "nsis": {
      "oneClick": false,                    // 不使用一键安装
      "allowToChangeInstallationDirectory": true,  // 允许选择安装目录
      "createDesktopShortcut": true,        // 创建桌面快捷方式
      "createStartMenuShortcut": true       // 创建开始菜单快捷方式
    }
  }
}
```

### 修改应用名称

```json
{
  "build": {
    "productName": "朝堂 - AI 辩论工具"     // 修改显示名称
  }
}
```

## 🐛 常见问题

### 问题 1: 图标不显示

**原因**：图标文件不存在或格式不对

**解决**：
- 确保 `public/icon.png` 存在
- 图标尺寸至少 256x256 像素
- 使用 PNG 格式（支持透明背景）

### 问题 2: 打包后白屏

**原因**：没有先构建前端

**解决**：
```bash
# 先构建
npm run build

# 再打包
npm run electron:build
```

### 问题 3: 打包速度慢

**解决**：
```bash
# 使用镜像加速
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run electron:build
```

### 问题 4: 缺少 DLL 文件（Windows）

**原因**：用户电脑缺少 Visual C++ 运行时

**解决**：
- 提示用户安装 [Visual C++ Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe)
- 或在打包时包含运行时文件

## 📤 分发应用

### Windows

1. 将 `朝堂 Setup 0.1.0.exe` 上传到网盘或服务器
2. 用户下载后双击安装
3. 按照安装向导完成安装

### macOS

1. 将 `.dmg` 文件提供给用户
2. 用户拖拽到 Applications 文件夹

### Linux

1. 提供 `.AppImage` 文件
2. 用户添加执行权限后直接运行：
```bash
chmod +x 朝堂-0.1.0.AppImage
./朝堂-0.1.0.AppImage
```

## 🔄 版本更新

### 更新版本号

```bash
# 修改 package.json 中的 version
"version": "0.2.0"

# 重新打包
npm run build
npm run electron:build
```

### 自动更新（高级）

可以集成 `electron-updater` 实现自动更新功能。

## 📊 打包后检查清单

打包完成后，请检查：

- [ ] 安装包生成成功
- [ ] 应用图标正确显示
- [ ] 安装过程正常
- [ ] 应用可以正常启动
- [ ] 所有功能正常工作
- [ ] API Key 配置正常
- [ ] 朝议功能可用

## 🎯 下一步

打包完成后：

1. **测试安装包**
   - 在干净的环境中测试安装
   - 验证所有功能正常

2. **准备发布**
   - 编写更新日志
   - 准备发布说明
   - 截图或录制演示视频

3. **分发渠道**
   - GitHub Releases
   - 网盘分享
   - 官方网站下载

---

**所有打包问题已解决，可以开始发布！** 🎉

如需帮助，请查看：
- [FIXES.md](./FIXES.md) - 错误修复记录
- [ELECTRON-USAGE.md](./ELECTRON-USAGE.md) - Electron 使用说明
- [QUICKSTART.md](./QUICKSTART.md) - 快速启动指南
