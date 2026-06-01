param(
	[string] $SourceArchive = "",
	[string] $SourceDir = "",
	[string] $BuildDir = "",
	[string] $OutputDir = "",
	[int] $Jobs = 0
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptPath = Join-Path $scriptDir "build-ngspice-wasm.sh"

$bashCandidates = @()
$bashCommand = Get-Command bash -ErrorAction SilentlyContinue
if ($bashCommand) {
	$bashCandidates += $bashCommand.Source
}
$bashCandidates += @(
	"D:\Git\Git\bin\bash.exe",
	"D:\Git\Git\usr\bin\bash.exe",
	"C:\Program Files\Git\bin\bash.exe",
	"C:\msys64\usr\bin\bash.exe"
)

$bash = $bashCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $bash) {
	throw "bash was not found. For a self-bootstrapping Windows build, run wasm-build/build-ngspice-wasm.windows.ps1 instead."
}

if ($SourceArchive) { $env:NGSPICE_SOURCE_ARCHIVE = $SourceArchive }
if ($SourceDir) { $env:NGSPICE_SOURCE_DIR = $SourceDir }
if ($BuildDir) { $env:NGSPICE_BUILD_DIR = $BuildDir }
if ($OutputDir) { $env:NGSPICE_OUTPUT_DIR = $OutputDir }
if ($Jobs -gt 0) { $env:JOBS = [string] $Jobs }

& $bash $scriptPath
if ($LASTEXITCODE -ne 0) {
	exit $LASTEXITCODE
}
