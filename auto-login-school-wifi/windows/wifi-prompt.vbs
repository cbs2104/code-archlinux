' ============================================================================
'  校园网自动登录 - 登录 Windows 时的 Wi-Fi 询问器
'
'  作用：登录后如果一个网络都没连上，就弹出一个控制台窗口运行
'        auto_connect.py --ask，让你选要连哪个 Wi-Fi（是否保存 / 优先级）；
'        已经有任何连接时立刻退出，不打扰你。
'  由 windows/install.ps1 --with-autostart 注册成“登录时触发”的计划任务。
' ============================================================================
Option Explicit

Dim shell, fso, root, py, q, out, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' 本文件放在 <项目根>/windows/ 下，所以根目录是它的上一层
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
py = "python"
q = Chr(34)

If Not fso.FileExists(root & "\auto_connect.py") Then WScript.Quit 0

' 已经连上任何网络就直接退出（网页认证由 --boot 计划任务负责）
On Error Resume Next
out = shell.Exec("cmd /c netsh interface show interface").StdOut.ReadAll()
If Err.Number <> 0 Then out = ""
On Error GoTo 0
If InStr(1, out, "Connected", 1) > 0 Or InStr(1, out, "已连接", 1) > 0 Then WScript.Quit 0

' 打开一个可见的控制台窗口跑交互向导（/k 让用户能看到结果）
cmd = "cmd /k " & q & py & q & " " & q & root & "\auto_connect.py" & q & " --ask"
shell.Run cmd, 1, False