<#
  校园网自动登录 - Windows 卸载脚本：删除已注册的计划任务。
  用法： powershell -ExecutionPolicy Bypass -File windows\uninstall.ps1
  注意：只删除计划任务，不会删除脚本和 config.json。
#>
$taskName = 'CampusNetAutoLogin'
$wifiTaskName = 'CampusWifiPrompt'
$taskPath = '\CampusNetwork\'

$removed = 0
foreach ($name in @($taskName, $wifiTaskName)) {
    $task = Get-ScheduledTask -TaskName $name -TaskPath $taskPath -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskName $name -TaskPath $taskPath -Confirm:$false
        Write-Host "已删除计划任务: $taskPath$name" -ForegroundColor Green
        $removed++
    } else {
        Write-Host "没有找到计划任务 $taskPath$name（可能已经删过了）。" -ForegroundColor Yellow
    }
}
if ($removed -gt 0) {
    Write-Host '提示：自动连接过的 Wi-Fi 配置仍在系统里。要清掉某一个可以用：' -ForegroundColor Cyan
    Write-Host '      python auto_connect.py --forget <SSID>' -ForegroundColor Cyan
}

Write-Host '脚本与 config.json 仍然保留，如需彻底清理请手动删除整个文件夹。'
Write-Host '如果只想临时停用: Disable-ScheduledTask -TaskName CampusNetAutoLogin -TaskPath ''\CampusNetwork\'''
