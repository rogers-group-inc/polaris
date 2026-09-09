#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Polaris deployment script for Windows Server 2019/2022 with a remote/external PostgreSQL database.

.DESCRIPTION
    Installs Node.js 24 and deploys Polaris as a Windows Service, connecting to an external PostgreSQL database.
    Does NOT install PostgreSQL locally.

    Run as Administrator:
        powershell -ExecutionPolicy Bypass -File deploy\setup-windows-nodb.ps1 -DbUrl "postgresql://user:pass@db-host:5432/polaris"

    What this script does:
      1. Installs Node.js 24 LTS (via winget or direct MSI)
      2. Clones or copies the application to C:\polaris
      3. Configures .env with the provided DATABASE_URL
      4. Installs dependencies, builds, and runs migrations against the remote database
      5. Installs NSSM and registers Polaris as a Windows Service
      6. Opens port 3000 in Windows Firewall

    Use this script when your PostgreSQL database is hosted externally
    (e.g. AWS RDS, Azure Database for PostgreSQL, a separate DB server).

    After running, the app will be available at http://<server-ip>:3000
#>

param(
    [string]$DbUrl      = "",
    [string]$AppDir     = "C:\polaris",
    [string]$RepoUrl    = "https://github.com/rogers-group-inc/polaris.git",
    [int]   $Port       = 3000,
    [string]$NssmUrl    = "https://nssm.cc/release/nssm-2.24.zip"
)

$ErrorActionPreference = "Stop"

# ─── Colors ───────────────────────────────────────────────────────────────────
function Write-Info  { param([string]$Msg) Write-Host "[INFO]  $Msg" -ForegroundColor Green }
function Write-Warn  { param([string]$Msg) Write-Host "[WARN]  $Msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red; exit 1 }

# ─── Helpers ──────────────────────────────────────────────────────────────────
function Test-Command { param([string]$Name) return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Refresh-Path {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")
}

# ─── Preflight ────────────────────────────────────────────────────────────────
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Err "This script must be run as Administrator"
}

if (-not $DbUrl) {
    Write-Host ""
    Write-Host "No -DbUrl provided. Please enter the PostgreSQL connection URL." -ForegroundColor Yellow
    Write-Host "Format: postgresql://user:password@host:5432/database" -ForegroundColor Yellow
    Write-Host ""
    $DbUrl = Read-Host "DATABASE_URL"
    if (-not $DbUrl) {
        Write-Err "DATABASE_URL is required. Use -DbUrl or enter it when prompted."
    }
}

if ($DbUrl -notmatch "^postgres(ql)?://") {
    Write-Err "Invalid DATABASE_URL — must start with postgresql:// or postgres://"
}

Write-Info "Starting Polaris deployment on $env:COMPUTERNAME (remote database mode)"

$hasWinget = Test-Command "winget"

# ─── 1. Install Node.js 24 (LTS) ─────────────────────────────────────────────
# 22.12 is the hard floor: pg-boss declares >=22.12.0 and @prisma/streams-local
# declares >=22, so Node 20 is below what the dependency tree supports as well as
# being end-of-life (April 2026). An existing v22 is accepted; v20 is replaced.
Refresh-Path
if ((Test-Command "node") -and ((node -v) -match "^v(22|24)\.")) {
    Write-Info "Node.js $(node -v) already installed"
} else {
    Write-Info "Installing Node.js 24 LTS..."
    if ($hasWinget) {
        winget install --id OpenJS.NodeJS.LTS --version 24.19.0 --accept-source-agreements --accept-package-agreements --silent
    } else {
        $nodeUrl = "https://nodejs.org/dist/v24.19.0/node-v24.19.0-x64.msi"
        $nodeMsi = "$env:TEMP\node-v24.19.0-x64.msi"
        Write-Info "Downloading Node.js installer..."
        Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeMsi -UseBasicParsing
        Write-Info "Running Node.js installer..."
        Start-Process msiexec.exe -ArgumentList "/i `"$nodeMsi`" /qn /norestart" -Wait -NoNewWindow
        Remove-Item $nodeMsi -Force -ErrorAction SilentlyContinue
    }
    Refresh-Path
    if (-not (Test-Command "node")) {
        Write-Err "Node.js installation failed — 'node' not found in PATH. You may need to restart the terminal and re-run."
    }
    Write-Info "Node.js $(node -v) installed"
}

# ─── 1b. Install Go 1.22+ ────────────────────────────────────────────────────
# Required by the Polaris Agent build feature (Server Settings → Maintenance
# → Polaris Agent → Build). winget installs to C:\Program Files\Go\bin; we
# add it to Machine PATH so the NSSM service user sees it.
Refresh-Path
if ((Test-Command "go") -and ((go version) -match "go1\.(2[2-9]|[3-9][0-9])")) {
    Write-Info "Go $(go version) already installed"
} else {
    Write-Info "Installing Go 1.22..."
    if ($hasWinget) {
        winget install --id GoLang.Go.1.22 --accept-source-agreements --accept-package-agreements --silent
    } else {
        $goUrl = "https://go.dev/dl/go1.22.7.windows-amd64.msi"
        $goMsi = "$env:TEMP\go-1.22.7.windows-amd64.msi"
        Write-Info "Downloading Go installer..."
        Invoke-WebRequest -Uri $goUrl -OutFile $goMsi -UseBasicParsing
        Write-Info "Running Go installer..."
        Start-Process msiexec.exe -ArgumentList "/i `"$goMsi`" /qn /norestart" -Wait -NoNewWindow
        Remove-Item $goMsi -Force -ErrorAction SilentlyContinue
    }
    $goBin = "C:\Program Files\Go\bin"
    if (Test-Path $goBin) {
        $currentPath = [Environment]::GetEnvironmentVariable("Path", "Machine")
        if ($currentPath -notlike "*$goBin*") {
            [Environment]::SetEnvironmentVariable("Path", "$currentPath;$goBin", "Machine")
            Write-Info "Added $goBin to Machine PATH"
        }
    }
    Refresh-Path
    if (-not (Test-Command "go")) {
        Write-Err "Go installation failed — 'go' not found in PATH. You may need to restart the terminal and re-run."
    } else {
        Write-Info "Go $(go version) installed"
    }
}

# ─── 1c. Install Java 17 (agent code signing — optional at runtime) ──────────
# Used by the agent code-signing feature (Integrations → Polaris Agents →
# Code signing): when internal-CA code signing is configured, the in-app agent
# build signs the two Windows binaries via jsign (a Java CLI). Opt-in —
# missing Java only disables signing (the UI names what's missing), so
# failures here warn instead of aborting the install. The Microsoft OpenJDK
# MSI stamps itself into the Machine PATH, which the NSSM service inherits.
Refresh-Path
if (Test-Command "java") {
    Write-Info "Java already installed"
} else {
    Write-Info "Installing Microsoft OpenJDK 17 (for agent code signing)..."
    try {
        if ($hasWinget) {
            winget install --id Microsoft.OpenJDK.17 --accept-source-agreements --accept-package-agreements --silent
        } else {
            $jdkUrl = "https://aka.ms/download-jdk/microsoft-jdk-17-windows-x64.msi"
            $jdkMsi = "$env:TEMP\microsoft-jdk-17-windows-x64.msi"
            Write-Info "Downloading Microsoft OpenJDK installer..."
            Invoke-WebRequest -Uri $jdkUrl -OutFile $jdkMsi -UseBasicParsing
            Write-Info "Running OpenJDK installer..."
            Start-Process msiexec.exe -ArgumentList "/i `"$jdkMsi`" /qn /norestart" -Wait -NoNewWindow
            Remove-Item $jdkMsi -Force -ErrorAction SilentlyContinue
        }
        Refresh-Path
    } catch {
        Write-Warn "Java install failed ($_) — agent code signing stays unavailable until Java is installed manually"
    }
    if (Test-Command "java") {
        Write-Info "Java installed"
    } else {
        Write-Warn "'java' not found in PATH — agent code signing stays unavailable until Java is installed manually"
    }
}

# ─── 2. Test database connectivity ──────────────────────────────────────────
Write-Info "Testing database connectivity..."
try {
    $testResult = & node -e "
        const url = new URL('$DbUrl');
        const net = require('net');
        const s = net.createConnection(parseInt(url.port) || 5432, url.hostname, () => { console.log('OK'); s.end(); });
        s.setTimeout(5000, () => { console.log('TIMEOUT'); s.end(); });
        s.on('error', (e) => { console.log('FAIL:' + e.message); });
    " 2>$null
    if ($testResult -eq "OK") {
        Write-Info "Database host is reachable"
    } else {
        Write-Warn "Could not reach database host ($testResult) — continuing anyway"
    }
} catch {
    Write-Warn "Could not test database connectivity — continuing anyway"
}

# ─── 3. Deploy application ───────────────────────────────────────────────────
if (Test-Path (Join-Path $AppDir ".git")) {
    Write-Info "Updating existing installation..."
    Push-Location $AppDir
    & git pull --ff-only
    Pop-Location
} else {
    if (Test-Command "git") {
        Write-Info "Cloning repository to $AppDir..."
        if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
        & git clone $RepoUrl $AppDir
    } else {
        Write-Err "git is not installed. Install Git for Windows, or manually copy the application to $AppDir"
    }
}

# ─── 3b. Bootstrap Polaris Agent build directories ──────────────────────────
$agentDataDir = Join-Path $AppDir "data\agents"
$goCacheDir   = Join-Path $AppDir ".cache\go-build"
New-Item -ItemType Directory -Force -Path $agentDataDir | Out-Null
New-Item -ItemType Directory -Force -Path $goCacheDir   | Out-Null
Write-Info "Created agent build dirs: $agentDataDir, $goCacheDir"

# ─── 3c. jsign jar (agent code signing — optional at runtime) ────────────────
# SHA-256-pinned download for the agent code-signing feature. Failure only
# warns — signing is opt-in and the UI names exactly what's missing.
$jsignVersion = "7.5"
$jsignSha256  = "602A51C3545A6DC4FB99BD2EA7152B26D1345916D0C93DDFBD5936CB735AF91C"
$jsignJar = Join-Path $AppDir "tools\jsign.jar"
if (Test-Path $jsignJar) {
    Write-Info "jsign already present at $jsignJar"
} else {
    try {
        New-Item -ItemType Directory -Force -Path (Join-Path $AppDir "tools") | Out-Null
        Write-Info "Downloading jsign $jsignVersion (signs Windows agent binaries)..."
        $jsignTmp = "$jsignJar.tmp"
        Invoke-WebRequest -Uri "https://github.com/ebourg/jsign/releases/download/$jsignVersion/jsign-$jsignVersion.jar" -OutFile $jsignTmp -UseBasicParsing
        if ((Get-FileHash $jsignTmp -Algorithm SHA256).Hash -eq $jsignSha256) {
            Move-Item $jsignTmp $jsignJar -Force
            Write-Info "jsign $jsignVersion installed to $jsignJar"
        } else {
            Remove-Item $jsignTmp -Force -ErrorAction SilentlyContinue
            Write-Warn "jsign checksum mismatch — agent code signing stays unavailable until installed manually"
        }
    } catch {
        Write-Warn "jsign download failed ($_) — agent code signing stays unavailable until installed manually"
    }
}

# ─── 4. Configure environment ────────────────────────────────────────────────
$envFile = Join-Path $AppDir ".env"
if (-not (Test-Path $envFile)) {
    Write-Info "Creating .env..."
    $sessionSecret = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
    # 32 bytes as hex for POLARIS_SECRET_KEY (secret-at-rest encryption key).
    $keyBytes = New-Object 'System.Byte[]' 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($keyBytes)
    $polarisSecretKey = -join ($keyBytes | ForEach-Object { $_.ToString('x2') })
    @"
# Database (remote)
DATABASE_URL=$DbUrl

# App
PORT=$Port
NODE_ENV=production
LOG_LEVEL=info

# Auth
SESSION_SECRET=$sessionSecret

# Encryption key for secrets stored in the database (SNMP communities, WinRM/SSH
# passwords + private keys, FortiManager/FortiGate API tokens, the Entra client
# secret, vCenter credentials, delivery-channel secrets). Without it those
# values are stored as PLAINTEXT, and therefore appear in plaintext in every
# pg_dump. KEEP A COPY OFF THIS HOST: sealed secrets cannot be recovered
# without this key.
POLARIS_SECRET_KEY=$polarisSecretKey

# Extra CA bundle for Node's TLS. Set this when the network re-signs HTTPS with
# an internal CA: Node ships its OWN CA store and ignores the Windows
# certificate store, so a root this machine trusts is still rejected inside
# Polaris and inside npm - the symptom is npm failing
# UNABLE_TO_GET_ISSUER_CERT_LOCALLY on an update while the code pull in the same
# update succeeds.
#
# Left commented because Windows has no system PEM bundle to point at: the root
# lives in the certificate store and has to be exported to a file first. The
# Linux setup scripts CAN autodetect this and do; Windows cannot.
# See docs/INSTALL.md -> "Networks that inspect TLS" for the export command.
# NODE_EXTRA_CA_CERTS=C:\polaris\internal-root.pem
"@ | Set-Content $envFile -Encoding UTF8
    Write-Info ".env created with remote DATABASE_URL"
} else {
    Write-Info ".env already exists — appending secret-key env var if missing"
    Write-Warn "Verify DATABASE_URL in $envFile points to the correct remote database"
    # Installs that predate secrets-at-rest have no key, so device + integration
    # credentials sit in the clear in Postgres (and in every pg_dump). Mint one
    # here; the backfillSecretEncryption job seals the existing rows on next boot.
    if (-not (Select-String -Path $envFile -Pattern '^POLARIS_SECRET_KEY=' -Quiet)) {
        $keyBytes = New-Object 'System.Byte[]' 32
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($keyBytes)
        $polarisSecretKey = -join ($keyBytes | ForEach-Object { $_.ToString('x2') })
        @"

# Added by setup-windows-nodb.ps1 — encryption key for secrets stored in the database
# (SNMP communities, WinRM/SSH passwords + private keys, FortiManager/FortiGate
# API tokens, the Entra client secret, vCenter credentials, delivery-channel
# secrets). KEEP A COPY OFF THIS HOST: sealed secrets cannot be recovered
# without this key, and a backup restored onto a host with a different key
# needs its device + integration secrets re-entered.
POLARIS_SECRET_KEY=$polarisSecretKey
"@ | Add-Content $envFile -Encoding UTF8
        Write-Warn "Generated POLARIS_SECRET_KEY — back it up somewhere other than this host before the next backup"
    }
}

# ─── 5. Install dependencies & build ─────────────────────────────────────────
Push-Location $AppDir

Write-Info "Installing dependencies..."
& npm ci --include=dev
if ($LASTEXITCODE -ne 0) { Write-Err "npm ci failed" }

Write-Info "Building TypeScript..."
# `npm run build` (not bare tsc) so scripts/copy-build-assets.mjs runs and the
# bundled std MIB .txt files land in dist/services/stdMibs/ — without them the
# SNMP Walk tab's standard MIBs (LLDP-MIB etc.) report "not installed".
& npm run build
if ($LASTEXITCODE -ne 0) { Write-Err "TypeScript build failed" }

Write-Info "Running database migrations..."
& npx prisma migrate deploy
if ($LASTEXITCODE -ne 0) { Write-Err "Prisma migration failed" }

# Seed on first deploy — check via Prisma
$hasUsers = & node --env-file=.env -e "
    const { PrismaClient } = require('@prisma/client');
    const p = new PrismaClient();
    p.user.count().then(c => { console.log(c); p.`$disconnect(); }).catch(() => { console.log(0); p.`$disconnect(); });
" 2>$null
$hasUsers = if ($hasUsers) { ($hasUsers | Select-Object -Last 1).Trim() } else { "0" }
if ($hasUsers -eq "" -or $hasUsers -eq "0") {
    Write-Info "Seeding default admin (skipped in production — use the first-run wizard or restore from backup)..."
    & node --env-file=.env --import tsx/esm prisma/seed.ts
    $LASTEXITCODE = 0  # seed.ts refuses in production; treat as success so the script continues
} else {
    Write-Info "Database already seeded ($hasUsers users) — skipping"
}

Pop-Location

# ─── 6. Install NSSM & register Windows Service ─────────────────────────────
$nssmDir = "C:\nssm"
$nssmExe = Join-Path $nssmDir "nssm.exe"

if (-not (Test-Path $nssmExe)) {
    Write-Info "Installing NSSM (Non-Sucking Service Manager)..."
    $nssmZip = "$env:TEMP\nssm.zip"
    Invoke-WebRequest -Uri $NssmUrl -OutFile $nssmZip -UseBasicParsing
    Expand-Archive -Path $nssmZip -DestinationPath "$env:TEMP\nssm-extract" -Force
    if (-not (Test-Path $nssmDir)) { New-Item -ItemType Directory -Path $nssmDir -Force | Out-Null }

    $extracted = Get-ChildItem "$env:TEMP\nssm-extract" -Recurse -Filter "nssm.exe" |
                 Where-Object { $_.DirectoryName -like "*win64*" } |
                 Select-Object -First 1
    if (-not $extracted) {
        $extracted = Get-ChildItem "$env:TEMP\nssm-extract" -Recurse -Filter "nssm.exe" | Select-Object -First 1
    }
    if (-not $extracted) { Write-Err "Failed to find nssm.exe in downloaded archive" }
    Copy-Item $extracted.FullName $nssmExe -Force
    Remove-Item $nssmZip -Force -ErrorAction SilentlyContinue
    Remove-Item "$env:TEMP\nssm-extract" -Recurse -Force -ErrorAction SilentlyContinue
    Write-Info "NSSM installed to $nssmExe"
} else {
    Write-Info "NSSM already installed at $nssmExe"
}

$serviceName = "Polaris"
$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue

if ($existingService) {
    Write-Info "Service '$serviceName' already exists — updating..."
    if ($existingService.Status -eq "Running") {
        & $nssmExe stop $serviceName 2>$null
        Start-Sleep -Seconds 2
    }
} else {
    Write-Info "Creating Windows Service '$serviceName'..."
}

$nodeExe = (Get-Command node).Source

& $nssmExe install $serviceName $nodeExe 2>$null
& $nssmExe set $serviceName AppParameters "dist\index.js"
& $nssmExe set $serviceName AppDirectory $AppDir
& $nssmExe set $serviceName AppEnvironmentExtra "NODE_ENV=production"
& $nssmExe set $serviceName Description "Polaris — IP Management Tool"
& $nssmExe set $serviceName Start SERVICE_AUTO_START
& $nssmExe set $serviceName AppStdout (Join-Path $AppDir "logs\service-stdout.log")
& $nssmExe set $serviceName AppStderr (Join-Path $AppDir "logs\service-stderr.log")
& $nssmExe set $serviceName AppRotateFiles 1
& $nssmExe set $serviceName AppRotateBytes 5242880

$logsDir = Join-Path $AppDir "logs"
if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }

& $nssmExe start $serviceName 2>$null
Start-Sleep -Seconds 3

$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Info "Polaris service is running"
} else {
    Write-Warn "Service may not have started — check: nssm status $serviceName"
}

# ─── 7. Firewall ─────────────────────────────────────────────────────────────
$fwRule = Get-NetFirewallRule -DisplayName "Polaris (TCP $Port)" -ErrorAction SilentlyContinue
if (-not $fwRule) {
    Write-Info "Opening port $Port in Windows Firewall..."
    New-NetFirewallRule -DisplayName "Polaris (TCP $Port)" `
        -Direction Inbound -Protocol TCP -LocalPort $Port `
        -Action Allow -Profile Domain,Private | Out-Null
    Write-Info "Firewall rule created (Domain + Private profiles)"
} else {
    Write-Info "Firewall rule for port $Port already exists"
}

# ─── ICMP batching (informational) ────────────────────────────────────────────
# Polaris batches two ICMP cadences through fping on Linux — the packet-loss
# sweep and the ICMP status probe that decides whether a device is down — at
# one process per 500 targets. There is no fping build for Windows Server, so
# this install uses the per-host fallback for both: one `ping` process per
# asset per cycle.
#
# That is CORRECT, not degraded — the loss figures are the same. It is slower,
# and measurably so: Windows `ping` paces at a fixed ~1s per echo with no
# interval flag, where POSIX `ping -i 0.2` does the same burst in ~0.8s. Polaris
# handles this itself rather than overrunning — resolveSweepIntervalSec floors
# the sweep cadence at whatever this host can actually finish, so a large fleet
# gets loss on a 2-3 minute cadence instead of 60s. Nothing to configure; this
# note exists so the cadence is not a surprise.
Write-Info "ICMP batching: using per-host ping (no fping on Windows)."
Write-Info "  Verdicts are unaffected; on a large fleet the loss sweep interval widens."
# ─── Done ─────────────────────────────────────────────────────────────────────
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne "127.0.0.1" -and $_.PrefixOrigin -ne "WellKnown" } | Select-Object -First 1).IPAddress
if (-not $ip) { $ip = "localhost" }

Write-Host ""
Write-Info "============================================"
Write-Info "  Polaris deployment complete!"
Write-Info "  Mode:  Remote database"
Write-Info "  URL:   http://${ip}:${Port}"
Write-Info "  Login: admin / admin"
Write-Info "  Logs:  $AppDir\logs\"
Write-Info "  Service: nssm status $serviceName"
Write-Info "============================================"
Write-Host ""
Write-Warn "Change the default admin password after first login!"
