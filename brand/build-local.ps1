# Build the Sparklebot desktop app on this PC, unsigned, for testing only.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File brand\build-local.ps1
#
# Output: apps\desktop\release\win-unpacked\Sparklebot.exe
# It uses Hermes's pinned Node, pnpm and Git from %LOCALAPPDATA%\hermes\tools for this
# process only, and reads packages from Hermes's pnpm store but copies them (no hard
# links), so this build never writes into the live Hermes install. Nothing is signed,
# installed, published or pushed.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $env:LOCALAPPDATA 'hermes\tools'

function Find-Tool([string]$pattern) {
    $dir = Get-ChildItem -LiteralPath $tools -Directory -Filter $pattern | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $dir) { throw "Hermes tool $pattern not found in $tools" }
    return $dir.FullName
}

$node = Find-Tool 'node-*'
$pnpm = Find-Tool 'pnpm-*'
$git = Join-Path (Find-Tool 'git-*') 'cmd'
$env:PATH = "$node;$pnpm;$git;$env:PATH"
$env:npm_config_store_dir = Join-Path $env:LOCALAPPDATA 'hermes\cache\pnpm\store'
$env:npm_config_prefer_offline = 'true'
$env:npm_config_package_import_method = 'copy'

$brand = Get-Content -Raw -LiteralPath (Join-Path $repo 'brand\sparklebot.json') | ConvertFrom-Json
# Records which Hermes version this build is made from (no .git in this copy yet).
$env:GITHUB_SHA = $brand.upstream.commit

function Step([string]$label, [scriptblock]$block) {
    $start = Get-Date
    Write-Host "`n=== $label" -ForegroundColor Cyan
    & $block
    if ($LASTEXITCODE -ne 0) { throw "$label failed (exit $LASTEXITCODE)" }
    Write-Host ("=== {0} done in {1:n0} s" -f $label, ((Get-Date) - $start).TotalSeconds) -ForegroundColor Cyan
}

Push-Location -LiteralPath $repo
try {
    Write-Host "node $(& node -v), pnpm $(& pnpm --version), git $((& git --version) -replace 'git version ','')"
    Step 'Brand overlay' { node brand/apply.mjs; if ($LASTEXITCODE -eq 0) { node brand/apply.mjs --check } }
    Step 'Dependencies (apps/desktop)' { node scripts/build/node-deps.mjs --source $repo --reuse --workspace apps/desktop }
    Push-Location -LiteralPath (Join-Path $repo 'apps\desktop')
    try {
        Step 'Compile the desktop app' { pnpm run build }
        Step 'Package the desktop app' { pnpm run builder --dir --publish never }
    } finally { Pop-Location }
    $exe = Join-Path $repo 'apps\desktop\release\win-unpacked\Sparklebot.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw "Build finished but $exe is missing" }
    Write-Host "`nBuilt: $exe" -ForegroundColor Green
} finally { Pop-Location }
