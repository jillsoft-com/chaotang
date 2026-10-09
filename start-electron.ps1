# 朝堂 - Electron 桌面应用启动脚本 (PowerShell)
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  朝堂 - 桌面应用启动中..." -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
Write-Host ""

# 设置工作目录
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

Write-Host "[1/2] 检查 Web 服务状态..." -ForegroundColor Cyan

# 检查端口 3000 是否已被占用
$port = 3000
$isPortInUse = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue

if (-not $isPortInUse) {
    Write-Host "      启动 Web 开发服务器..." -ForegroundColor Cyan
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$projectRoot'; npm run dev" -WindowStyle Normal
    Start-Sleep -Seconds 5
} else {
    Write-Host "      Web 服务已在端口 $port 运行" -ForegroundColor Green
}

Write-Host "[2/2] 启动 Electron 桌面窗口..." -ForegroundColor Cyan

# 设置环境变量
$env:NODE_ENV = 'development'

# 启动 Electron
try {
    Write-Host "      正在启动..." -ForegroundColor Green
    & npx electron .
} catch {
    Write-Host "启动失败: $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "应用已关闭" -ForegroundColor Yellow
Read-Host "按 Enter 键退出"
