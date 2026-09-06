# scripts/build-windows.ps1
#
# Todo 41: build the exact-commit Windows x64 ZIP and bind it to source
# evidence. This is the master release-build entry point that the workflow and
# a clean local release both invoke. It enforces every precondition before any
# ZIP is produced and never mutates tracked source.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows.ps1
#
# Env overrides:
#   T41_SOURCE_SHA   - the exact commit to build (default: current HEAD)
#   T41_VERSION      - release version (default: read from root package.json)
#   T41_LIVE_READ    - path to Todo 37 live-read.json (default: the task-37 evidence file)
#   T41_SKIP_GATES   - "1" to skip the full quality gate chain (used only for
#                      the two-build determinism probe where the source is known
#                      unchanged and gates already passed); "0" = run gates.
#
# Steps:
#   1. Preconditions: Windows 11 x64, clean tracked tree, exact Node/pnpm, frozen
#      lock, proxy gate.
#   2. Frozen install (pnpm install --frozen-lockfile).
#   3. Notices check + full quality gate chain (run-quality-gates.ps1) which
#      includes native clean rebuild + native tests.
#   4. Package the unsigned Windows x64 ZIP (electron-builder --win --x64), with
#      bounded retries for the known flaky pnpm node-modules collector.
#   5. Copy the ZIP and SBOM to artifacts/release/, run check-package-policy.mjs, stage the
#      manifest (approved=false), then run smoke-portable.ps1.
#   6. Only after smoke succeeds, finalize the manifest (approved=true).

# 'Continue' (not 'Stop') so native-command stderr is not surfaced as a
# terminating error on Windows PowerShell 5.1. Failures are decided by real
# exit codes via the Fail() helper and the explicit Start-Process checks.
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
  $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'

  $Version = if ($env:T41_VERSION) { $env:T41_VERSION } else { (Get-Content package.json -Raw | ConvertFrom-Json).version }
  $SourceSha = if ($env:T41_SOURCE_SHA) { $env:T41_SOURCE_SHA } else { (git rev-parse HEAD).Trim() }
  $ZipName = "HubFetch-$Version-windows-x64.zip"
  $ArtifactsDir = Join-Path $Root 'artifacts'
  $ReleaseArtifactsDir = Join-Path $ArtifactsDir 'release'
  New-Item -ItemType Directory -Force -Path $ArtifactsDir | Out-Null
  if (Test-Path $ReleaseArtifactsDir) { Remove-Item -Recurse -Force $ReleaseArtifactsDir }
  New-Item -ItemType Directory -Force -Path $ReleaseArtifactsDir | Out-Null
  $LiveRead = if ($env:T41_LIVE_READ) { $env:T41_LIVE_READ } else {
    Join-Path $Root '.omo\evidence\task-37-adopt-ohmyhf-main\live-read.json'
  }

  function Fail([string]$msg) { Write-Error "[build-windows] $msg"; exit 1 }

  # ---- 1. Preconditions ----

  # Windows 11 x64 (build >= 22000, AMD64).
  $os = Get-CimInstance Win32_OperatingSystem
  $osCaption = $os.Caption
  $osBuild = [int]$os.BuildNumber
  if ($env:PROCESSOR_ARCHITECTURE -notin @('AMD64', 'x86_64')) { Fail "requires x64 (got $env:PROCESSOR_ARCHITECTURE)" }
  if ($osBuild -lt 22000) { Fail "requires Windows 11 (build >= 22000, got $osBuild)" }
  if ($osCaption -notmatch 'Windows 11') {
    Write-Host "[build-windows] NOTE: OS caption '$osCaption' (build $osBuild) does not literally match 'Windows 11'; continuing on x64 build $osBuild >= 22000."
  }

  # Clean tracked tree.
  $trackedStatus = (@(git status --porcelain --untracked-files=no) -join "`n").Trim()
  if ($trackedStatus) { Fail "tracked working tree is dirty:`n$trackedStatus" }

  # Exact Node version (toolchain.json + package.json engines).
  $nodeVersion = (node --version).Trim()   # v24.16.0
  $toolchainPath = Join-Path $Root '.omo\evidence\task-1-adopt-ohmyhf-main\toolchain.json'
  if (Test-Path $toolchainPath) {
    $toolchain = Get-Content $toolchainPath -Raw | ConvertFrom-Json
    $expectedNode = $toolchain.runtime.node   # e.g. v24.16.0
    if ($nodeVersion -ne $expectedNode) { Fail "Node mismatch: have $nodeVersion, expected $expectedNode (toolchain.json)" }
  } else {
    Write-Host "[build-windows] NOTE: toolchain.json not found at $toolchainPath; skipping exact-version pin."
  }
  # Node engine >=22 (package.json engines).
  $engines = (Get-Content package.json -Raw | ConvertFrom-Json).engines.node
  $nodeMajor = [int]($nodeVersion -replace '^v(\d+)\..*', '$1')
  if ($nodeMajor -lt 22) { Fail "Node engine requires >=22 (have $nodeVersion)" }

  # Exact pnpm version (packageManager pnpm@11.10.0).
  $pm = (Get-Content package.json -Raw | ConvertFrom-Json).packageManager   # pnpm@11.10.0
  $expectedPnpm = $pm -replace '^pnpm@', ''
  $pnpmVersion = (corepack pnpm --version).Trim()
  if ($pnpmVersion -ne $expectedPnpm) { Fail "pnpm mismatch: have $pnpmVersion, expected $expectedPnpm (packageManager)" }

  # Frozen lock: pnpm-lock.yaml must be tracked and unchanged from HEAD.
  if (-not (Test-Path 'pnpm-lock.yaml')) { Fail 'pnpm-lock.yaml missing' }
  $lockStatus = (@(git status --porcelain -- pnpm-lock.yaml) -join "`n").Trim()
  if ($lockStatus) { Fail "pnpm-lock.yaml has uncommitted changes" }

  # Proxy gate: every overseas-reaching command in this build uses the mandated proxy.
  $env:HTTP_PROXY = 'http://127.0.0.1:7897'
  $env:HTTPS_PROXY = 'http://127.0.0.1:7897'
  $env:ALL_PROXY = 'http://127.0.0.1:7897'
  $env:NO_PROXY = 'localhost,127.0.0.1,::1'
  $env:npm_config_proxy = 'http://127.0.0.1:7897'
  $env:npm_config_https_proxy = 'http://127.0.0.1:7897'

  # Resolve a pnpm shim on PATH (pnpm is not on PATH in this environment). The
  # shim calls `corepack` by its ABSOLUTE path so it keeps working even after
  # smoke-portable.ps1 strips the dev Node/corepack directories from PATH.
  $shimDir = Join-Path $env:TEMP 'hubfetch-pnpm-shim'
  New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
  $shim = Join-Path $shimDir 'pnpm.cmd'
  $corepackCmd = (Get-Command corepack -ErrorAction SilentlyContinue).Source
  if (-not $corepackCmd) { $corepackCmd = 'corepack' }
  if (-not (Test-Path $shim)) {
    Set-Content -Path $shim -Value "@echo off`r`nset `"TMP=E:\Programs\Temp`"`r`nset `"TEMP=E:\Programs\Temp`"`r`n`"$corepackCmd`" pnpm %*`r`nexit /b %ERRORLEVEL%`r`n" -Encoding Ascii
  }
  $env:PATH = "$shimDir;$env:PATH"

  function Invoke-Checked {
    param([string]$Name, [string[]]$Command, [string]$Log)
    Write-Host "[build-windows] $Name ..."
    $p = Start-Process -FilePath $Command[0] -ArgumentList $Command[1..($Command.Length - 1)] `
      -NoNewWindow -Wait -PassThru -RedirectStandardOutput $Log -RedirectStandardError "$Log.err"
    if ($p.ExitCode -ne 0) { Fail "$Name failed (exit $($p.ExitCode)); see $Log" }
    Write-Host "[build-windows] OK: $Name"
  }

  # Run a subprocess that may spawn Electron (quality gates / packaged smoke)
  # and capture its real exit code without the Windows PowerShell 5.1
  # `Start-Process -Wait` pipe-hang: that variant blocks until EVERY handle
  # holder of the redirected file closes, so an orphaned native-test/packaged
  # Electron child can stall the build forever. `&` + `*>` instead waits for the
  # child to EXIT and records $LASTEXITCODE, then we reap any stray
  # Electron/HubFetch processes so they cannot hold locks in later steps.
  # Re-write a ZIP with every entry timestamp pinned to a fixed DOS epoch so
  # that two clean builds of the same source produce BYTE-IDENTICAL ZIPs.
  # electron-builder stamps per-build file mtimes into the archive, which would
  # otherwise make the ZIP SHA-256 differ between otherwise-equal builds. This
  # normalization is the plan's "normalize/assert the permitted nondeterministic
  # field" step: the ZIP entry modification timestamp is listed in the manifest
  # as normalized to 1980-01-01T00:00:00Z.
  function Normalize-ZipTimestamps {
    param([string]$Src, [string]$Dst)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $fixed = [datetime]'1980-01-01T00:00:00'
    $srcZip = [System.IO.Compression.ZipFile]::OpenRead($Src)
    $outFs = [System.IO.File]::Create($Dst)
    $dstZip = New-Object System.IO.Compression.ZipArchive($outFs, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
      foreach ($e in $srcZip.Entries) {
        $d = $dstZip.CreateEntry($e.FullName)
        $d.LastWriteTime = $fixed
        $in = $e.Open()
        $out = $d.Open()
        try { $in.CopyTo($out) } finally { $out.Dispose(); $in.Dispose() }
      }
    } finally {
      $dstZip.Dispose(); $outFs.Dispose(); $srcZip.Dispose()
    }
  }

  function Invoke-OrphanSafe {
    param([string]$Name, [string[]]$Command, [string]$Log)
    Write-Host "[build-windows] $Name ..."
    & $Command[0] $Command[1..($Command.Length - 1)] *> $Log
    $code = $LASTEXITCODE
    # Reap stray Electron/HubFetch processes the subprocess may have orphaned.
    Get-Process -Name 'electron', 'HubFetch' -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -like "$Root*" } |
      Stop-Process -Force -ErrorAction SilentlyContinue
    if ($code -ne 0) { Fail "$Name failed (exit $code); see $Log" }
    Write-Host "[build-windows] OK: $Name"
  }

  # ---- 2. Frozen install ----
  Invoke-Checked -Name 'pnpm install --frozen-lockfile' -Command @('pnpm', 'install', '--frozen-lockfile') `
    -Log (Join-Path $ArtifactsDir 'install.log')

  Invoke-Checked -Name 'CycloneDX release SBOM' -Command @('pnpm', 'release:sbom') `
    -Log (Join-Path $ArtifactsDir 'sbom.log')

  # ---- 3. Notices + full quality gate chain (includes native rebuild + tests) ----
  Invoke-Checked -Name 'notices policy test' -Command @('pnpm', 'test:docs') -Log (Join-Path $ArtifactsDir 'docs.log')

  if ($env:T41_SKIP_GATES -ne '1') {
    Invoke-OrphanSafe -Name 'quality gate chain' `
      -Command @('powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root 'scripts\run-quality-gates.ps1')) `
      -Log (Join-Path $ArtifactsDir 'gates.log')
    Write-Host '[build-windows] OK: full quality gate chain (static/unit/coverage/build/source E2E/native)'
  } else {
    Write-Host '[build-windows] T41_SKIP_GATES=1: skipping full gate chain (determinism probe).'
  }

  # ---- 4. Package the unsigned Windows x64 ZIP (with bounded retry) ----
  $desktopDir = Join-Path $Root 'apps\desktop'
  $releaseDir = Join-Path $desktopDir 'release'
  if (Test-Path $releaseDir) { Remove-Item -Recurse -Force $releaseDir }
  New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

  $packed = $false
  for ($attempt = 1; $attempt -le 3; $attempt += 1) {
    Write-Host "[build-windows] electron-builder attempt $attempt/3 ..."
    # Clean any stale build artifacts first for determinism, then rebuild the
    # electron-vite output (`out/**` is what electron-builder.yml packages) so
    # the packaged app.asar contains the freshly compiled entry point.
    if (Test-Path (Join-Path $desktopDir 'out')) { Remove-Item -Recurse -Force (Join-Path $desktopDir 'out') }
    $build = Start-Process -FilePath 'pnpm' `
      -ArgumentList @('--filter', 'hubfetch-desktop', 'exec', 'electron-vite', 'build') `
      -WorkingDirectory $Root -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput (Join-Path $ArtifactsDir "evite-$attempt.log") `
      -RedirectStandardError (Join-Path $ArtifactsDir "evite-$attempt.log.err")
    if ($build.ExitCode -ne 0) {
      Write-Host "[build-windows] electron-vite build attempt $attempt failed (exit $($build.ExitCode)); retrying."
      continue
    }
    $p = Start-Process -FilePath 'pnpm' `
      -ArgumentList @('--filter', 'hubfetch-desktop', 'exec', 'electron-builder', '--win', '--x64', '--publish', 'never') `
      -WorkingDirectory $Root -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput (Join-Path $ArtifactsDir "builder-$attempt.log") `
      -RedirectStandardError (Join-Path $ArtifactsDir "builder-$attempt.log.err")
    if ($p.ExitCode -eq 0) { $packed = $true; break }
    Write-Host "[build-windows] electron-builder attempt $attempt failed (exit $($p.ExitCode)); retrying."
  }
  if (-not $packed) { Fail 'electron-builder failed after 3 attempts' }

  $builtZip = Join-Path $releaseDir $ZipName
  if (-not (Test-Path $builtZip)) { Fail "expected built ZIP not found: $builtZip" }

  # ---- 5. Copy to artifacts + policy check + stage manifest + smoke ----
  $targetZip = Join-Path $ReleaseArtifactsDir $ZipName
  Copy-Item -Force $builtZip $targetZip

  # Deterministic re-zip: normalize ZIP entry timestamps so the artifact in
  # artifacts/ (and thus the manifest SHA) is reproducible across clean builds.
  $normalizedZip = Join-Path $ArtifactsDir "$ZipName.deterministic"
  Normalize-ZipTimestamps -Src $targetZip -Dst $normalizedZip
  Move-Item -Force $normalizedZip $targetZip
  Write-Host "[build-windows] OK: normalized ZIP entry timestamps (deterministic re-zip)"

  $policy = Start-Process -FilePath 'node' `
    -ArgumentList @('scripts\check-package-policy.mjs', $targetZip, $Version) `
    -WorkingDirectory $Root -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput (Join-Path $ArtifactsDir 'policy.log') `
    -RedirectStandardError (Join-Path $ArtifactsDir 'policy.log.err')
  if ($policy.ExitCode -ne 0) { Fail 'check-package-policy.mjs failed' }

  # Stage manifest (approved=false) before smoke.
  $manifestStage = Start-Process -FilePath 'node' `
    -ArgumentList @('scripts\release-manifest.mjs', $ReleaseArtifactsDir, $ZipName, $SourceSha, $Version, '--live-read', $LiveRead) `
    -WorkingDirectory $Root -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput (Join-Path $ArtifactsDir 'manifest-stage.log') `
    -RedirectStandardError (Join-Path $ArtifactsDir 'manifest-stage.log.err')
  if ($manifestStage.ExitCode -ne 0) { Fail 'release-manifest.mjs (stage) failed' }

  # Smoke (extract to Unicode/spaced temp, isolate data, launch packaged app, E2E).
  Invoke-OrphanSafe -Name 'packaged smoke' `
    -Command @('powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root 'scripts\smoke-portable.ps1'), '-ZipPath', $targetZip, '-Version', $Version) `
    -Log (Join-Path $ArtifactsDir 'smoke.log')
  Write-Host '[build-windows] OK: packaged smoke'

  # ---- 6. Finalize manifest (approved=true) only after smoke succeeded ----
  $manifestFinal = Start-Process -FilePath 'node' `
    -ArgumentList @('scripts\release-manifest.mjs', $ReleaseArtifactsDir, $ZipName, $SourceSha, $Version, '--live-read', $LiveRead, '--finalize') `
    -WorkingDirectory $Root -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput (Join-Path $ArtifactsDir 'manifest-final.log') `
    -RedirectStandardError (Join-Path $ArtifactsDir 'manifest-final.log.err')
  if ($manifestFinal.ExitCode -ne 0) { Fail 'release-manifest.mjs (finalize) failed' }

  Write-Host "[build-windows] RELEASE BUILD OK: $ZipName sha256=$(node -e "const fs=require('fs');const c=require('crypto');console.log(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" $targetZip)"
  exit 0
}
finally {
  Pop-Location
}
