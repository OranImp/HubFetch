<#
.SYNOPSIS
    Deterministic UI state capture harness for the Transfer Ledger showcase.

.DESCRIPTION
    Invokes the HubFetch capture driver, which renders the primitive showcase
    offscreen for every theme (light, dark, high contrast), the three
    breakpoint widths (<760, 760-1179, >=1180 effective px), 100% and 200%
    scaling, and reduced-motion variants, then writes a named PNG matrix plus
    showcase-manifest.json into the output directory.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/capture_ui_states.ps1 -Mode Showcase -Output .omo/evidence/task-23-windows-huggingface-manager
#>
param(
    [ValidateSet("Showcase")]
    [string]$Mode = "Showcase",
    [Parameter(Mandatory = $true)]
    [string]$Output
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $repoRoot
try {
    $env:QT_QPA_PLATFORM = "offscreen"
    $env:QT_API = "pyside6"
    if (-not (Test-Path -LiteralPath $Output)) {
        New-Item -ItemType Directory -Path $Output | Out-Null
    }
    Write-Host "capturing $Mode state matrix into $Output"
    & uv run --frozen --offline python -m hubfetch.ui.capture --mode $Mode --output $Output
    if ($LASTEXITCODE -ne 0) {
        throw "capture harness exited with code $LASTEXITCODE"
    }
    $manifest = Join-Path $Output "showcase-manifest.json"
    if (-not (Test-Path -LiteralPath $manifest)) {
        throw "manifest missing: $manifest"
    }
    $pngs = @(Get-ChildItem -Path $Output -Filter "showcase-*.png")
    Write-Host ("manifest: {0}" -f $manifest)
    Write-Host ("png files: {0}" -f $pngs.Count)
    if ($pngs.Count -eq 0) {
        throw "no PNG captures produced"
    }
}
finally {
    Pop-Location
}
