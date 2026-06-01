param(
  [string]$Uri = ""
)

$ErrorActionPreference = "SilentlyContinue"
$LogPath = Join-Path $env:TEMP "jlc-ngspice-waveform-launcher.log"
$ConfigPath = Join-Path $PSScriptRoot "launcher-config.json"

function Write-LaunchLog {
  param([string]$Message)
  $time = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $LogPath -Value "[$time] $Message" -Encoding UTF8
}

function Test-EnginePort {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect("127.0.0.1", 51115, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(700)) {
      $client.Close()
      return $false
    }
    $client.EndConnect($async)
    $client.Close()
    return $true
  }
  catch {
    return $false
  }
}

function Get-ConfiguredEnginePath {
  if (Test-Path -LiteralPath $ConfigPath) {
    try {
      $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($config.enginePath -and (Test-Path -LiteralPath $config.enginePath)) {
        return [string]$config.enginePath
      }
    }
    catch {
      Write-LaunchLog "Failed to read config: $($_.Exception.Message)"
    }
  }

  if ($env:JLC_NGSPICE_ENGINE_PATH -and (Test-Path -LiteralPath $env:JLC_NGSPICE_ENGINE_PATH)) {
    return $env:JLC_NGSPICE_ENGINE_PATH
  }

  $candidates = @(
    "D:\lceda-pro-sim\lceda-pro-sim-server.exe",
    "D:\lceda-pro-sim\lceda-pro-sim.exe",
    "C:\lceda-pro-sim\lceda-pro-sim-server.exe",
    "C:\lceda-pro-sim\lceda-pro-sim.exe"
  )

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }

  return ""
}

Write-LaunchLog "Launcher invoked: $Uri"

if (Test-EnginePort) {
  Write-LaunchLog "Engine port 51115 is already available"
  exit 0
}

$enginePath = Get-ConfiguredEnginePath
if (-not $enginePath) {
  Write-LaunchLog "Engine executable not found. Set EnginePath via install-launch-protocol.ps1 -EnginePath <path>."
  exit 2
}

try {
  Write-LaunchLog "Starting engine: $enginePath"
  Start-Process -FilePath $enginePath -WorkingDirectory (Split-Path -Parent $enginePath) -WindowStyle Hidden
  exit 0
}
catch {
  Write-LaunchLog "Failed to start engine: $($_.Exception.Message)"
  exit 3
}
