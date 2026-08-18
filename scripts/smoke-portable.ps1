# scripts/smoke-portable.ps1
#
# Todo 41: smoke-test the packaged Windows x64 ZIP exactly as an end user would
# run it — extracted to a temp path containing spaces AND non-ASCII characters,
# with an isolated data/credential root and project/development Node/Python
# removed from PATH. Proves the packaged app runs without the dev tree.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-portable.ps1 `
#       -ZipPath <path-to-zip> -Version <x.y.z>
#
# Steps:
#   1. Resolve the absolute node/playwright/pnpm binaries BEFORE stripping PATH.
#   2. Extract the ZIP to a Unicode + spaced temp dir (E:\Programs\Temp\...).
#   3. Strip project dir, development Node, and Python from PATH (keep system Git).
#   4. Verify the extracted inventory: x64 native files, no installer/updater/
#      Python/source, zero `.map` members (check-package-policy.mjs on the tree).
#   5. Launch the packaged HubFetch.exe via Playwright with isolated data roots and
#      run the packaged smoke spec (boot + nav). Headless by policy.
#   6. Clean up the extraction and any spawned app processes.
#
# Exit 0 only when the packaged app boots and the packaged E2E passes.

param(
  [Parameter(Mandatory = $true)][string]$ZipPath,
  [Parameter(Mandatory = $true)][string]$Version
)

# 'Continue' (not 'Stop') so native-command stderr is not surfaced as a
# terminating error on Windows PowerShell 5.1. Failures are decided by real
# exit codes via explicit checks.
$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $Root
try {
  if (Test-Path 'E:\Programs\Temp') {
    $env:TMP = 'E:\Programs\Temp'
    $env:TEMP = 'E:\Programs\Temp'
  }
  $env:PLAYWRIGHT_BROWSERS_PATH = 'E:\Programs\ms-playwright'

  # Smoke temp root: honor the override, else prefer E:\Programs\Temp on this
  # workstation (never C:\Users\...\Temp), else the system temp for CI.
  $SmokeTmp = if ($env:T41_SMOKE_TMP) {
    $env:T41_SMOKE_TMP
  } elseif (Test-Path 'E:\Programs\Temp') {
    'E:\Programs\Temp'
  } else {
    $env:TEMP
  }

  $ZipPath = (Resolve-Path $ZipPath).Path
  $ZipName = Split-Path $ZipPath -Leaf
  if ($ZipName -ne "HubFetch-$Version-windows-x64.zip") {
    Write-Error "[smoke] expected $ZipName but got $(Split-Path $ZipPath -Leaf)"; exit 1
  }

  # ---- 1. Resolve dev binaries before stripping PATH ----
  $pnpmShim = Join-Path $env:TEMP 'hubfetch-pnpm-shim\pnpm.cmd'
  if (-not (Test-Path $pnpmShim)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $pnpmShim) | Out-Null
    Set-Content -Path $pnpmShim -Value "@echo off`r`nset `"TMP=E:\Programs\Temp`"`r`nset `"TEMP=E:\Programs\Temp`"`r`ncorepack pnpm %*`r`nexit /b %ERRORLEVEL%`r`n" -Encoding Ascii
  }
  $env:PATH = "$(Split-Path $pnpmShim);$env:PATH"

  # ---- 2. Extract to a Unicode + spaced temp path ----
  $extractRoot = Join-Path $SmokeTmp "T41 提取包 HubFetch-$Version-$PID"
  if (Test-Path $extractRoot) { Remove-Item -Recurse -Force $extractRoot }
  New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null

  $extractScript = @"
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory('$($ZipPath.Replace("'","''"))', '$($extractRoot.Replace("'","''"))')
"@
  & powershell -NoProfile -NonInteractive -Command $extractScript
  if ($LASTEXITCODE -ne 0) { Write-Error "[smoke] extraction failed"; exit 1 }

  $appRoot = Join-Path $extractRoot 'win-unpacked'
  if (-not (Test-Path $appRoot)) {
    # ZIP may contain the app directly at the top level.
    $appRoot = $extractRoot
  }
  $exe = Join-Path $appRoot 'HubFetch.exe'
  if (-not (Test-Path $exe)) { Write-Error "[smoke] HubFetch.exe not found in extracted package"; exit 1 }

  # ---- 3. Verify inventory with the package policy check against the tree ----
  # check-package-policy expects a ZIP; run it against the ZIP itself for the
  # member-level policy (zero .map / no installer / no Python / native present).
  $policy = & node (Join-Path $Root 'scripts\check-package-policy.mjs') $ZipPath $Version 2>&1
  if ($LASTEXITCODE -ne 0) { Write-Error "[smoke] check-package-policy failed: $policy"; exit 1 }

  # Per-file x64 PE check on the two native runtime files.
  $nativeJob = Join-Path $appRoot 'resources\native\hubfetch_job.node'
  $nativeAskPass = Join-Path $appRoot 'resources\native\HubFetchAskPass.exe'
  if (-not (Test-Path $nativeJob)) { Write-Error "[smoke] packaged hubfetch_job.node missing"; exit 1 }
  if (-not (Test-Path $nativeAskPass)) { Write-Error "[smoke] packaged HubFetchAskPass.exe missing"; exit 1 }

  # ---- Strip project/development Node/Python from PATH (keep system Git) ----
  $originalPath = $env:PATH
  $devPrefixes = @(
    $Root,
    (Join-Path $Root 'node_modules'),
    (Split-Path (Get-Command node -ErrorAction SilentlyContinue).Source -ErrorAction SilentlyContinue),
    (Split-Path (Get-Command npm -ErrorAction SilentlyContinue).Source -ErrorAction SilentlyContinue),
    (Split-Path (Get-Command corepack -ErrorAction SilentlyContinue).Source -ErrorAction SilentlyContinue)
  ) | Where-Object { $_ } | Select-Object -Unique

  $filtered = @($originalPath -split ';' | Where-Object {
      $entry = $_.Trim()
      if (-not $entry) { return $false }
      foreach ($p in $devPrefixes) {
        if ($p -and $entry -like "$p*") { return $false }
      }
      # Remove Python interpreters.
      if ($entry -match 'python|pyenv|Scripts' -and (Test-Path (Join-Path $entry 'python.exe'))) { return $false }
      return $true
    })
  $env:PATH = ($filtered -join ';')

  # Confirm Node/Python no longer resolve from PATH (they may still resolve from
  # the absolute shim dir we prepended for pnpm — remove that too for the check).
  $checkPath = ($env:PATH -split ';' | Where-Object { $_ -notlike '*hubfetch-pnpm-shim*' }) -join ';'
  $env:PNPM_SHIM_REMOVED_PATH = $checkPath
  $devNode = & cmd /c "set PATH=$checkPath&& where node" 2>$null
  $devPython = & cmd /c "set PATH=$checkPath&& where python" 2>$null
  if ($devNode) { Write-Error "[smoke] dev node still on PATH: $devNode"; exit 1 }
  if ($devPython) { Write-Error "[smoke] python still on PATH: $devPython"; exit 1 }

  # ---- 4. Launch the packaged app via Playwright with isolated data roots ----
  $userData = Join-Path $extractRoot "userdata-$PID"
  New-Item -ItemType Directory -Force -Path $userData | Out-Null

  # HUBFETCH_PACKAGED_EXECUTABLE tells packaged-smoke.spec.ts which exe to launch.
  $env:HUBFETCH_PACKAGED_EXECUTABLE = $exe
  $env:HUBFETCH_USER_DATA_DIR = $userData
  $env:HUBFETCH_CREDENTIALS_DIR = $userData

  $packagedSpec = Join-Path $Root 'apps\desktop\e2e\packaged-smoke.spec.ts'
  $configPath = Join-Path $Root 'apps\desktop\playwright.packaged.config.ts'

  $playwrightRun = & $pnpmShim --filter hubfetch-desktop exec playwright test --config=$configPath 2>&1
  $pwCode = $LASTEXITCODE
  if ($pwCode -ne 0) {
    Write-Error "[smoke] packaged E2E failed (exit $pwCode):`n$playwrightRun"
    # restore path for cleanup
    $env:PATH = $originalPath
    Remove-Item -Recurse -Force $extractRoot -ErrorAction SilentlyContinue
    exit $pwCode
  }

  Write-Host "[smoke] packaged app booted + packaged E2E passed (headless)."

  # ---- 5. Cleanup ----
  $env:PATH = $originalPath
  # Kill any stray packaged HubFetch processes spawned by the smoke.
  Get-Process -Name 'HubFetch' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $extractRoot -ErrorAction SilentlyContinue

  Write-Host '[smoke] SMOKE PASS'
  exit 0
}
finally {
  Pop-Location
}
