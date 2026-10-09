# 🔧 Electron 生产模式路径修复

## 问题

运行 `npm run electron:preview` 时出现错误：
```
Failed to load URL: file:///D:/Workspace/ChaoTang/electron/dist/index.html 
with error: ERR_FILE_NOT_FOUND
```

## 原因

Electron 主进程文件在 `electron/main.cjs`，使用 `__dirname` 获取的是 `electron/` 目录路径，但构建输出的 `dist/` 目录在项目根目录，不在 `electron/` 目录下。

### 目录结构
```
ChaoTang/
├── dist/              # ✅ Vite 构建输出在这里
├── electron/
│   └── main.cjs       # __dirname 指向这里
└── public/
```

## 解决方案

修改 `electron/main.cjs` 中的路径：

### 1. 修复 HTML 加载路径
```javascript
// 修改前 ❌
mainWindow.loadFile(path.join(__dirname, 'dist/index.html'))

// 修改后 ✅
mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
```

### 2. 修复图标路径
```javascript
// 修改前 ❌
icon: path.join(__dirname, 'public/icon.png')

// 修改后 ✅
icon: path.join(__dirname, '../public/icon.png')
```

## 验证

```bash
npm run electron:preview
```

✅ 成功启动，无报错

## 相关文件

- [electron/main.cjs](../electron/main.cjs) - 已修复
- [docs/FIXES.md](./FIXES.md) - 完整修复记录

---

**修复时间**: 2026-10-08  
**状态**: ✅ 已解决
