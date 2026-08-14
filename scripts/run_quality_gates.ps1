$ErrorActionPreference = "Stop"

function Invoke-Gate {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [scriptblock]$Command
    )

    Write-Host "==> $Name"
    & $Command
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

Invoke-Gate "uv lock" { uv lock --check --offline }
Invoke-Gate "ruff format" { uv run --frozen --offline ruff format --check . }
Invoke-Gate "ruff check" { uv run --frozen --offline ruff check . }
Invoke-Gate "basedpyright" { uv run --frozen --offline basedpyright }
Invoke-Gate "pytest" { uv run --frozen --offline pytest -q }
Invoke-Gate "no-excuse rules" {
    uv run --frozen --offline python scripts/check_no_excuse_rules.py .
}

exit 0
