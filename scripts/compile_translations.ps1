# Compiles both Qt translation catalogs with pyside6-lrelease.
#
# Usage:
#   .\scripts\compile_translations.ps1 [-OutputDir <dir>]
#
# -OutputDir defaults to resources\i18n (next to the .ts sources). Pass an
# explicit directory to compile into a build or evidence location.
# The .qm outputs are generated artifacts and are intentionally gitignored.

param(
    [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$SourceDir = Join-Path $RepoRoot "resources\i18n"
if (-not $OutputDir) {
    $OutputDir = $SourceDir
}
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

# Locate pyside6-lrelease: prefer an on-PATH executable, then the venv copy.
$lrelease = Get-Command pyside6-lrelease -ErrorAction SilentlyContinue
if (-not $lrelease) {
    $venvLrelease = Join-Path $RepoRoot ".venv\Scripts\pyside6-lrelease.exe"
    if (Test-Path $venvLrelease) {
        $lrelease = Get-Item $venvLrelease
    }
}
if (-not $lrelease) {
    throw "pyside6-lrelease was not found on PATH or in the project venv"
}

foreach ($catalog in @("hubfetch_zh_CN.ts", "hubfetch_en_US.ts")) {
    $source = Join-Path $SourceDir $catalog
    $qmName = [System.IO.Path]::GetFileNameWithoutExtension($catalog) + ".qm"
    $target = Join-Path $OutputDir $qmName
    Write-Host "Compiling $catalog -> $target"
    & $lrelease.Source -silent $source -qm $target
    if ($LASTEXITCODE -ne 0) {
        throw "lrelease failed for $catalog with exit code $LASTEXITCODE"
    }
}

Write-Host "Compiled both catalogs into $OutputDir"
