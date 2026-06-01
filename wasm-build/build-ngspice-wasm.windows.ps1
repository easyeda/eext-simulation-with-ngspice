param(
	[string] $EmsdkVersion = "5.0.7",
	[string] $SourceArchive = "",
	[string] $SourceDir = "",
	[string] $BuildDir = "",
	[string] $OutputDir = "",
	[int] $Jobs = 0,
	[switch] $SkipToolBootstrap
)

$ErrorActionPreference = "Stop"

function Resolve-RepoPath([string] $RelativePath) {
	return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\${RelativePath}"))
}

function Find-CommandPath([string] $Name) {
	$command = Get-Command $Name -ErrorAction SilentlyContinue
	if ($command) { return $command.Source }
	return $null
}

function Ensure-Emsdk {
	$emsdkRoot = Resolve-RepoPath "wasm-build\emsdk"
	$emsdkBat = Join-Path $emsdkRoot "emsdk.bat"
	if (-not (Test-Path -LiteralPath $emsdkBat)) {
		if ($SkipToolBootstrap) {
			throw "emsdk was not found at ${emsdkRoot}. Remove -SkipToolBootstrap or install emsdk manually."
		}
		$git = Find-CommandPath "git"
		if (-not $git) {
			throw "git was not found. Install Git for Windows, then rerun this script."
		}
		& $git clone https://github.com/emscripten-core/emsdk.git $emsdkRoot
		if ($LASTEXITCODE -ne 0) { throw "Failed to clone emsdk." }
	}

	$emcc = Join-Path $emsdkRoot "upstream\emscripten\emcc.bat"
	if (-not (Test-Path -LiteralPath $emcc)) {
		& $emsdkBat install $EmsdkVersion
		if ($LASTEXITCODE -ne 0) { throw "Failed to install emsdk ${EmsdkVersion}." }
		& $emsdkBat activate $EmsdkVersion
		if ($LASTEXITCODE -ne 0) { throw "Failed to activate emsdk ${EmsdkVersion}." }
	}

	$node = Get-ChildItem -Path (Join-Path $emsdkRoot "node") -Filter "node.exe" -Recurse -ErrorAction SilentlyContinue |
		Select-Object -First 1 -ExpandProperty FullName
	$python = Get-ChildItem -Path (Join-Path $emsdkRoot "python") -Filter "python.exe" -Recurse -ErrorAction SilentlyContinue |
		Select-Object -First 1 -ExpandProperty FullName

	if (-not $node) { throw "emsdk node.exe was not found." }
	if (-not $python) { throw "emsdk python.exe was not found." }

	$env:EMSDK = $emsdkRoot
	$env:EMSDK_NODE = $node
	$env:EMSDK_PYTHON = $python
	return $emsdkRoot
}

function Ensure-Msys2 {
	$candidates = @(
		"C:\msys64\usr\bin\bash.exe",
		"D:\msys64\usr\bin\bash.exe",
		(Resolve-RepoPath "wasm-build\tools\msys64\usr\bin\bash.exe")
	)
	$bash = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
	if ($bash) { return $bash }

	if ($SkipToolBootstrap) {
		throw "MSYS2 bash was not found. Remove -SkipToolBootstrap or install MSYS2 manually."
	}

	$winget = Find-CommandPath "winget"
	if (-not $winget) {
		throw "MSYS2 was not found and winget is unavailable. Install MSYS2 or Git for Windows + make/gcc, then rerun."
	}

	& $winget install --id MSYS2.MSYS2 -e --silent --accept-package-agreements --accept-source-agreements
	if ($LASTEXITCODE -ne 0) { throw "Failed to install MSYS2 via winget." }

	$bash = @("C:\msys64\usr\bin\bash.exe", "D:\msys64\usr\bin\bash.exe") |
		Where-Object { Test-Path -LiteralPath $_ } |
		Select-Object -First 1
	if (-not $bash) { throw "MSYS2 installed, but bash.exe was not found." }
	return $bash
}

function Add-MsysPackages([string] $BashPath) {
	if ($SkipToolBootstrap) { return }
	& $BashPath -lc "pacman --noconfirm -Sy --needed base-devel mingw-w64-x86_64-gcc tar gzip xz"
	if ($LASTEXITCODE -ne 0) { throw "Failed to install required MSYS2 packages." }
}

function ConvertTo-MsysPath([string] $WindowsPath) {
	$fullPath = [System.IO.Path]::GetFullPath($WindowsPath)
	if ($fullPath -match "^([A-Za-z]):\\(.*)$") {
		$drive = $Matches[1].ToLowerInvariant()
		$rest = $Matches[2] -replace "\\", "/"
		return "/${drive}/${rest}"
	}
	return $fullPath -replace "\\", "/"
}

$emsdkRoot = Ensure-Emsdk
$bash = Ensure-Msys2
Add-MsysPackages $bash

$msysRoot = Split-Path -Parent (Split-Path -Parent $bash)
$mingwBin = Join-Path $msysRoot "mingw64\bin"
$usrBin = Join-Path $msysRoot "usr\bin"
$emscripten = Join-Path $emsdkRoot "upstream\emscripten"
$nodeDir = Split-Path -Parent $env:EMSDK_NODE
$pythonDir = Split-Path -Parent $env:EMSDK_PYTHON

$env:PATH = "$mingwBin;$emsdkRoot;$emscripten;$nodeDir;$pythonDir;$usrBin;$env:PATH"

if ($SourceArchive) { $env:NGSPICE_SOURCE_ARCHIVE = $SourceArchive }
if ($SourceDir) { $env:NGSPICE_SOURCE_DIR = $SourceDir }
if ($BuildDir) { $env:NGSPICE_BUILD_DIR = $BuildDir }
if ($OutputDir) { $env:NGSPICE_OUTPUT_DIR = $OutputDir }
if ($Jobs -gt 0) { $env:JOBS = [string] $Jobs }

$repoMsysPath = ConvertTo-MsysPath $PWD.Path
& $bash -lc "cd '$repoMsysPath'; JOBS='${env:JOBS}' bash wasm-build/build-ngspice-wasm.sh"
if ($LASTEXITCODE -ne 0) {
	exit $LASTEXITCODE
}

node wasm-build\embed-xspice-codemodels.mjs
Copy-Item wasm-lib\ngspice.js,wasm-lib\ngspice.wasm,wasm-lib\ngspice-wasm-binary.js,wasm-lib\ngspice-global.js,wasm-lib\ngspice-xspice-codemodels.js,wasm-lib\NGSPICE-COPYING.txt,wasm-lib\NGSPICE-AUTHORS.txt -Destination iframe\wasm -Force

Write-Host "NGspice XSPICE WASM build complete. Runtime files are in iframe\wasm."
