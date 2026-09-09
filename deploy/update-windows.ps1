#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Polaris update script for Windows Server.

.DESCRIPTION
    Updates an existing Polaris installation to the latest version.

    Run as Administrator:
        powershell -ExecutionPolicy Bypass -File deploy\update-windows.ps1

    What this script does:
      1. Records the current version and commit
      2. Creates a database backup (pg_dump)
      3. Pulls the latest code from git
      4. Installs dependencies and rebuilds
      5. Runs database migrations
      6. Restarts the Windows Service
      7. Verifies the service is healthy

    On failure, offers to rollback to the previous version.
#>

param(
    [string]$AppDir      = "C:\polaris",
    [string]$DbName      = "polaris",
    [string]$ServiceName = "Polaris",
    [int]   $Port        = 3000,
    # Proceed even if the pre-update backup can't be taken. OFF by default:
    # step 5 runs `prisma migrate deploy`, which is irreversible, so an update
    # with no recovery point is the difference between a bad update and an
    # unrecoverable one. Mirrors applyUpdate(password, allowWithoutBackup) in
    # src/services/updateService.ts and --allow-without-backup in
    # deploy/update-linux.sh -- keep all three in lockstep.
    [switch]$AllowWithoutBackup,
    # Finish an update whose code pull already happened (the in-app updater
    # pulled, then failed at npm ci; or this script was interrupted after the
    # pull). Without it the "already up to date" check sees a no-op pull and
    # stops, leaving node_modules, dist\ and the schema at the OLD commit under
    # NEW source. Mirrors --force in deploy/update-linux.sh.
    [switch]$Force
)

$ErrorActionPreference = "Stop"

# ─── Colors ───────────────────────────────────────────────────────────────────
function Write-Info  { param([string]$Msg) Write-Host "[INFO]  $Msg" -ForegroundColor Green }
function Write-Warn  { param([string]$Msg) Write-Host "[WARN]  $Msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red }
function Write-Step  { param([string]$Msg) Write-Host "[STEP]  $Msg" -ForegroundColor Cyan }

# ─── Helpers ──────────────────────────────────────────────────────────────────
function Test-Command { param([string]$Name) return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

# Restore a gzipped plain-SQL pg_dump into $DbName. TimescaleDB-aware: a
# database with the extension must be restored between timescaledb_pre_restore()
# and timescaledb_post_restore(), each in its OWN psql session (pre_restore sets
# a database-level flag that only affects sessions opened after it). Skipping
# the pair restores hypertable metadata in the wrong order and leaves chunks
# invisible. post_restore runs even when the dump fails -- a database left in
# restoring mode rejects hypertable writes, which is worse than the failed
# restore. Errors are shown and the result is real; the old one-liner discarded
# stderr and then reported success unconditionally. Mirrors restore_database()
# in deploy/update-linux.sh and docs/INSTALL.md -> Backups -> Restoring.
function Restore-Database {
    param([string]$DumpFile)
    # 0 = extension absent, 1 = present, 2 = could not tell. Fail toward running
    # the gates: on a database WITHOUT the extension they are a clean, visible
    # error; on one WITH it, leaving them out corrupts the restore.
    $probe = (& psql -U postgres -tAX -d $DbName -c "SELECT count(*) FROM pg_extension WHERE extname = 'timescaledb'" 2>$null | Out-String).Trim()
    $probeOk = ($LASTEXITCODE -eq 0)
    if ($probeOk -and $probe -eq "0") { $gates = 0; Write-Info "timescaledb is not installed -- plain restore" }
    elseif ($probeOk -and $probe -eq "1") { $gates = 1; Write-Info "timescaledb is installed -- restoring between timescaledb_pre_restore() and timescaledb_post_restore()" }
    else { $gates = 2; Write-Warn "Could not determine whether timescaledb is installed -- running the pre/post restore gates anyway" }

    if ($gates -ge 1) {
        & psql -U postgres -qX -v ON_ERROR_STOP=1 -d $DbName -c "SELECT timescaledb_pre_restore();"
        if ($LASTEXITCODE -ne 0) {
            if ($gates -eq 1) {
                Write-Err "timescaledb_pre_restore() failed -- not restoring over a live TimescaleDB catalog without it."
                return $false
            }
            Write-Warn "timescaledb_pre_restore() failed -- the extension is probably absent; continuing with a plain restore"
            $gates = 0
        }
    }

    $tempSql = Join-Path $env:TEMP "polaris-restore.sql"
    $fs = [System.IO.File]::OpenRead($DumpFile)
    $gz = New-Object System.IO.Compression.GzipStream($fs, [System.IO.Compression.CompressionMode]::Decompress)
    $out = [System.IO.File]::Create($tempSql)
    $gz.CopyTo($out)
    $out.Close(); $gz.Close(); $fs.Close()
    & psql -U postgres -qX -v ON_ERROR_STOP=1 --single-transaction -d $DbName -f $tempSql
    $ok = ($LASTEXITCODE -eq 0)
    Remove-Item $tempSql -Force -ErrorAction SilentlyContinue
    if (-not $ok) { Write-Err "psql reported errors while restoring $DumpFile (see above)" }

    if ($gates -ge 1) {
        & psql -U postgres -qX -v ON_ERROR_STOP=1 -d $DbName -c "SELECT timescaledb_post_restore();"
        if ($LASTEXITCODE -ne 0) {
            Write-Err "timescaledb_post_restore() FAILED -- the database is still in restoring mode and will reject hypertable writes."
            Write-Err "Run it by hand:  psql -U postgres -d $DbName -c 'SELECT timescaledb_post_restore();'"
            $ok = $false
        }
    }
    return $ok
}

# Find pg_dump
$pgBinDirs = @(
    "C:\Program Files\PostgreSQL\17\bin",
    "C:\Program Files\PostgreSQL\16\bin",
    "C:\Program Files\PostgreSQL\15\bin"
)
$pgBin = $pgBinDirs | Where-Object { Test-Path "$_\pg_dump.exe" } | Select-Object -First 1
if ($pgBin -and $env:Path -notlike "*$pgBin*") {
    $env:Path = "$pgBin;$env:Path"
}

# NSSM
$nssmExe = "C:\nssm\nssm.exe"
if (-not (Test-Path $nssmExe)) {
    # Try PATH
    if (Test-Command "nssm") { $nssmExe = "nssm" }
    else { Write-Err "NSSM not found at C:\nssm\nssm.exe — is Polaris installed?"; exit 1 }
}

# ─── Preflight ────────────────────────────────────────────────────────────────
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Err "This script must be run as Administrator"; exit 1
}

if (-not (Test-Path (Join-Path $AppDir ".git"))) {
    Write-Err "$AppDir is not a git repository — was the app installed with the setup script?"
    exit 1
}

Push-Location $AppDir

# ─── State tracking ──────────────────────────────────────────────────────────
$OldVersion  = "unknown"
$OldCommit   = "unknown"
$NewVersion  = "unknown"
$NewCommit   = "unknown"
$BackupFile  = ""

# ─── Rollback function ──────────────────────────────────────────────────────
function Invoke-Rollback {
    param([string]$FailedAt)

    Write-Host ""
    Write-Err "Update failed at: $FailedAt"
    Write-Warn "Rolling back to v${OldVersion} (${OldCommit})..."
    Write-Host ""

    Push-Location $AppDir
    & git checkout $OldCommit -- . 2>$null
    if ($LASTEXITCODE -ne 0) { & git reset --hard $OldCommit 2>$null }
    & npm ci --include=dev 2>$null
    # Regenerate Prisma client + wipe stale dist so the rolled-back process
    # comes up with a client matching the rolled-back schema. Same rationale
    # as the forward-update path below; both are documented in
    # cross-cutting/schema-migrations-and-prisma-client-lifecycle in the polaris-change-impact skill.
    & node node_modules/prisma/build/index.js generate 2>$null
    if (Test-Path (Join-Path $AppDir "dist")) {
        Remove-Item -Recurse -Force (Join-Path $AppDir "dist") -ErrorAction SilentlyContinue
    }
    # `npm run build` (not bare tsc) so the post-tsc asset copy runs and the
    # rolled-back dist/ regains its non-.ts runtime assets: the bundled std MIB
    # .txt files and the platform end-of-life dataset under src/data/.
    & npm run build 2>$null

    # Restore database if migration failed
    if ($FailedAt -match "migration" -and $BackupFile -and (Test-Path $BackupFile)) {
        Write-Warn "Restoring database from backup..."
        if (Restore-Database -DumpFile $BackupFile) {
            Write-Info "Database restored from backup"
        } else {
            Write-Err "DATABASE RESTORE FAILED -- the database may be partially restored. The backup is retained at: $BackupFile"
            Write-Err "Restore it by hand: docs/INSTALL.md -> Backups -> Restoring (the TimescaleDB pre/post gates are required)."
        }
    }

    & $nssmExe restart $ServiceName 2>$null
    Write-Info "Rolled back to v${OldVersion} (${OldCommit})"
    Write-Info "Service restarted with previous version"

    if ($BackupFile -and (Test-Path $BackupFile)) {
        Write-Info "Database backup retained at: $BackupFile"
    }

    Pop-Location
    exit 1
}

# ─── 1. Record current version ──────────────────────────────────────────────
Write-Step "1/8  Recording current version..."

try { $OldVersion = (node -e "console.log(require('./package.json').version)") } catch {}
try { $OldCommit = (git rev-parse --short HEAD 2>$null) } catch {}
# A native-command failure does not throw here — it leaves $OldCommit empty.
# Normalise to a sentinel so the up-to-date check below can refuse to compare
# two unknowns as equal (the Linux script did exactly that on prod 2026-09-09,
# when git refused the checkout's ownership, and exited 0 having updated
# nothing).
if (-not $OldCommit) { $OldCommit = "unknown" }

Write-Info "Current version: v${OldVersion} (${OldCommit})"
if ($OldCommit -eq "unknown") {
    Write-Warn "Could not read the current git commit in $AppDir. The rollback target for this run is unknown."
}

# ─── 2. Pre-update database backup ──────────────────────────────────────────
# Same contract as the in-app updater: abort unless the operator explicitly
# accepted the risk. A missing backup must never be a warning that scrolls past
# on the way into an irreversible migration.
function Stop-WithoutBackup {
    param([string]$Reason)
    if ($AllowWithoutBackup) {
        Write-Warn "$Reason -- continuing anyway (-AllowWithoutBackup)."
        $script:BackupFile = ""
        return
    }
    Write-Err "$Reason"
    Write-Err "Refusing to update without a recovery point: step 5 runs 'prisma migrate deploy', which cannot be rolled back."
    Write-Err "Install the PostgreSQL client tools (or fix the backup), then re-run."
    Write-Err "To proceed anyway, re-run with -AllowWithoutBackup."
    exit 1
}

Write-Step "2/8  Creating pre-update database backup..."

$backupDir = Join-Path $AppDir "backups"
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }

if (Test-Command "pg_dump") {
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $BackupFile = Join-Path $backupDir "polaris-pre-update-${OldVersion}-${timestamp}.sql.gz"

    # pg_dump → gzip compress → file
    $sqlDump = & pg_dump -U postgres --clean --if-exists $DbName 2>$null
    if ($LASTEXITCODE -eq 0 -and $sqlDump) {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($sqlDump -join "`n")
        $fs = [System.IO.File]::Create($BackupFile)
        $gz = New-Object System.IO.Compression.GzipStream($fs, [System.IO.Compression.CompressionMode]::Compress)
        $gz.Write($bytes, 0, $bytes.Length)
        $gz.Close(); $fs.Close()

        $sizeKb = [math]::Round((Get-Item $BackupFile).Length / 1024, 1)
        Write-Info "Backup created: $BackupFile (${sizeKb} KB)"
    } else {
        if (Test-Path $BackupFile) { Remove-Item $BackupFile -Force }
        Stop-WithoutBackup "pg_dump failed"
    }
} else {
    Stop-WithoutBackup "pg_dump not found"
}

# ─── 3. Pull latest code ────────────────────────────────────────────────────
Write-Step "3/8  Pulling latest code..."

# Point origin at POLARIS_UPDATE_REPO before fetching, if it's set. Mirrors
# ensureUpdateRemote() in src/services/updateService.ts: when set, the var
# overrides whatever origin was cloned from; when UNSET, leave the existing
# origin untouched (update from wherever the install was cloned). Idempotent —
# only rewrites when the URL differs.
$UpdateRepo = ""
$EnvFile = Join-Path $AppDir ".env"
if (Test-Path $EnvFile) {
    $envLine = Select-String -Path $EnvFile -Pattern '^\s*POLARIS_UPDATE_REPO=' | Select-Object -Last 1
    if ($envLine) {
        $UpdateRepo = ($envLine.Line -replace '^\s*POLARIS_UPDATE_REPO=', '').Trim().Trim('"').Trim("'")
    }
}

# Carry NODE_EXTRA_CA_CERTS from .env into this process, so the `npm ci` below
# trusts the same extra roots the service does. Node ignores the OS trust store
# and reads this var at process start, so on a network that re-signs HTTPS with
# an internal CA every npm call fails UNABLE_TO_GET_ISSUER_CERT_LOCALLY while
# the pull above succeeds (that path is OpenSSL, which does read the store).
#
# The service gets it from .env via NSSM's environment; this script runs as
# Administrator and would not otherwise see it — which would make the
# "put it in .env" instruction in docs/INSTALL.md silently untrue here.
# An already-set machine-level variable wins, so an operator can override.
if ((Test-Path $EnvFile) -and -not $env:NODE_EXTRA_CA_CERTS) {
    $caLine = Select-String -Path $EnvFile -Pattern '^\s*NODE_EXTRA_CA_CERTS=' | Select-Object -Last 1
    if ($caLine) {
        $caPath = ($caLine.Line -replace '^\s*NODE_EXTRA_CA_CERTS=', '').Trim().Trim('"').Trim("'")
        if ($caPath -and (Test-Path $caPath)) {
            $env:NODE_EXTRA_CA_CERTS = $caPath
            Write-Info "Using extra CA bundle for npm TLS: $caPath"
        } elseif ($caPath) {
            Write-Warn "NODE_EXTRA_CA_CERTS in .env points at '$caPath', which does not exist - ignoring it."
        }
    }
}
if ($UpdateRepo) {
    $CurrentRepo = (& git remote get-url origin 2>$null)
    if ($CurrentRepo -ne $UpdateRepo) {
        Write-Info "Repointing origin remote (POLARIS_UPDATE_REPO) to $UpdateRepo"
        & git remote set-url origin $UpdateRepo 2>$null
        if ($LASTEXITCODE -ne 0) { & git remote add origin $UpdateRepo }
    }
}

& git fetch --all --prune
& git pull --ff-only
if ($LASTEXITCODE -ne 0) {
    Write-Err "git pull failed — do you have local changes? Run 'git status' to check."
    exit 1
}

try { $NewVersion = (node -e "console.log(require('./package.json').version)") } catch {}
try { $NewCommit = (git rev-parse --short HEAD 2>$null) } catch {}
if (-not $NewCommit) { $NewCommit = "unknown" }

# "Already up to date" is only a safe reason to stop when BOTH commits are
# known AND the operator has not asked to finish an interrupted run. An unknown
# commit is a reason to keep going and say so, never a reason to declare
# success; and "the pull moved nothing" is not "the install is current" — the
# in-app updater may have pulled and then failed before installing. Same
# contract as deploy/update-linux.sh.
if ($OldCommit -eq "unknown" -or $NewCommit -eq "unknown") {
    Write-Warn "Could not read the git commit before and after the pull — running the full pipeline rather than guessing that nothing changed."
}
elseif ($OldCommit -eq $NewCommit -and -not $Force) {
    Write-Info "Already up to date — v${OldVersion} (${OldCommit})"
    Write-Info "If an earlier update was interrupted after its code pull (dependencies, build or migrations still pending), re-run with -Force to finish it."
    # Clean up unnecessary backup
    if ($BackupFile -and (Test-Path $BackupFile)) {
        Remove-Item $BackupFile -Force
        Write-Info "Removed unnecessary backup"
    }
    Pop-Location
    exit 0
}
elseif ($OldCommit -eq $NewCommit) {
    Write-Info "Code already at ${NewCommit} — -Force set, finishing the install / build / migrate steps"
    Write-Warn "The code rollback for this run is a no-op: the checkout was already at this commit before it started."
}

Write-Info "Updating: v${OldVersion} (${OldCommit}) -> v${NewVersion} (${NewCommit})"

# ─── 4. Install dependencies ────────────────────────────────────────────────
Write-Step "4/8  Installing dependencies..."

& npm ci --include=dev
if ($LASTEXITCODE -ne 0) { Invoke-Rollback "npm ci" }

# Check for security vulnerabilities
$auditOutput = & npm audit --production 2>$null
if ($auditOutput -match "critical|high") {
    Write-Warn "npm audit found high/critical vulnerabilities:"
    $auditOutput | Select-String -Pattern "critical|high" | Select-Object -First 5 | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
    Write-Host ""
}

# ─── 5. Generate Prisma client ──────────────────────────────────────────────
# Explicit step — don't rely on `npm ci`'s postinstall having fired. A
# partially-failed `npm ci` (transient mirror blip, future --ignore-scripts,
# etc.) leaves the generated client stale; then step 7's `migrate deploy`
# drops columns the running client still selects, and every Asset read/write
# crashes with `column "<name>" does not exist`. See
# cross-cutting/schema-migrations-and-prisma-client-lifecycle in the polaris-change-impact skill.
Write-Step "5/8  Generating Prisma client..."

& node node_modules/prisma/build/index.js generate
if ($LASTEXITCODE -ne 0) { Invoke-Rollback "prisma generate" }

# ─── 6. Build TypeScript ────────────────────────────────────────────────────
# Clean dist/ first so stale compiled JS from a previous build (e.g.
# generated-client files Prisma renamed between versions) can't shadow the
# fresh tsc output. tsc itself is non-destructive: without this, a file
# that exists in dist/ but no longer in src/ lingers forever.
Write-Step "6/8  Building TypeScript..."

if (Test-Path (Join-Path $AppDir "dist")) {
    Remove-Item -Recurse -Force (Join-Path $AppDir "dist") -ErrorAction Stop
}
# `npm run build` (not bare tsc) so scripts/copy-build-assets.mjs runs after
# the compile and mirrors every non-.ts runtime asset into dist/ — tsc alone
# won't emit them. The std MIB .txt files (std SNMP-walks fail without them)
# and the platform end-of-life dataset under src/data/ (the Platform Lifecycle
# card renders empty without it) both ride this copy.
& npm run build
if ($LASTEXITCODE -ne 0) { Invoke-Rollback "TypeScript build" }

Write-Info "Build successful — stopping service for migration"

# ─── 7. Migrate & restart ───────────────────────────────────────────────────
Write-Step "7/8  Running database migrations..."

& $nssmExe stop $ServiceName 2>$null
Start-Sleep -Seconds 3

& node node_modules/prisma/build/index.js migrate deploy
if ($LASTEXITCODE -ne 0) { Invoke-Rollback "database migration" }

Write-Info "Migrations complete — starting service"

& $nssmExe start $ServiceName 2>$null

# ─── 8. Verify ──────────────────────────────────────────────────────────────
Write-Step "8/8  Verifying service health..."

Start-Sleep -Seconds 4

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Info "Service is running"
} else {
    Write-Warn "Service may not have started"
    $logFile = Join-Path $AppDir "logs\service-stderr.log"
    if (Test-Path $logFile) {
        Write-Warn "Last 10 lines of error log:"
        Get-Content $logFile -Tail 10 | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
    }
    Invoke-Rollback "service startup"
}

# HTTP health check
$healthOk = $false
for ($i = 1; $i -le 3; $i++) {
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:${Port}/api/v1/server-settings/branding" `
            -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue
        if ($response.StatusCode -eq 200 -or $response.StatusCode -eq 302 -or $response.StatusCode -eq 401) {
            $healthOk = $true
            break
        }
    } catch {
        # 401 comes as an exception in PowerShell but still means the server is up
        if ($_.Exception.Response.StatusCode.value__ -eq 401) {
            $healthOk = $true
            break
        }
    }
    Start-Sleep -Seconds 2
}

if ($healthOk) {
    Write-Info "HTTP health check passed"
} else {
    Write-Warn "HTTP health check did not pass — the service is running but may not be fully ready"
}

# ─── Summary ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Info "============================================"
Write-Info "  Update complete!"
Write-Info "  Version: v${OldVersion} -> v${NewVersion}"
Write-Info "  Commit:  ${OldCommit} -> ${NewCommit}"
if ($BackupFile -and (Test-Path $BackupFile)) {
    Write-Info "  Backup:  $BackupFile"
}
Write-Info "  Logs:    $AppDir\logs\"
Write-Info "  Service: nssm status $ServiceName"
Write-Info "============================================"
Write-Host ""

# Clean up old backups (keep last 10)
$oldBackups = Get-ChildItem "$backupDir\polaris-pre-update-*.sql.gz" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 10
if ($oldBackups) {
    $oldBackups | Remove-Item -Force
    Write-Info "Cleaned up $($oldBackups.Count) old pre-update backup(s)"
}

Pop-Location
