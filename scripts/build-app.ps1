<#
.SYNOPSIS
    Build the frozen gazeCOM desktop app on Windows.

.DESCRIPTION
    The same three steps the release CI runs, wrapped in one command:
      1. compile the frontend into a static bundle (frontend\dist)
      2. install the backend + PyInstaller into backend\.venv
      3. freeze everything into a standalone app

    Output: dist\gazeCOM\gazeCOM.exe  (onedir — run it from *inside* the
    dist\gazeCOM\ folder; it needs the files next to it).

    Prerequisites: Python 3.11+, Node 20+, and pnpm on PATH.
#>
$ErrorActionPreference = "Stop"

# Repo root = the parent of this script's directory, so it works from anywhere.
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Venv = Join-Path $Root "backend\.venv"
$Py = Join-Path $Venv "Scripts\python.exe"

Write-Host "==> [1/3] Building frontend bundle"
Push-Location frontend
pnpm install
pnpm build
Pop-Location

Write-Host "==> [2/3] Preparing Python build environment"
if (-not (Test-Path $Py)) {
    Write-Host "    creating venv at backend\.venv"
    python -m venv $Venv
}
& $Py -m pip install --upgrade pip | Out-Null
Push-Location backend
& $Py -m pip install ".[build]"
Pop-Location

Write-Host "==> [3/3] Freezing the app with PyInstaller"
& $Py -m PyInstaller gazecom.spec --noconfirm
Copy-Item (Join-Path $Root "LICENSE") (Join-Path $Root "dist\gazeCOM\LICENSE") -Force
Copy-Item (Join-Path $Root "THIRD_PARTY_NOTICES.md") (Join-Path $Root "dist\gazeCOM\THIRD_PARTY_NOTICES.md") -Force

Write-Host ""
Write-Host "Done -> $Root\dist\gazeCOM\gazeCOM.exe  (double-click to launch; a console"
Write-Host "        window opens with the URL and logs — close it or Ctrl-C to quit)"
