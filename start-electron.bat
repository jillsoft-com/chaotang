@echo off
chcp 65001 >nul
echo ========================================
echo   朝堂 - 桌面应用启动脚本
echo ========================================
echo.

echo [提示] 推荐使用 PowerShell 运行 start-electron.ps1 获得更好体验
echo.

echo [1/2] 启动 Web 服务...
start "Vite Server" cmd /k "npm run dev"

echo 等待服务启动...
timeout /t 5 /nobreak >nul

echo [2/2] 启动 Electron 桌面窗口...
set NODE_ENV=development
npx electron .

echo.
echo 应用已关闭
pause
