#Requires -Version 5
<#
.SYNOPSIS
    Easy by zCHG.org - Windows zero-dependency bootstrap
    Called by INSTALL.bat. Do not run directly.

    What this does:
      1. Installs Node.js LTS if not present (tries winget, then direct MSI download)
      2. Hands off to install.mjs which does everything else.
#>

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

function ok($m)  { Write-Host "  [OK] $m" -ForegroundColor Green }
function inf($m) { Write-Host "  --> $m" -ForegroundColor Cyan }
function wrn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function err($m) { Write-Host "  [X] $m" -ForegroundColor Red }
function hdr($m) { Write-Host "`n$m" -ForegroundColor White }

Write-Host ""
Write-Host " ======================================================" -ForegroundColor Cyan
Write-Host "   Easy by zCHG.org  |  One-Click Installer" -ForegroundColor Cyan
Write-Host "   (Windows Zero-Dependency Bootstrap)" -ForegroundColor DarkCyan
Write-Host " ======================================================" -ForegroundColor Cyan
Write-Host ""

hdr "Step 1/2 -- Node.js"

function Test-NodeOk {
    try {
        $v = & node --version 2>$null
        if ($v -match '^v(\d+)') {
            return ([int]$Matches[1] -ge 18)
        }
    } catch {
        return $false
    }
    return $false
}

if (Test-NodeOk) {
    ok "Node.js $(node --version) detected"
} else {
    $installed = $false

    if (-not $installed) {
        try {
            $null = Get-Command winget -ErrorAction Stop
            inf "Installing Node.js LTS via winget ..."
            & winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements --force
            if ($LASTEXITCODE -eq 0) {
                ok "Node.js installed via winget"
                $installed = $true
            } else {
                wrn "winget returned $LASTEXITCODE - will try direct download"
            }
        } catch {
            wrn "winget not available - will try direct download"
        }
    }

    if (-not $installed) {
        inf "Fetching Node.js LTS version info from nodejs.org ..."
        try {
            $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -TimeoutSec 30
            $lts = $index | Where-Object { $_.lts -and $_.lts -ne $false } | Select-Object -First 1
            if (-not $lts) {
                throw "Could not determine latest LTS version from nodejs.org."
            }

            $ver = $lts.version
            $msi = "node-$ver-x64.msi"
            $url = "https://nodejs.org/dist/$ver/$msi"
            $tmp = Join-Path $env:TEMP $msi

            if (Test-Path $tmp) {
                inf "Found cached installer at $tmp"
            } else {
                inf "Downloading Node.js $ver (~30 MB) ..."
                Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
                ok "Downloaded $tmp"
            }

            inf "Installing Node.js $ver silently (this takes ~30 s) ..."
            $msiArgs = "/i `"$tmp`" /quiet /norestart ADDLOCAL=ALL"
            $proc = Start-Process -FilePath "msiexec.exe" -ArgumentList $msiArgs -Wait -PassThru -NoNewWindow
            if ($proc.ExitCode -eq 0 -or $proc.ExitCode -eq 3010) {
                ok "Node.js $ver installed"
                $installed = $true
            } else {
                err "msiexec exited with code $($proc.ExitCode)"
            }
        } catch {
            err "Download/install failed: $($_.Exception.Message)"
        }
    }

    if (-not $installed) {
        err "Could not install Node.js automatically."
        err "Please install it manually from: https://nodejs.org"
        err "Then double-click INSTALL.bat again."
        Write-Host ""
        Read-Host "Press Enter to exit"
        exit 1
    }

    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machinePath;$userPath"

    foreach ($candidate in @(
        'C:\Program Files\nodejs',
        "$env:APPDATA\Local\Programs\nodejs",
        "$env:ProgramFiles\nodejs"
    )) {
        if (Test-Path (Join-Path $candidate 'node.exe')) {
            $env:Path = "$candidate;$env:Path"
            break
        }
    }

    if (-not (Test-NodeOk)) {
        err "Node.js was installed but is still not on PATH."
        err "Please close this window, open a new terminal, and run:"
        err "   node install.mjs"
        Write-Host ""
        Read-Host "Press Enter to exit"
        exit 1
    }

    ok "Node.js $(node --version) is ready"
}

hdr "Step 2/2 -- MCP Stack (install.mjs)"
inf "Handing off to install.mjs ..."
Write-Host ""

Set-Location $dir
& node "$dir\install.mjs" @args
$code = $LASTEXITCODE

if ($code -ne 0) {
    Write-Host ""
    err "Installer exited with error (code $code). See messages above."
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit $code
}
