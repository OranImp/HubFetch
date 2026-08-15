# Clean Windows x64 build pipeline for the portable HubFetch archive.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\build_windows.ps1 `
#       -Frozen -EvidenceDir <dir>
#
# The pipeline asserts Windows 11 x64/AMD64, the exact Python 3.12 and pinned
# dependency versions, a clean frozen lock, and every mandatory quality gate;
# then it compiles translations, regenerates and verifies license notices,
# runs the Todo 29 package policy, invokes PyInstaller 6.22.0 with
# packaging\hubfetch.spec, and archives the complete dist\HubFetch tree as
# artifacts\HubFetch-<version>-windows-x64.zip with a deterministic relative
# layout (entries prefixed by the top-level HubFetch directory).
#
# -Frozen requires the venv to match the committed uv.lock (uv sync --frozen)
# before any gate runs. Every step is appended to build.txt in -EvidenceDir so
# the transcript survives an early failure.

param(
    [switch]$Frozen,
    [string]$EvidenceDir = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

if (-not $EvidenceDir) {
    $EvidenceDir = Join-Path $RepoRoot ".omo\evidence\task-30-windows-huggingface-manager"
}
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
$TranscriptPath = Join-Path $EvidenceDir "build.txt"
if (Test-Path $TranscriptPath) {
    Remove-Item $TranscriptPath -Force
}

function Write-Step([string]$Message) {
    $line = "[{0:HH:mm:ss}] {1}" -f (Get-Date), $Message
    Write-Host $line
    Add-Content -Path $TranscriptPath -Value $line -Encoding utf8
}

function Invoke-Check([string]$Label, [string[]]$Arguments) {
    Write-Step "$Label"
    & $Arguments[0] @($Arguments[1..($Arguments.Length - 1)])
    $code = $LASTEXITCODE
    Write-Step "$Label exit code: $code"
    if ($code -ne 0) {
        throw "$Label failed with exit code $code"
    }
}

function Invoke-PythonCheck([string]$Label, [string]$Script) {
    Invoke-Check $Label @("uv", "run", "--frozen", "--offline", "python", $Script)
}

function Invoke-Basepyright([string]$Label) {
    # basedpyright 1.39.x exits nonzero when the project's pre-existing warning
    # set is present even with zero errors; the repository's accepted gate is
    # "0 errors" (the type rules themselves are unchanged). Any error is fatal.
    $output = & uv run --frozen --offline basedpyright 2>&1
    $code = $LASTEXITCODE
    $summary = ($output | Select-String -Pattern "^\d+ errors, \d+ warnings" | Select-Object -Last 1).Line
    Write-Step "$Label`n$($output | Out-String)"
    Write-Step "$Label summary: $summary"
    if ($summary -notmatch "^0 errors,") {
        throw "$Label reported type errors: $summary (exit code $code)"
    }
    Write-Step "$Label accepted: 0 type errors (exit code $code; pre-existing warnings present)"
}

# ---------------------------------------------------------------------------
# Platform identity — Windows 11 x64/AMD64 only.
# ---------------------------------------------------------------------------
Write-Step "=== HubFetch portable build (Windows x64) ==="
$platform = [System.Environment]::OSVersion.Platform
$is64 = [System.Environment]::Is64BitOperatingSystem
$arch = $env:PROCESSOR_ARCHITECTURE
$winKey = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
$currentBuild = [int]$winKey.CurrentBuildNumber
$displayVersion = $winKey.DisplayVersion
Write-Step "platform=$platform is64=$is64 arch=$arch build=$currentBuild display=$displayVersion"
if ($platform -ne "Win32NT") {
    throw "HubFetch packaging requires Windows (got $platform)"
}
if (-not $is64 -or $arch -ne "AMD64") {
    throw "HubFetch packaging requires x64/AMD64 (got arch=$arch is64=$is64)"
}
if ($currentBuild -lt 22000) {
    throw "HubFetch packaging requires Windows 11 (build >= 22000, got $currentBuild)"
}

# ---------------------------------------------------------------------------
# Exact toolchain versions — Python 3.12 plus the pinned dependency set.
# ---------------------------------------------------------------------------
$pyVersionOutput = & uv run --frozen --offline python -c "import sys; print(sys.version.split()[0])"
if ($LASTEXITCODE -ne 0) {
    throw "unable to query the project Python version"
}
Write-Step "python version: $pyVersionOutput"
if ($pyVersionOutput -notmatch '^3\.12\.') {
    throw "exact Python 3.12 required (got $pyVersionOutput)"
}

$depOutput = & uv run --frozen --offline python -c "import PySide6, huggingface_hub; import importlib.metadata as m; print('PySide6=' + PySide6.__version__); print('huggingface_hub=' + huggingface_hub.__version__); print('PyInstaller=' + m.version('pyinstaller'))"
if ($LASTEXITCODE -ne 0) {
    throw "unable to query pinned dependency versions"
}
Write-Step "dependency versions:`n$depOutput"
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
            throw "pinned dependency mismatch: $name expected $expected got $actual"
        }
    }
}

# ---------------------------------------------------------------------------
# Clean frozen lock.
# ---------------------------------------------------------------------------
Invoke-Check "uv lock --check" @("uv", "lock", "--check")

# ---------------------------------------------------------------------------
# Mandatory quality gates (all must exit 0 before packaging).
# ---------------------------------------------------------------------------
if ($Frozen) {
    Invoke-Check "uv sync --frozen" @("uv", "sync", "--frozen")
}
Invoke-Check "ruff format --check" @("uv", "run", "--frozen", "--offline", "ruff", "format", "--check", ".")
Invoke-Check "ruff check" @("uv", "run", "--frozen", "--offline", "ruff", "check", ".")
Invoke-Basepyright "basedpyright"
Invoke-Check "pytest" @("uv", "run", "--frozen", "--offline", "pytest", "-q")
Invoke-PythonCheck "check_no_excuse_rules" "scripts\check_no_excuse_rules.py"

# ---------------------------------------------------------------------------
# Translations — compile both catalogs with the venv's pyside6-lrelease
# (scripts\compile_translations.ps1 has a pre-existing PATH-detection bug when
# pyside6-lrelease is not already on PATH; the build resolves the venv copy
# directly so it is self-contained). The .qm outputs are gitignored.
# ---------------------------------------------------------------------------
$lrelease = Join-Path $RepoRoot ".venv\Scripts\pyside6-lrelease.exe"
if (-not (Test-Path $lrelease)) {
    throw "pyside6-lrelease not found in the project venv: $lrelease"
}
foreach ($catalog in @("hubfetch_zh_CN.ts", "hubfetch_en_US.ts")) {
    $source = Join-Path $RepoRoot ("resources\i18n\" + $catalog)
    $qmName = [System.IO.Path]::GetFileNameWithoutExtension($catalog) + ".qm"
    $target = Join-Path $RepoRoot ("resources\i18n\" + $qmName)
    Write-Step "lrelease $catalog -> $qmName"
    & $lrelease -silent $source -qm $target
    if ($LASTEXITCODE -ne 0) {
        throw "lrelease failed for $catalog with exit code $LASTEXITCODE"
    }
    if (-not (Test-Path $target)) {
        throw "lrelease produced no output for ${catalog}: $target"
    }
}

# ---------------------------------------------------------------------------
# License notices — verify the committed notice, regenerate into evidence.
# ---------------------------------------------------------------------------
Invoke-Check "generate notices --check" @("uv", "run", "--frozen", "--offline", "python", "scripts\generate_notices.py", "--check")
$noticePath = Join-Path $EvidenceDir "THIRD_PARTY_NOTICES.md"
$manifestPath = Join-Path $EvidenceDir "package-manifest.json"
Invoke-Check "generate notices (evidence)" @("uv", "run", "--frozen", "--offline", "python", "scripts\generate_notices.py", "uv.lock", "packaging\license_overrides.toml", $noticePath, $manifestPath)

# ---------------------------------------------------------------------------
# Package policy — Todo 29 declarative checks against the spec and lock.
# ---------------------------------------------------------------------------
$policyJson = Join-Path $EvidenceDir "package-policy.json"
Invoke-Check "check package policy" @("uv", "run", "--frozen", "--offline", "python", "scripts\check_package_policy.py", "packaging\hubfetch.spec", "--json", $policyJson)

# ---------------------------------------------------------------------------
# PyInstaller 6.22.0 — one-folder COLLECT into dist\HubFetch.
# ---------------------------------------------------------------------------
$distPath = Join-Path $RepoRoot "dist"
$buildPath = Join-Path $RepoRoot "build"
Invoke-Check "pyinstaller" @("uv", "run", "--frozen", "--offline", "pyinstaller", "--noconfirm", "--clean", "--distpath", $distPath, "--workpath", (Join-Path $buildPath "pyinstaller"), "packaging\hubfetch.spec")

$guiExe = Join-Path $distPath "HubFetch\HubFetch.exe"
$askExe = Join-Path $distPath "HubFetch\HubFetchAskPass.exe"
if (-not (Test-Path $guiExe)) {
    throw "packaged GUI executable missing: $guiExe"
}
if (-not (Test-Path $askExe)) {
    throw "packaged AskPass executable missing: $askExe"
}
Write-Step "entry points present: $guiExe, $askExe"

# ---------------------------------------------------------------------------
# Archive — deterministic relative layout under the top-level HubFetch dir.
# ---------------------------------------------------------------------------
$pyprojectText = Get-Content "pyproject.toml" -Raw
if ($pyprojectText -notmatch 'version\s*=\s*"([^"]+)"') {
    throw "unable to read the version from pyproject.toml"
}
$version = $Matches[1]
$artifactsDir = Join-Path $RepoRoot "artifacts"
New-Item -ItemType Directory -Force -Path $artifactsDir | Out-Null
$zipPath = Join-Path $artifactsDir "HubFetch-$version-windows-x64.zip"
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    (Join-Path $distPath "HubFetch"),
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $true
)
if (-not (Test-Path $zipPath)) {
    throw "archive was not created: $zipPath"
}
$hash = (Get-FileHash $zipPath -Algorithm SHA256).Hash
$zipInfo = Get-Item $zipPath
Write-Step "archive created: $zipPath"
Write-Step "archive bytes: $($zipInfo.Length) sha256: $hash"

Write-Step "=== build succeeded ==="
Write-Step "evidence: $EvidenceDir"
Write-Step "zip: $zipPath"
