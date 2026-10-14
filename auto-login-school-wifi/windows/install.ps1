<#
  校园网自动登录 - Windows 安装脚本（注册计划任务）
  --------------------------------------------------------------------------
  用法（PowerShell，普通用户权限即可，不需要管理员）：

      powershell -ExecutionPolicy Bypass -File windows\install.ps1
      powershell -ExecutionPolicy Bypass -File windows\install.ps1 -IntervalMinutes 5

  参数：
      -IntervalMinutes N  兜底轮询间隔，默认 5 分钟（掉线后最多 N 分钟自动重连）
      -NoRepeat           不注册轮询触发器，只在「登录时 / 网络连接时」触发
      -NoWifi             不用 auto_connect.py 管 Wi-Fi，只做网页认证（旧行为）
      -WithAutostart      额外注册「登录时若没网就弹窗询问 Wi-Fi」的任务

  注册的触发方式：
      1) 用户登录时
      2) 网络连接事件（Microsoft-Windows-NetworkProfile/Operational, EventID 10000）
      3) 每 N 分钟兜底轮询
  以 pythonw.exe 运行，不会弹出黑色窗口。
  默认会用 auto_connect.py --boot：开机连上所有已保存的 Wi-Fi，并自动完成校园网认证。
#>
param(
    [int]$IntervalMinutes = 5,
    [switch]$NoRepeat,
    [switch]$NoWifi,
    [switch]$WithAutostart
)

$ErrorActionPreference = 'Stop'

$here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$root     = Split-Path -Parent $here
$script   = Join-Path $root 'portal_login.py'
$config   = Join-Path $root 'config.json'
$wifi     = Join-Path $root 'auto_connect.py'
$promptVbs = Join-Path $here 'wifi-prompt.vbs'
$taskName = 'CampusNetAutoLogin'
$wifiTaskName = 'CampusWifiPrompt'
$taskPath = '\CampusNetwork\'

function Get-PythonPath {
    param([string[]]$Names)
    foreach ($name in $Names) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    return $null
}

$pythonw = Get-PythonPath @('pythonw.exe', 'python.exe')
$python  = Get-PythonPath @('python.exe', 'py.exe')
# 用于「生成配置模板」这类需要看输出的场景；实在没有带控制台的解释器就退回 pythonw
$runner  = if ($python) { $python } else { $pythonw }


if (-not $pythonw) {
    throw '没有找到 Python。请先安装 Python 3.8+，安装时勾选 "Add python.exe to PATH"。'
}
if (-not (Test-Path $script)) {
    throw "找不到 $script"
}

if (-not (Test-Path $config)) {
    Write-Host '还没有 config.json，正在生成模板……' -ForegroundColor Yellow
    & $runner $script --init
    Write-Host "请先填写 $config 里的 username / password，然后重新运行本脚本。" -ForegroundColor Yellow
    exit 2
}

Write-Host "Python      : $pythonw"
Write-Host "登录脚本    : $script"
Write-Host "配置文件    : $config"

# --- 是否用 auto_connect.py 一起管 Wi-Fi（默认开；-NoWifi 或文件不存在则关）---
$useWifi = (-not $NoWifi) -and (Test-Path $wifi)
if ($useWifi) {
    Write-Host 'Wi-Fi 管理  : 已启用（auto_connect.py --boot：连已保存网络 + 认证）' -ForegroundColor Green
} else {
    Write-Host 'Wi-Fi 管理  : 未启用（只做网页认证）' -ForegroundColor Yellow
}
$autoScript = if ($useWifi) { $wifi } else { $script }
$autoExtra  = if ($useWifi) { ' --boot' } else { '' }

# --- 动作 ---
$taskArgs = '"{0}" --config "{1}"{2} --quiet' -f $autoScript, $config, $autoExtra
$action = New-ScheduledTaskAction -Execute $pythonw -Argument $taskArgs -WorkingDirectory $root

# --- 触发器 ---
$triggers = @()
$triggers += New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

try {
    $class = Get-CimClass -Namespace 'Root/Microsoft/Windows/TaskScheduler' -ClassName 'MSFT_TaskEventTrigger'
    $evtTrigger = New-CimInstance -CimClass $class -ClientOnly
    $evtTrigger.Enabled = $true
    $evtTrigger.Subscription = @"
<QueryList><Query Id="0" Path="Microsoft-Windows-NetworkProfile/Operational"><Select Path="Microsoft-Windows-NetworkProfile/Operational">*[System[EventID=10000]]</Select></Query></QueryList>
"@
    $triggers += $evtTrigger
    Write-Host '已添加触发器：网络连接时（EventID 10000）' -ForegroundColor Green
} catch {
    Write-Host "跳过「网络连接时」触发器：$($_.Exception.Message)" -ForegroundColor Yellow
}

if (-not $NoRepeat) {
    $triggers += New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
        -RepetitionDuration ([TimeSpan]::MaxValue)
    Write-Host "已添加触发器：每 $IntervalMinutes 分钟兜底检查一次" -ForegroundColor Green
}

# --- 设置 ---
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Action $action `
    -Trigger $triggers -Settings $settings -Principal $principal `
    -Description '校园网自动登录（auto-login-school-wifi）' -Force | Out-Null

Write-Host "计划任务已注册: $taskPath$taskName" -ForegroundColor Green

# --- 可选：登录时「一个网络都没连上就弹窗询问 Wi-Fi」 ---
if ($WithAutostart) {
    if (Test-Path $promptVbs) {
        $promptAction = New-ScheduledTaskAction -Execute 'wscript.exe' `
            -Argument ('"{0}"' -f $promptVbs) -WorkingDirectory $root
        $promptTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
        $promptSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 60)
        Register-ScheduledTask -TaskName $wifiTaskName -TaskPath $taskPath -Action $promptAction `
            -Trigger $promptTrigger -Settings $promptSettings -Principal $principal `
            -Description '登录时若没有任何网络连接，弹窗询问要连哪个 Wi-Fi' -Force | Out-Null
        Write-Host "已注册登录时询问任务: $taskPath$wifiTaskName" -ForegroundColor Green
    } else {
        Write-Host "没找到 $promptVbs，跳过登录时询问任务" -ForegroundColor Yellow
    }
}

# --- 立刻测试一次（用带控制台的 python 便于看输出）---
if ($python) {
    Write-Host "`n立刻测试一次登录：`n" -ForegroundColor Cyan
    if ($useWifi) {
        & $python $wifi --config $config --boot --debug
    } else {
        & $python $script --config $config
    }
}

Write-Host "`n完成。常用操作：`n" -ForegroundColor Cyan
$summary = @"
  立即执行一次 : Start-ScheduledTask -TaskName $taskName -TaskPath '$taskPath'
  查看任务信息 : Get-ScheduledTask -TaskName $taskName -TaskPath '$taskPath' | Format-List
  临时停用     : Disable-ScheduledTask -TaskName $taskName -TaskPath '$taskPath'
  看 Wi-Fi 列表: python "$wifi" --list
  手动选网连一次: python "$wifi" --ask
  卸载         : powershell -ExecutionPolicy Bypass -File windows\uninstall.ps1
  查看在线状态 : python "$script" --status
"@
Write-Host $summary -ForegroundColor Cyan

