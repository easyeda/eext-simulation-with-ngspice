param(
  [string]$EnginePath = ""
)

$ErrorActionPreference = "Stop"
$ProtocolName = "jlc-ngspice-launch"
$ScriptPath = Join-Path $PSScriptRoot "start-jlc-ngspice-engine.ps1"
$ConfigPath = Join-Path $PSScriptRoot "launcher-config.json"

if (-not (Test-Path -LiteralPath $ScriptPath)) {
  throw "Missing launcher script: $ScriptPath"
}

if ($EnginePath) {
  $resolved = Resolve-Path -LiteralPath $EnginePath
  $EnginePath = $resolved.Path
}
else {
  $candidates = @(
    "D:\lceda-pro-sim\lceda-pro-sim-server.exe",
    "D:\lceda-pro-sim\lceda-pro-sim.exe",
    "C:\lceda-pro-sim\lceda-pro-sim-server.exe",
    "C:\lceda-pro-sim\lceda-pro-sim.exe"
  )
  $EnginePath = ($candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1)
}

if ($EnginePath) {
  @{ enginePath = $EnginePath } | ConvertTo-Json | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
}

$powerShellPath = Join-Path $PSHOME "powershell.exe"
$command = "`"$powerShellPath`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`" `"%1`""
$keyPath = "HKCU:\Software\Classes\$ProtocolName"

New-Item -Path $keyPath -Force | Out-Null
Set-Item -Path $keyPath -Value "URL:JLC NGspice launcher"
Set-ItemProperty -Path $keyPath -Name "URL Protocol" -Value ""
New-Item -Path "$keyPath\shell\open\command" -Force | Out-Null
Set-Item -Path "$keyPath\shell\open\command" -Value $command

Write-Host "Registered protocol: ${ProtocolName}://"
Write-Host "Launcher script: $ScriptPath"
if ($EnginePath) {
  Write-Host "Engine path: $EnginePath"
}
else {
  Write-Host "Engine path was not found. Re-run with -EnginePath `"D:\path\to\lceda-pro-sim-server.exe`"."
}
