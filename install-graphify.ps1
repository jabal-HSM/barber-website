# Graphify setup for ZEYD BARBER - run once from PowerShell
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path","User") + ";" +
                "$env:USERPROFILE\.local\bin"
}

Write-Host "[1/4] Checking uv..." -ForegroundColor Cyan
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "winget not found. Install 'App Installer' from the Microsoft Store, then re-run."
    }
    winget install --id astral-sh.uv -e --accept-source-agreements --accept-package-agreements
    Refresh-Path
}
uv --version

Write-Host "[2/4] Installing Graphify (package: graphifyy)..." -ForegroundColor Cyan
uv tool install graphifyy
uv tool update-shell
Refresh-Path
graphify --version

Write-Host "[3/4] Building the project graph (code only, offline)..." -ForegroundColor Cyan
graphify extract . --code-only

Write-Host "[4/4] Done. Opening the graph..." -ForegroundColor Green
$html = Join-Path $PSScriptRoot "graphify-out\graph.html"
if (Test-Path $html) { Start-Process $html } else { Write-Host "graph.html not found - check the output above." -ForegroundColor Yellow }
