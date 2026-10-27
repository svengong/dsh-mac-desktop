# Build the Windows installers into dist/. Run from the repo root or anywhere:
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1 -Arch arm64
#
# Produces an NSIS installer, a portable .exe and a .zip for the chosen
# architecture. Both x64 and arm64 are first-class targets: Windows on ARM
# runs the arm64 build natively.
param(
  [ValidateSet('x64', 'arm64', 'both')]
  [string]$Arch = 'both'
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

if (-not (Test-Path 'node_modules')) {
  Write-Host 'Installing dependencies...'
  npm install
}

# NSIS/portable packaging downloads helper binaries; point electron-builder at
# a workspace-local cache so a locked-down profile dir cannot break the build.
$env:ELECTRON_BUILDER_CACHE = (Join-Path (Get-Location) '.cache\electron-builder')
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'

# Go through scripts/build-win.js rather than calling electron-builder here.
# It pins ELECTRON_BUILDER_7Z_FILTER=BCJ — without it the NSIS payload is packed
# with BCJ2, which the installer's own extractor cannot decode, so it SILENTLY
# SKIPS every PE file (the main .exe and all .dlls). The installer still exits
# 0 and leaves a directory that looks installed. Reproduced on Windows 11 ARM64:
# 68 files/71.3MB/0 dlls/no exe with BCJ2 versus 75 files/287.7MB/6 dlls/exe
# with BCJ. The wrapper also re-checks the payload method after building.
$nodeArgs = @('scripts/build-win.js', '--publish', 'never')
switch ($Arch) {
  'both' { }
  default { $nodeArgs += "--$Arch" }
}

Write-Host "Building Windows installers ($Arch)..."
& node @nodeArgs
if ($LASTEXITCODE -ne 0) { throw "Windows packaging failed with exit code $LASTEXITCODE" }

Write-Host ''
Write-Host 'Built:'
Get-ChildItem dist -Filter '*windows*' |
  Where-Object { $_.Extension -in '.exe', '.zip' } |
  ForEach-Object { Write-Host ("  " + $_.Name + "  (" + [math]::Round($_.Length / 1MB, 1) + " MB)") }
Write-Host ''
Write-Host 'Run the *-setup.exe to install, or *-portable.exe for a no-install build.'
Write-Host 'ALWAYS verify on real Windows that the installed app has "DeepSeek Harness.exe".'
