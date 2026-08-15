<#
.SYNOPSIS
    Deterministic UI state capture harness for the Transfer Ledger showcase and
    the Todo 28 full auth-state matrix.

.DESCRIPTION
    -Mode Showcase invokes the primitive showcase capture driver, which renders
    every theme at the three breakpoint widths and 100%/200% scaling plus
    reduced-motion variants, then writes a named PNG matrix plus
    showcase-manifest.json into the output directory.
    -Mode Full invokes the Todo 28 auth-surface capture driver, which renders
    every ownership and browser-code state across all three themes, widths,
    scales, and locales plus reduced-motion variants, then writes
    ui-matrix-manifest.json and ui-*.png into the output directory.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/capture_ui_states.ps1 -Mode Showcase -Output .omo/evidence/task-23-windows-huggingface-manager
    powershell -ExecutionPolicy Bypass -File scripts/capture_ui_states.ps1 -Mode Full -Output .omo/evidence/task-28-windows-huggingface-manager
#>
param(
    [ValidateSet("Showcase", "Full")]
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
    if ($Mode -eq "Full") {
        & uv run --frozen --offline python -m hubfetch.ui.auth --output $Output
        $manifest = Join-Path $Output "ui-matrix-manifest.json"
        $pngGlob = "ui-*.png"
    } else {
        & uv run --frozen --offline python -m hubfetch.ui.capture --mode Showcase --output $Output
        $manifest = Join-Path $Output "showcase-manifest.json"
        $pngGlob = "showcase-*.png"
    }
    if ($LASTEXITCODE -ne 0) {
        throw "capture harness exited with code $LASTEXITCODE"
    }
    if (-not (Test-Path -LiteralPath $manifest)) {
        throw "manifest missing: $manifest"
    }
    $pngs = @(Get-ChildItem -Path $Output -Filter $pngGlob)
    Write-Host ("manifest: {0}" -f $manifest)
    Write-Host ("png files: {0}" -f $pngs.Count)
    if ($pngs.Count -eq 0) {
        throw "no PNG captures produced"
    }
}
finally {
    Pop-Location
}
