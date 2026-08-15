# Extracts the portable HubFetch ZIP into a clean path with spaces and
# non-ASCII characters, proves the packaged application needs no installed
# Python, and runs the headless smoke plus a deterministic GUI capture.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\smoke_portable.ps1 `
#       -Zip artifacts\HubFetch-0.1.0-windows-x64.zip -EvidenceDir <dir>
#
# The script clears PYTHONPATH and removes the project, venv, Python, and
# package-manager directories from PATH before launching the bundled
# executables with an isolated app-data root. It inspects the PE architecture
# of both entry points, the required license/plugin/DLL inventory, forbidden
# binaries, import origin (nothing from the source tree), orphan processes,
# and sentinel byte absence. All results are aggregated into
# portable-smoke.json; any contract failure writes package-failures.txt and
# exits nonzero after cleanup.

param(
    [Parameter(Mandatory = $true)]
    [string]$Zip,
    [string]$EvidenceDir = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $EvidenceDir) {
    $EvidenceDir = Join-Path $RepoRoot ".omo\evidence\task-30-windows-huggingface-manager\smoke"
}
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null

$failures = New-Object System.Collections.Generic.List[string]
$sentinelFiles = New-Object System.Collections.Generic.List[string]
$forbiddenEntries = New-Object System.Collections.Generic.List[string]
$missingEntries = New-Object System.Collections.Generic.List[string]
$orphans = New-Object System.Collections.Generic.List[string]
$policyEntries = New-Object System.Collections.Generic.List[string]

function Add-Failure([string]$Message) {
    $failures.Add($Message)
    Write-Host "FAIL: $Message"
}

function Get-PeMachine([string]$ExePath) {
    $bytes = [System.IO.File]::ReadAllBytes($ExePath)
    $e_lfanew = [System.BitConverter]::ToInt32($bytes, 0x3C)
    return [System.BitConverter]::ToUInt16($bytes, $e_lfanew + 4)
}

function Stop-HubFetchProcesses {
    Get-Process -Name "HubFetch*" -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-PackagedExe([string]$FilePath, [string[]]$Arguments) {
    # The windowed HubFetch.exe has no console, so PowerShell's & returns
    # immediately and $LASTEXITCODE stays null. A System.Diagnostics.Process
    # waits reliably for GUI-subsystem executables; ProcessStartInfo.ArgumentList
    # is unavailable on PS 5.1's .NET, so every token is quoted by hand into the
    # single Arguments string (paths contain spaces and non-ASCII characters).
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $quoted = @($Arguments | ForEach-Object { '"' + $_ + '"' })
    $startInfo.Arguments = ($quoted -join " ")
    $process = [System.Diagnostics.Process]::Start($startInfo)
    $process.WaitForExit()
    return $process.ExitCode
}

$tempRoot = Join-Path $env:TEMP ("hubfetch-portable-" + [guid]::NewGuid().ToString("N"))
$extractRoot = Join-Path $tempRoot "便携 测试"
New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
Write-Host "extracting $Zip into $extractRoot"
Expand-Archive -Path $Zip -DestinationPath $extractRoot -Force

$appRoot = Join-Path $extractRoot "HubFetch"
if (-not (Test-Path $appRoot)) {
    Write-Host "FAIL: archive does not contain a top-level HubFetch directory"
    Add-Failure "archive layout: expected top-level HubFetch directory"
    $appRoot = $extractRoot
}

# ---------------------------------------------------------------------------
# Clean environment — no Python, no project, no venv, no package manager.
# ---------------------------------------------------------------------------
Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
Remove-Item Env:PYTHONHOME -ErrorAction SilentlyContinue
Remove-Item Env:VIRTUAL_ENV -ErrorAction SilentlyContinue
Remove-Item Env:CONDA_PREFIX -ErrorAction SilentlyContinue
Remove-Item Env:HUBFETCH_APP_DATA_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:HUBFETCH_ASKPASS_ALIAS -ErrorAction SilentlyContinue
Remove-Item Env:GIT_ASKPASS -ErrorAction SilentlyContinue
Remove-Item Env:SSH_ASKPASS -ErrorAction SilentlyContinue

$systemDirs = @(
    "$env:WINDIR\System32",
    "$env:WINDIR",
    "$env:WINDIR\System32\Wbem",
    "$env:WINDIR\System32\WindowsPowerShell\v1.0",
    "$env:WINDIR\System32\OpenSSH"
)
$env:PATH = ($systemDirs -join ";")
$pythonOnCleanPath = [bool](Get-Command python -ErrorAction SilentlyContinue)
Write-Host "python on cleaned PATH: $pythonOnCleanPath"

# ---------------------------------------------------------------------------
# PE architecture of both entry points (AMD64 = 0x8664).
# ---------------------------------------------------------------------------
$guiExe = Join-Path $appRoot "HubFetch.exe"
$askExe = Join-Path $appRoot "HubFetchAskPass.exe"
$peResults = @{ hubfetch = "missing"; askpass = "missing" }
foreach ($pair in @(@("hubfetch", $guiExe), @("askpass", $askExe))) {
    $name = $pair[0]
    $path = $pair[1]
    if (-not (Test-Path $path)) {
        Add-Failure "entry point missing: $path"
        continue
    }
    $machine = Get-PeMachine $path
    $arch = if ($machine -eq 0x8664) { "amd64" } else { "unknown_0x{0:X}" -f $machine }
    $peResults[$name] = $arch
    if ($machine -ne 0x8664) {
        Add-Failure "PE architecture: $path is not AMD64 (machine 0x{0:X})" -f $machine
    }
}
Write-Host "PE: HubFetch=$($peResults.hubfetch) HubFetchAskPass=$($peResults.askpass)"

# ---------------------------------------------------------------------------
# Required license/plugin/DLL inventory (suffix match against the tree).
# ---------------------------------------------------------------------------
$relativePaths = @(Get-ChildItem -Path $appRoot -Recurse -File | ForEach-Object {
        $_.FullName.Substring($appRoot.Length + 1) -replace "\\", "/"
    })
$runtimeRoot = Join-Path $appRoot "_internal"
if (-not (Test-Path $runtimeRoot)) {
    $runtimeRoot = $appRoot
}
$runtimeRelativePaths = @(Get-ChildItem -Path $runtimeRoot -Recurse -File | ForEach-Object {
        $_.FullName.Substring($runtimeRoot.Length + 1) -replace "\\", "/"
    })

$required = @(
    "HubFetch.exe",
    "HubFetchAskPass.exe",
    "licenses/LICENSE",
    "licenses/THIRD_PARTY_NOTICES.md",
    "licenses/qt/LGPL-3.0.txt",
    "licenses/qt/GPL-3.0.txt",
    "docs/qt-lgpl-compliance.md",
    "docs/help_url_template.conf",
    "resources/fonts/CascadiaMono.ttf",
    "resources/fonts/OFL.txt",
    "resources/icons/settings.svg",
    "resources/icons/LICENSE.md",
    "hubfetch/persistence/sql/001_initial.sql",
    "PySide6/plugins/platforms/qwindows.dll",
    "PySide6/plugins/platforms/qminimal.dll",
    "PySide6/plugins/platforms/qoffscreen.dll",
    "PySide6/plugins/imageformats/qgif.dll",
    "PySide6/plugins/imageformats/qico.dll",
    "PySide6/plugins/imageformats/qjpeg.dll",
    "PySide6/plugins/imageformats/qsvg.dll",
    "PySide6/plugins/tls/qschannelbackend.dll",
    "PySide6/plugins/iconengines/qsvgicon.dll",
    "PySide6/plugins/styles/qmodernwindowsstyle.dll",
    "PySide6/translations/qtbase_zh_CN.qm",
    "hubfetch/i18n/hubfetch_zh_CN.qm",
    "hubfetch/i18n/hubfetch_en_US.qm",
    "PySide6/Qt6Core.dll",
    "PySide6/Qt6Gui.dll",
    "PySide6/Qt6Widgets.dll",
    "PySide6/Qt6OpenGL.dll",
    "PySide6/Qt6Xml.dll",
    "PySide6/Qt6DBus.dll",
    "PySide6/Qt6Svg.dll",
    "PySide6/Qt6Network.dll",
    "PySide6/pyside6.abi3.dll",
    "shiboken6/shiboken6.abi3.dll"
)
foreach ($entry in $required) {
    $found = $false
    foreach ($relative in $relativePaths) {
        if ($relative.EndsWith($entry)) {
            $found = $true
            break
        }
    }
    if (-not $found) {
        $missingEntries.Add($entry)
        Add-Failure "required package entry missing: $entry"
    }
}

# ---------------------------------------------------------------------------
# Forbidden binaries and database files inside the package tree.
# ---------------------------------------------------------------------------
foreach ($relative in $relativePaths) {
    $lowered = $relative.ToLowerInvariant()
    $basename = $lowered.Substring($lowered.LastIndexOf("/") + 1)
    $isForbidden = ($basename -in @("git.exe", "git-lfs.exe", "git-xet", "hf.exe", "hub.exe")) -or
        ($lowered.Split("/") -contains "git-xet") -or
        ($lowered.EndsWith(".db") -or $lowered.EndsWith(".sqlite") -or $lowered.EndsWith(".sqlite3") -or $lowered.EndsWith(".wal"))
    if ($isForbidden) {
        $forbiddenEntries.Add($relative)
        Add-Failure "forbidden packaged entry: $relative"
    }
}

# ---------------------------------------------------------------------------
# GPL-only Qt modules must never ship in the MIT/LGPL build. The DLL blocklist
# mirrors scripts/_policy_constants.py GPL_ONLY_QT_DLLS.
# ---------------------------------------------------------------------------
$gplOnlyQtDlls = @(
    "qt6charts.dll",
    "qt6chartsqml.dll",
    "qt6datavisualization.dll",
    "qt6datavisualizationqml.dll",
    "qt6virtualkeyboard.dll",
    "qt6virtualkeyboardqml.dll",
    "qt6virtualkeyboardsettings.dll",
    "qt6networkauth.dll",
    "qt6webenginecore.dll",
    "qt6webengine.dll",
    "qt6webenginequickdelegatesqml.dll",
    "qt6webenginewidgets.dll",
    "qt6webenginequick.dll",
    "qt6webview.dll",
    "qt6webviewquick.dll",
    "qt6pdf.dll",
    "qt6pdfwidgets.dll",
    "qt6quick3d.dll",
    "qt6sensors.dll",
    "qt6sensorsquick.dll",
    "qt6serialbus.dll",
    "qt6serialport.dll",
    "qt6graphs.dll",
    "qt6graphswidgets.dll"
)
foreach ($relative in $runtimeRelativePaths) {
    $lowered = $relative.ToLowerInvariant()
    $basename = $lowered.Substring($lowered.LastIndexOf("/") + 1)
    if ($gplOnlyQtDlls -contains $basename) {
        $policyEntries.Add($relative)
        Add-Failure "GPL-only Qt DLL packaged: $relative"
    }
}

# ---------------------------------------------------------------------------
# Qt plugin/translation trimming — only the RESOURCE_PLAN allowlist may ship,
# and the QML tree must not exist.
# ---------------------------------------------------------------------------
$allowedQtPlugins = @(
    "PySide6/plugins/platforms/qwindows.dll",
    "PySide6/plugins/platforms/qminimal.dll",
    "PySide6/plugins/platforms/qoffscreen.dll",
    "PySide6/plugins/imageformats/qgif.dll",
    "PySide6/plugins/imageformats/qico.dll",
    "PySide6/plugins/imageformats/qjpeg.dll",
    "PySide6/plugins/imageformats/qsvg.dll",
    "PySide6/plugins/tls/qschannelbackend.dll",
    "PySide6/plugins/iconengines/qsvgicon.dll",
    "PySide6/plugins/styles/qmodernwindowsstyle.dll"
)
foreach ($relative in $runtimeRelativePaths) {
    if ($relative.StartsWith("PySide6/plugins/") -and ($allowedQtPlugins -notcontains $relative)) {
        $policyEntries.Add($relative)
        Add-Failure "unexpected Qt plugin packaged: $relative"
    }
    if ($relative.StartsWith("PySide6/translations/") -and ($relative -ne "PySide6/translations/qtbase_zh_CN.qm")) {
        $policyEntries.Add($relative)
        Add-Failure "unexpected Qt translation packaged: $relative"
    }
    if ($relative.StartsWith("PySide6/qml/")) {
        $policyEntries.Add($relative)
        Add-Failure "QML tree packaged: $relative"
    }
}

# ---------------------------------------------------------------------------
# Sentinel byte scan across every packaged file (ASCII decoding maps every
# byte directly and preserves the 7-bit sentinel, so a native IndexOf finds
# it without a slow per-byte loop over ~200 MB of binaries).
# ---------------------------------------------------------------------------
$sentinel = "hf_test_secret_123"
foreach ($file in (Get-ChildItem -Path $appRoot -Recurse -File)) {
    $text = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($file.FullName))
    if ($text.IndexOf($sentinel) -ge 0) {
        $relative = $file.FullName.Substring($appRoot.Length + 1) -replace "\\", "/"
        $sentinelFiles.Add($relative)
        Add-Failure "sentinel bytes found in packaged file: $relative"
    }
}

# ---------------------------------------------------------------------------
# Headless smoke with an isolated app-data root (clean environment).
# ---------------------------------------------------------------------------
$appDataSmoke = Join-Path $extractRoot "app-data-smoke"
$smokeJson = Join-Path $EvidenceDir "smoke-result.json"
$smokeStdout = Join-Path $EvidenceDir "smoke-stdout.txt"
$smokeStderr = Join-Path $EvidenceDir "smoke-stderr.txt"
# The windowed exe has no console streams; evidence lives in the smoke JSON.
$null = New-Item -ItemType File -Force -Path $smokeStdout, $smokeStderr
$smokeExit = Invoke-PackagedExe $guiExe @("--smoke-test", "--app-data-root", $appDataSmoke, "--smoke-json", $smokeJson)
Write-Host "HubFetch.exe --smoke-test exit code: $smokeExit"
if ($smokeExit -ne 0) {
    Add-Failure "headless smoke exited $smokeExit (see smoke-result.json)"
}

# ---------------------------------------------------------------------------
# Deterministic GUI capture of the empty Tasks shell.
# ---------------------------------------------------------------------------
$appDataCapture = Join-Path $extractRoot "app-data-capture"
$guiPng = Join-Path $EvidenceDir "empty-shell.png"
$captureStdout = Join-Path $EvidenceDir "capture-stdout.txt"
$captureStderr = Join-Path $EvidenceDir "capture-stderr.txt"
$null = New-Item -ItemType File -Force -Path $captureStdout, $captureStderr
$captureExit = Invoke-PackagedExe $guiExe @("--smoke-capture", $guiPng, "--app-data-root", $appDataCapture)
Write-Host "HubFetch.exe --smoke-capture exit code: $captureExit"
if ($captureExit -ne 0) {
    Add-Failure "GUI capture exited $captureExit (see capture evidence)"
}
$captureBytes = 0
if (Test-Path $guiPng) {
    $captureBytes = (Get-Item $guiPng).Length
    if ($captureBytes -lt 1000) {
        Add-Failure "GUI capture PNG suspiciously small: $captureBytes bytes"
    }
} else {
    Add-Failure "GUI capture PNG was not produced: $guiPng"
}

# ---------------------------------------------------------------------------
# Import origin — nothing in the packaged process may come from the source
# tree; hubfetch and PySide6 must resolve inside the archive.
# ---------------------------------------------------------------------------
$smokeReport = $null
if (Test-Path $smokeJson) {
    $smokeReport = Get-Content $smokeJson -Raw | ConvertFrom-Json
    $originValues = @()
    if ($null -ne $smokeReport.module_origins) {
        $originValues = @($smokeReport.module_origins.PSObject.Properties | ForEach-Object { [string]$_.Value })
    }
    foreach ($origin in $originValues) {
        if ($origin -match [regex]::Escape($RepoRoot)) {
            Add-Failure "import origin leaks the source tree: $origin"
        }
        if ($origin -notmatch "_internal") {
            Add-Failure "import origin is not inside the archive: $origin"
        }
    }
    foreach ($path in @($smokeReport.sys_path)) {
        if ($path -match [regex]::Escape($RepoRoot)) {
            Add-Failure "sys.path leaks the source tree: $path"
        }
    }
    if ($smokeReport.frozen -ne $true) {
        Add-Failure "packaged smoke did not run frozen (sys.frozen is false)"
    }
    if ($smokeReport.pe_architecture -ne "amd64") {
        Add-Failure "packaged self-report PE architecture is not amd64: $($smokeReport.pe_architecture)"
    }
    if ($smokeReport.package_inventory_ok -ne $true) {
        Add-Failure "packaged self-report package inventory check failed"
    }
    if ($smokeReport.settings_roundtrip -ne $true) {
        Add-Failure "packaged settings/migration roundtrip failed"
    }
    if ($smokeReport.askpass.error) {
        Add-Failure "packaged AskPass contract error: $($smokeReport.askpass.error)"
    }
} else {
    Add-Failure "smoke report JSON was not produced"
}

# ---------------------------------------------------------------------------
# Orphan process check after every HubFetch process has exited.
# ---------------------------------------------------------------------------
$leftovers = @(Get-Process -Name "HubFetch*" -ErrorAction SilentlyContinue)
foreach ($process in $leftovers) {
    $orphans.Add($process.ProcessName)
    Add-Failure "orphan process left behind: $($process.ProcessName) (PID $($process.Id))"
}

# ---------------------------------------------------------------------------
# Aggregate evidence and cleanup.
# ---------------------------------------------------------------------------
$passed = ($failures.Count -eq 0)
$aggregate = [ordered]@{
    zip = $Zip
    extracted_to = $extractRoot
    evidence_dir = $EvidenceDir
    os_build = [int](Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion").CurrentBuildNumber
    python_on_clean_path = $pythonOnCleanPath
    pe_architecture = $peResults
    required_entry_missing = @($missingEntries)
    forbidden_entries = @($forbiddenEntries)
    policy_entries = @($policyEntries)
    sentinel_files = @($sentinelFiles)
    smoke_exit = $smokeExit
    capture_exit = $captureExit
    capture_png = $guiPng
    capture_png_bytes = $captureBytes
    smoke_report = $smokeReport
    orphans = @($orphans)
    failures = @($failures)
    passed = $passed
}
$aggregateJson = $aggregate | ConvertTo-Json -Depth 12
$portableJsonPath = Join-Path $EvidenceDir "portable-smoke.json"
[System.IO.File]::WriteAllText($portableJsonPath, $aggregateJson, [System.Text.UTF8Encoding]::new($false))
Write-Host "portable-smoke.json written: $portableJsonPath"

if (-not $passed) {
    $failurePath = Join-Path $EvidenceDir "package-failures.txt"
    [System.IO.File]::WriteAllLines($failurePath, [string[]]@($failures), [System.Text.UTF8Encoding]::new($false))
    Write-Host "package smoke FAILED: $($failures.Count) failure(s) recorded in $failurePath"
}

# Cleanup: terminate any smoke processes and remove the temporary extraction.
Stop-HubFetchProcesses
if (Test-Path $tempRoot) {
    Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "cleanup complete (temp removed, HubFetch processes stopped)"

if (-not $passed) {
    exit 1
}
Write-Host "package smoke PASSED"
exit 0
