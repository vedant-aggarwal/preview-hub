# Registers the PreviewHub logon task (current user, no admin) and starts it.
$root = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $root 'scripts\launch.vbs'
$ps1 = Join-Path $root 'scripts\supervise.ps1'
Set-Content -Path $vbs -Encoding ASCII -Value ('CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""' + $ps1 + '""", 0, True')
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'PreviewHub' -Action $action -Trigger $trigger -Settings $settings `
  -Description "Preview hub ($root)" -Force | Out-Null
Start-ScheduledTask -TaskName 'PreviewHub'
