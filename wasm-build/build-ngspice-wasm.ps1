param(
	[string] $SourceArchive = "",
	[string] $SourceDir = "",
	[string] $BuildDir = "",
	[string] $OutputDir = "",
	[int] $Jobs = 0,
	[ValidateSet("release", "fast")]
	[string] $LinkMode = "release",
	[switch] $Clean
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDir ".."))
$scriptPath = Join-Path $scriptDir "build-ngspice-wasm.sh"

function Use-BundledEmsdk {
	$emsdkRoot = Join-Path $repoRoot "third_party\emsdk"
	$emcc = Join-Path $emsdkRoot "upstream\emscripten\emcc.bat"
	if (-not (Test-Path -LiteralPath $emcc)) {
		return
	}

	$node = Get-ChildItem -Path (Join-Path $emsdkRoot "node") -Filter "node.exe" -Recurse -ErrorAction SilentlyContinue |
		Select-Object -First 1 -ExpandProperty FullName
	$python = Get-ChildItem -Path (Join-Path $emsdkRoot "python") -Filter "python.exe" -Recurse -ErrorAction SilentlyContinue |
		Select-Object -First 1 -ExpandProperty FullName

	if (-not $node) { throw "Bundled emsdk node.exe was not found under ${emsdkRoot}." }
	if (-not $python) { throw "Bundled emsdk python.exe was not found under ${emsdkRoot}." }

	$env:EMSDK = $emsdkRoot
	$env:EM_CONFIG = Join-Path $emsdkRoot ".emscripten"
	$env:EMSDK_NODE = $node
	$env:EMSDK_PYTHON = $python
	$env:PATH = "$emsdkRoot;$(Join-Path $emsdkRoot "upstream\emscripten");$(Split-Path -Parent $node);$(Split-Path -Parent $python);$env:PATH"
}

Use-BundledEmsdk

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
$env:NGSPICE_LINK_MODE = $LinkMode
if ($Clean) { $env:NGSPICE_CLEAN = "1" } else { Remove-Item Env:\NGSPICE_CLEAN -ErrorAction SilentlyContinue }

& $bash $scriptPath
if ($LASTEXITCODE -ne 0) {
	exit $LASTEXITCODE
}
