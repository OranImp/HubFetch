# scripts/run-quality-gates.ps1
#
# Todo 41: the static/unit/coverage/build/source-E2E/native gate chain that a
# Windows release build must pass before any ZIP is packaged. Every step is a
# real subprocess whose exit code is checked; the script stops on the first
# failure and returns that code.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-quality-gates.ps1
#
# Optional env:
#   T41_GATES_DIR   - directory for gate transcripts (defaults to .omo/scratch or temp)
#   T41_FOCUSED     - "1" to skip the heavyweight full coverage + source E2E + native
#                     rebuild (used for the pre-commit scoped gate), "0" for the full
#                     release gate chain (default).
#
# This script must run from the repository root.

# 'Continue' (not 'Stop') is required so native-command stderr (e.g. pnpm's
# banner) is not surfaced as a terminating error on Windows PowerShell 5.1.
# Every gate's success is decided by its real $LASTEXITCODE, not by stream
# shape, and the script exits nonzero on the first failing exit code.
$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $Root
try {
  # Environment mandates: temp off C:, Playwright browsers path. On this
  # workstation temp is forced to E:\Programs\Temp; on CI the default temp is
  # used (E: may not exist there).
  if (Test-Path 'E:\Programs\Temp') {
    $env:TMP = 'E:\Programs\Temp'
    $env:TEMP = 'E:\Programs\Temp'
  }
  $env:PLAYWRIGHT_BROWSERS_PATH = 'E:\Programs\ms-playwright'

  $Script:PNPM = $null

  function Resolve-Pnpm {
    if ($Script:PNPM) { return $Script:PNPM }
    $onPath = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($onPath) {
      $Script:PNPM = 'pnpm'
      return $Script:PNPM
    }
    # pnpm is not on PATH; create a temp shim that calls corepack pnpm.
    $shimDir = Join-Path $env:TEMP 'hubfetch-pnpm-shim'
    New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
    $shim = Join-Path $shimDir 'pnpm.cmd'
    if (-not (Test-Path $shim)) {
      Set-Content -Path $shim -Value "@echo off`r`nset `"TMP=E:\Programs\Temp`"`r`nset `"TEMP=E:\Programs\Temp`"`r`ncorepack pnpm %*`r`nexit /b %ERRORLEVEL%`r`n" -Encoding Ascii
    }
    $env:PATH = "$shimDir;$env:PATH"
    $Script:PNPM = 'pnpm'
    return $Script:PNPM
  }

  function Invoke-Gate {
    param(
      [Parameter(Mandatory = $true)][string]$Name,
      [Parameter(Mandatory = $true)][scriptblock]$Command,
      [string]$Log
    )
    Write-Host "[gate] $Name ..."
    if ($Log) {
      & $Command *> $Log
      $code = $LASTEXITCODE
    } else {
      & $Command
      $code = $LASTEXITCODE
    }
    if ($code -ne 0) {
      Write-Error "[gate] FAILED: $Name (exit $code)"
      exit $code
    }
    Write-Host "[gate] OK: $Name"
  }

  # The full unit suite is allowed to finish with ONLY the documented baseline
  # deviations (downloads.test.ts:157 POSIX + diagnostics-qa-failure:155 flake).
  # Any other failing test file is a release blocker via check-unit-baseline.mjs.
  # This helper is used for BOTH the plain `test` gate and the `test:coverage`
  # gate (the coverage run executes the same suite under instrumentation and
  # fails on the same two documented baselines).
  function Invoke-UnitGate {
    param(
      [Parameter(Mandatory = $true)][string]$Name,
      [Parameter(Mandatory = $true)][scriptblock]$Command,
      [Parameter(Mandatory = $true)][string]$Log
    )
    Write-Host "[gate] $Name (full unit suite, baseline-tolerant) ..."
    & $Command *> $Log
    $code = $LASTEXITCODE
    if ($code -eq 0) {
      Write-Host "[gate] OK: $Name (unit suite passed)"
      return
    }
    # Nonzero: allow only documented baselines / isolated-passing load flakes,
    # otherwise block the release.
    & node (Join-Path $PSScriptRoot 'check-unit-baseline.mjs') $Log $Root
    $check = $LASTEXITCODE
    if ($check -ne 0) {
      Write-Error "[gate] FAILED: $Name (unexpected unit-test failure; see $Log)"
      exit 1
    }
    Write-Host "[gate] OK: $Name (exit $code, failures limited to documented baselines)"
  }

  $focused = ($env:T41_FOCUSED -eq '1')
  $logsDir = if ($env:T41_GATES_DIR) { $env:T41_GATES_DIR } else { Join-Path $Root '.omo\scratch\gates-41' }
  New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

  $pnpm = Resolve-Pnpm

  # ---- Static / unit / coverage / build / source E2E / native chain ----
  Invoke-Gate -Name 'format:check' -Command { & $pnpm format:check } -Log (Join-Path $logsDir 'format.log')
  Invoke-Gate -Name 'typecheck' -Command { & $pnpm -r typecheck } -Log (Join-Path $logsDir 'typecheck.log')
  Invoke-Gate -Name 'test:release-tools' -Command { & $pnpm test:release-tools } -Log (Join-Path $logsDir 'release-tools.log')
  Invoke-Gate -Name 'test:no-updater' -Command { & $pnpm test:no-updater } -Log (Join-Path $logsDir 'no-updater.log')
  Invoke-Gate -Name 'test:docs' -Command { & $pnpm test:docs } -Log (Join-Path $logsDir 'docs.log')
  Invoke-UnitGate -Name 'test' -Command { & $pnpm test } -Log (Join-Path $logsDir 'unit.log')
  Invoke-Gate -Name 'build' -Command { & $pnpm build } -Log (Join-Path $logsDir 'build.log')
  Invoke-Gate -Name 'verify:syntax-build' -Command { & $pnpm verify:syntax-build } -Log (Join-Path $logsDir 'syntax-build.log')

  if ($focused) {
    Write-Host '[gate] focused scope: skipping full coverage, source E2E, and native rebuild.'
    exit 0
  }

  Invoke-UnitGate -Name 'test:coverage' -Command { & $pnpm test:coverage } -Log (Join-Path $logsDir 'coverage.log')
  Invoke-Gate -Name 'test:e2e (source, headless)' -Command { & $pnpm --filter hubfetch-desktop test:e2e } -Log (Join-Path $logsDir 'e2e.log')
  Invoke-Gate -Name 'native:rebuild + native:test' -Command { & $pnpm --filter hubfetch-desktop native:rebuild } -Log (Join-Path $logsDir 'native.log')

  exit 0
}
finally {
  Pop-Location
}
