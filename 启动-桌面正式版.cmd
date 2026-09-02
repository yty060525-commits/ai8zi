@echo off
rem 启动正式版(免安装便携 exe)。数据库自动创建在 exe 同目录的 data\ 下，随文件夹迁移。
set "EXE=%~dp0release\windows\命理客户端.exe"
if not exist "%EXE%" (
  echo [ERROR] %EXE% 不存在，请先运行 client\build-windows.cmd 构建。
  pause
  exit /b 1
)
start "" "%EXE%"
