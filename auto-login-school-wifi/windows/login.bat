@echo off
chcp 65001 >nul
rem ===========================================================================
rem  校园网自动登录 - Windows 手动运行入口（双击即可，也可以放到「启动」文件夹）
rem  需要先安装 Python 3.8+，安装时勾选 "Add python.exe to PATH"
rem ===========================================================================
setlocal
set "SCRIPT=%~dp0..\portal_login.py"

where python >nul 2>nul && (
  python "%SCRIPT%" %*
  goto :end
)
where py >nul 2>nul && (
  py -3 "%SCRIPT%" %*
  goto :end
)
echo [ERROR] 没有找到 Python，请先安装 Python 3.8+ 并勾选 Add python.exe to PATH
pause
exit /b 2

:end
rem 双击运行时保留窗口，方便看结果
if "%~1"=="" pause
endlocal
