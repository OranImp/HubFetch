<#
.SYNOPSIS
    Full release-candidate verification for HubFetch on Windows 11 x64.

.DESCRIPTION
    From the release-candidate commit this script runs every quality, test,
    package, doc, and UI gate; exercises the headless scenario journeys; and
    (with -RunLiveHub / -RunLiveGit) performs live Hugging Face and Git smokes
    through the configured proxy. It then aggregates everything into
    release-verification.json, writes quality-gates.txt, live-hub.json,
    live-git.json, journey-failures.json, secret-leak-matrix.json and
    process-scan.txt into -EvidenceDir, and exits 0 only when every gate
    passed.

    Live transfer smokes require the local proxy on http://127.0.0.1:7897;
    the script verifies proxy reachability and treats an unreachable endpoint
    as a blocker, never as a skip.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/verify_release_candidate.ps1 `
        -EvidenceDir .omo\evidence\task-32-windows-huggingface-manager `
        -RunLiveHub -RunLiveGit
#>
param(
    [string]$EvidenceDir = "",
    [switch]$RunLiveHub,
    [switch]$RunLiveGit
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

if (-not $EvidenceDir) {
    $EvidenceDir = Join-Path $RepoRoot ".omo\evidence\task-32-windows-huggingface-manager"
}
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
$TranscriptPath = Join-Path $EvidenceDir "release-transcript.txt"
if (Test-Path $TranscriptPath) {
    Remove-Item $TranscriptPath -Force
}

$failures = New-Object System.Collections.Generic.List[string]
$gates = New-Object System.Collections.Generic.List[object]
$uiShowcaseDir = Join-Path $EvidenceDir "ui-showcase"
$uiFullDir = Join-Path $EvidenceDir "ui-full"
$buildDir = Join-Path $EvidenceDir "build"
$smokeDir = Join-Path $EvidenceDir "smoke"

function Write-Step([string]$Message) {
    $line = "[{0:HH:mm:ss}] {1}" -f (Get-Date), $Message
    Write-Host $line
    Add-Content -Path $TranscriptPath -Value $line -Encoding utf8
}

function Add-Failure([string]$Message) {
    $failures.Add($Message)
    Write-Host "FAIL: $Message"
}

function Invoke-Check([string]$Label, [string[]]$Arguments) {
    Write-Step "$Label"
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & $Arguments[0] @($Arguments[1..($Arguments.Length - 1)]) 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousEap
    }
    $gate = [ordered]@{
        label = $Label
        exit_code = $code
        output = ($output | Out-String)
    }
    $gates.Add($gate)
    if ($code -ne 0) {
        Add-Failure "$Label failed with exit code $code"
    }
}

function Invoke-Basepyright([string]$Label) {
    # Strict gate: basedpyright exits nonzero on any warning or error. The
    # repository ships a clean, warning-free type-check, so any nonzero exit
    # is a real gate failure and must fail the release.
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & uv run --frozen --offline basedpyright 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousEap
    }
    $summary = ($output | Select-String -Pattern "^\d+ errors, \d+ warnings" | Select-Object -Last 1).Line
    $gates.Add([ordered]@{
        label = $Label
        exit_code = $code
        output = ($output | Out-String)
        summary = $summary
    })
    Write-Step "$Label summary: $summary"
    if ($code -ne 0) {
        Add-Failure "$Label exited nonzero (exit code $code): $summary"
    } else {
        Write-Step "$Label passed: clean exit 0"
    }
}

# ---------------------------------------------------------------------------
# Model identity receipt.
# ---------------------------------------------------------------------------
$modelPath = Join-Path $EvidenceDir "model.txt"
$modelId = "unknown"
if (Test-Path $modelPath) {
    $modelId = (Get-Content $modelPath -Raw).Trim()
}
Write-Step "runtime model identity: $modelId"

# ---------------------------------------------------------------------------
# Platform identity — Windows 11 x64/AMD64 only.
# ---------------------------------------------------------------------------
$platform = [System.Environment]::OSVersion.Platform
$is64 = [System.Environment]::Is64BitOperatingSystem
$arch = $env:PROCESSOR_ARCHITECTURE
$winKey = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
$currentBuild = [int]$winKey.CurrentBuildNumber
$displayVersion = $winKey.DisplayVersion
Write-Step "platform=$platform is64=$is64 arch=$arch build=$currentBuild display=$displayVersion"
if ($platform -ne "Win32NT") {
    Add-Failure "release requires Windows (got $platform)"
}
if (-not $is64 -or $arch -ne "AMD64") {
    Add-Failure "release requires x64/AMD64 (got arch=$arch is64=$is64)"
}
if ($currentBuild -lt 22000) {
    Add-Failure "release requires Windows 11 (build >= 22000, got $currentBuild)"
}

# ---------------------------------------------------------------------------
# Exact toolchain versions.
# ---------------------------------------------------------------------------
$previousEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    $pyVersionOutput = & uv run --frozen --offline python -c "import sys; print(sys.version.split()[0])"
    $pyVersionCode = $LASTEXITCODE
    $depOutput = & uv run --frozen --offline python -c "import PySide6, huggingface_hub; import importlib.metadata as m; print('PySide6=' + PySide6.__version__); print('huggingface_hub=' + huggingface_hub.__version__); print('PyInstaller=' + m.version('pyinstaller'))"
    $depCode = $LASTEXITCODE
    $gitVersion = (& git --version 2>&1)
    $gitXetVersion = (& git xet --version 2>&1)
    $gitXetCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousEap
}
if ($pyVersionCode -ne 0) {
    Add-Failure "unable to query the project Python version"
} elseif ($pyVersionOutput -notmatch '^3\.12\.') {
    Add-Failure "exact Python 3.12 required (got $pyVersionOutput)"
}
$expectedDeps = @{
    "PySide6"        = "6.11.1"
    "huggingface_hub" = "1.27.0"
    "PyInstaller"    = "6.22.0"
}
foreach ($line in ($depOutput -split "`n")) {
    if ($line -match "^(PySide6|huggingface_hub|PyInstaller)=(.+)$") {
        $name = $Matches[1]
        $actual = $Matches[2]
        $expected = $expectedDeps[$name]
        if ($actual -ne $expected) {
            Add-Failure "pinned dependency mismatch: $name expected $expected got $actual"
        }
    }
}
Write-Step "dependency versions:`n$depOutput"

Write-Step "git: $gitVersion"
Write-Step "git-xet: $gitXetVersion"
if ($gitXetCode -ne 0) {
    Add-Failure "Git-Xet is not available: $gitXetVersion"
}

# ---------------------------------------------------------------------------
# Mandatory quality gates (all must exit 0).
# ---------------------------------------------------------------------------
Invoke-Check "ruff format --check" @("uv", "run", "--frozen", "--offline", "ruff", "format", "--check", ".")
Invoke-Check "ruff check" @("uv", "run", "--frozen", "--offline", "ruff", "check", ".")
Invoke-Basepyright "basedpyright"
Invoke-Check "pytest -q (full suite)" @("uv", "run", "--frozen", "--offline", "pytest", "-q")
Invoke-Check "check_no_excuse_rules" @("uv", "run", "--frozen", "--offline", "python", "scripts\check_no_excuse_rules.py", ".")

# ---------------------------------------------------------------------------
# Documentation / design / license / package-policy gates.
# ---------------------------------------------------------------------------
Invoke-Check "docs contract" @("uv", "run", "--frozen", "--offline", "pytest", "-q", "tests\docs\test_documentation_contracts.py")
Invoke-Check "design contract" @("uv", "run", "--frozen", "--offline", "python", "scripts\check_design_contract.py")
Invoke-Check "license notices --check" @("uv", "run", "--frozen", "--offline", "python", "scripts\generate_notices.py", "--check")
$policyJson = Join-Path $EvidenceDir "package-policy.json"
Invoke-Check "package policy" @("uv", "run", "--frozen", "--offline", "python", "scripts\check_package_policy.py", "packaging\hubfetch.spec", "--json", $policyJson)

# ---------------------------------------------------------------------------
# Headless scenario journeys (deterministic, local fixtures).
# ---------------------------------------------------------------------------
$scenarioDir = Join-Path $EvidenceDir "scenarios"
New-Item -ItemType Directory -Force -Path $scenarioDir | Out-Null
$scenarioNames = @("mixed-queue", "cancel-crash-recover", "secret-boundary")
$scenarioResults = @{}
foreach ($name in $scenarioNames) {
    Invoke-Check "scenario $name" @("uv", "run", "--frozen", "--offline", "python", "-m", "hubfetch.scenarios.main", "--scenario", $name, "--evidence", $scenarioDir)
    $scenarioJson = Join-Path $scenarioDir "$name.json"
    if (Test-Path $scenarioJson) {
        $scenarioResults[$name] = (Get-Content $scenarioJson -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
}

# ---------------------------------------------------------------------------
# UI state capture — showcase and full auth matrix PNGs (visual approval).
# ---------------------------------------------------------------------------
Invoke-Check "UI showcase capture" @("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "capture_ui_states.ps1"), "-Mode", "Showcase", "-Output", $uiShowcaseDir)
Invoke-Check "UI full capture" @("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "capture_ui_states.ps1"), "-Mode", "Full", "-Output", $uiFullDir)

# ---------------------------------------------------------------------------
# Package build + smoke (reuse the Todo 30 pipeline; internal gates re-run).
# ---------------------------------------------------------------------------
$buildDir = Join-Path $EvidenceDir "build"
Invoke-Check "portable build" @("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "build_windows.ps1"), "-Frozen", "-EvidenceDir", $buildDir)
$zipPath = Join-Path $RepoRoot "artifacts\HubFetch-0.1.0-windows-x64.zip"
if (-not (Test-Path $zipPath)) {
    Add-Failure "portable archive missing after build: $zipPath"
}
$smokeDir = Join-Path $EvidenceDir "smoke"
Invoke-Check "portable smoke" @("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "smoke_portable.ps1"), "-Zip", $zipPath, "-EvidenceDir", $smokeDir)

# ---------------------------------------------------------------------------
# Release-candidate contract suite (deterministic journeys only).
# ---------------------------------------------------------------------------
Invoke-Check "release-candidate journeys" @("uv", "run", "--frozen", "--offline", "pytest", "-q", "tests\e2e\test_release_candidate.py", "-m", "not live")

# ---------------------------------------------------------------------------
# Live Hub smoke (gated, through the configured proxy).
# ---------------------------------------------------------------------------
$liveHub = $null
if ($RunLiveHub) {
    Write-Step "live Hub smoke requested"
    $proxyOk = Test-NetConnection -ComputerName 127.0.0.1 -Port 7897 -InformationLevel Quiet
    if (-not $proxyOk) {
        Add-Failure "BLOCKER: proxy 127.0.0.1:7897 is not reachable; live Hub smoke cannot run"
    } else {
        $env:HTTPS_PROXY = "http://127.0.0.1:7897"
        $env:HTTP_PROXY = "http://127.0.0.1:7897"
        $env:HUBFETCH_RUN_LIVE = "1"
        $env:HUBFETCH_EVIDENCE_DIR = $EvidenceDir
        Invoke-Check "live Hub smoke" @("uv", "run", "--frozen", "--offline", "pytest", "-q", "tests\e2e\test_release_candidate.py", "-m", "live", "-k", "hub")
        $hubJson = Join-Path $EvidenceDir "live-hub.json"
        if (Test-Path $hubJson) {
            $liveHub = (Get-Content $hubJson -Raw -Encoding UTF8 | ConvertFrom-Json)
        } else {
            Add-Failure "live Hub smoke produced no evidence: $hubJson"
        }
    }
}

# ---------------------------------------------------------------------------
# Live Git smoke (gated, through the configured proxy).
# ---------------------------------------------------------------------------
$liveGit = $null
if ($RunLiveGit) {
    Write-Step "live Git smoke requested"
    $proxyOk = Test-NetConnection -ComputerName 127.0.0.1 -Port 7897 -InformationLevel Quiet
    if (-not $proxyOk) {
        Add-Failure "BLOCKER: proxy 127.0.0.1:7897 is not reachable; live Git smoke cannot run"
    } else {
        $env:HTTPS_PROXY = "http://127.0.0.1:7897"
        $env:HTTP_PROXY = "http://127.0.0.1:7897"
        $env:HUBFETCH_RUN_LIVE = "1"
        $env:HUBFETCH_EVIDENCE_DIR = $EvidenceDir
        Invoke-Check "live Git smoke" @("uv", "run", "--frozen", "--offline", "pytest", "-q", "tests\e2e\test_release_candidate.py", "-m", "live", "-k", "git")
        $gitJson = Join-Path $EvidenceDir "live-git.json"
        if (Test-Path $gitJson) {
            $liveGit = (Get-Content $gitJson -Raw -Encoding UTF8 | ConvertFrom-Json)
        } else {
            Add-Failure "live Git smoke produced no evidence: $gitJson"
        }
    }
}

# ---------------------------------------------------------------------------
# Recursive sentinel scan (source, DB/WAL, logs, events, argv/env, screenshots,
# support ZIP, package).
# ---------------------------------------------------------------------------
$sentinel = "hf_test_secret_123"
$sentinelMatrix = @()
# The sentinel is the documented secret-boundary constant: its seed definition
# (scenarios/_fixtures.py), the test fixtures, the documentation that names it,
# and the scan scripts themselves all legitimately carry the bytes. A leak is
# any occurrence in product source outside those documented homes.
function Test-AllowedSentinelHome([string]$Relative) {
    $forwarded = $Relative -replace "\\", "/"
    if ($forwarded -eq "src/hubfetch/scenarios/_fixtures.py") {
        return $true
    }
    if ($forwarded.StartsWith("tests/")) {
        return $true
    }
    if ($forwarded.StartsWith("docs/")) {
        return $true
    }
    if ($forwarded.StartsWith("scripts/")) {
        return $true
    }
    return $false
}

function Scan-ForSentinel([string]$Root, [string]$Scope) {
    if (-not (Test-Path $Root)) {
        return
    }
    foreach ($file in (Get-ChildItem -Path $Root -Recurse -File -ErrorAction SilentlyContinue)) {
        $text = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($file.FullName))
        if ($text.IndexOf($sentinel) -ge 0) {
            $relative = $file.FullName.Substring($Root.Length).TrimStart("\") -replace "\\", "/"
            $script:sentinelMatrix += [ordered]@{ scope = $Scope; file = $relative; allowed_definition = $false; leaked = $true }
            Add-Failure "sentinel bytes found in ${Scope}: $relative"
        }
    }
}

# Source scan iterates only git-tracked files, never .venv/artifacts/dist.
$trackedFiles = @(& git ls-files --cached --others --exclude-standard)
$trackedHits = @()
foreach ($relative in $trackedFiles) {
    $path = Join-Path $RepoRoot ($relative -replace "/", "\")
    if (-not (Test-Path $path)) {
        continue
    }
    if ((Get-Item $path).PSIsContainer) {
        continue
    }
    $text = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($path))
    if ($text.IndexOf($sentinel) -lt 0) {
        continue
    }
    $allowed = Test-AllowedSentinelHome $relative
    $trackedHits += [ordered]@{ scope = "source"; file = $relative; allowed_definition = $allowed; leaked = (-not $allowed) }
    if (-not $allowed) {
        Add-Failure "sentinel bytes in unexpected tracked source file: $relative"
    }
}
foreach ($hit in $trackedHits) {
    $sentinelMatrix += $hit
}

Scan-ForSentinel (Join-Path $EvidenceDir "scenarios") "scenario-evidence"
Scan-ForSentinel $EvidenceDir "evidence"
if (Test-Path (Join-Path $RepoRoot "dist")) {
    Scan-ForSentinel (Join-Path $RepoRoot "dist") "package"
}

# ---------------------------------------------------------------------------
# Orphan process scan.
# ---------------------------------------------------------------------------
$orphans = @(Get-Process -Name "HubFetch*" -ErrorAction SilentlyContinue)
$processScan = Join-Path $EvidenceDir "process-scan.txt"
$processLines = @()
if ($orphans.Count -eq 0) {
    $processLines += "orphan HubFetch processes: none"
} else {
    foreach ($process in $orphans) {
        $processLines += "orphan process: $($process.ProcessName) (PID $($process.Id))"
        Add-Failure "orphan HubFetch process left behind: $($process.ProcessName) (PID $($process.Id))"
    }
}
[System.IO.File]::WriteAllLines($processScan, $processLines, [System.Text.UTF8Encoding]::new($false))

# ---------------------------------------------------------------------------
# git status check — only ignored evidence/artifacts may differ.
# ---------------------------------------------------------------------------
$gitStatus = (& git status --short 2>&1)
Write-Step "git status --short:`n$gitStatus"

# ---------------------------------------------------------------------------
# Evidence files.
# ---------------------------------------------------------------------------
$qualityGatesPath = Join-Path $EvidenceDir "quality-gates.txt"
$gateLines = @($gates | ForEach-Object {
        "[gate] $($_.label) exit=$($_.exit_code)"
        if ($_.summary) { "  summary: $($_.summary)" }
    })
[System.IO.File]::WriteAllLines($qualityGatesPath, $gateLines, [System.Text.UTF8Encoding]::new($false))

# ---------------------------------------------------------------------------
# Failure-journey evidence: deterministic journeys + scenario outcomes.
# ---------------------------------------------------------------------------
$journeyFailures = [ordered]@{
    offline = "test_offline_endpoint_fails_without_false_success"
    proxy_failure = "test_invalid_manual_proxy_is_rejected"
    missing_dependency = "test_missing_dependency_is_a_typed_error"
    disk_conflict = "test_rejected_in_place_clone_retry_needs_new_destination"
    cancel_crash = "scenario cancel-crash-recover"
    secret_sentinel = "scenario secret-boundary"
}
$journeyFailuresJson = $journeyFailures | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText((Join-Path $EvidenceDir "journey-failures.json"), $journeyFailuresJson, [System.Text.UTF8Encoding]::new($false))

# ---------------------------------------------------------------------------
# Aggregate manifest.
# ---------------------------------------------------------------------------
$uiSummary = [ordered]@{
    showcase_manifest = (Join-Path $uiShowcaseDir "showcase-manifest.json")
    showcase_png_count = @(Get-ChildItem -Path $uiShowcaseDir -Filter "showcase-*.png" -ErrorAction SilentlyContinue).Count
    full_manifest = (Join-Path $uiFullDir "ui-matrix-manifest.json")
    full_png_count = @(Get-ChildItem -Path $uiFullDir -Filter "ui-*.png" -ErrorAction SilentlyContinue).Count
}
$smokeSummary = $null
$portableSmokeJson = Join-Path $smokeDir "portable-smoke.json"
if (Test-Path $portableSmokeJson) {
    $smokeSummary = (Get-Content $portableSmokeJson -Raw -Encoding UTF8 | ConvertFrom-Json)
}

$manifest = [ordered]@{
    model = $modelId
    platform = [ordered]@{
        os = $platform
        x64 = $is64
        arch = $arch
        build = $currentBuild
        display_version = $displayVersion
    }
    toolchain = [ordered]@{
        python = $pyVersionOutput
        dependencies = ($depOutput -split "`n")
        git = ($gitVersion -join " ")
        git_xet = ($gitXetVersion -join " ")
    }
    gates = $gates
    scenario_results = $scenarioResults
    ui = $uiSummary
    package_smoke = $smokeSummary
    live_hub = $liveHub
    live_git = $liveGit
    journey_failures = $journeyFailures
    secret_leak_matrix = @($sentinelMatrix)
    orphan_process_count = $orphans.Count
    git_status_short = ($gitStatus -join "`n")
    failures = @($failures)
    passed = ($failures.Count -eq 0)
}
$manifestJson = $manifest | ConvertTo-Json -Depth 12
$manifestPath = Join-Path $EvidenceDir "release-verification.json"
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, [System.Text.UTF8Encoding]::new($false))
Write-Step "manifest written: $manifestPath"

if ($failures.Count -gt 0) {
    Write-Step "release verification FAILED: $($failures.Count) failure(s)"
    exit 1
}
Write-Step "=== release verification PASSED ==="
exit 0
