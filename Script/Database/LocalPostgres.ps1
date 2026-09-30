param(
  [Parameter(Position = 0)]
  [ValidateSet('setup', 'start', 'stop', 'health')]
  [string]$Action = 'health'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$LocalRoot = Join-Path $RepoRoot '.local-postgres'
$DataDir = Join-Path $LocalRoot 'data-utf8'
$BackupRoot = Join-Path $LocalRoot 'backups'
$PgBin = if ($env:POSTGRES_BIN) { $env:POSTGRES_BIN } else { 'D:\Applications\PostgreSql\bin' }
$PgCtl = Join-Path $PgBin 'pg_ctl.exe'
$InitDb = Join-Path $PgBin 'initdb.exe'
$Psql = Join-Path $PgBin 'psql.exe'
$Createdb = Join-Path $PgBin 'createdb.exe'
$PgIsReady = Join-Path $PgBin 'pg_isready.exe'

function Assert-CommandSucceeded([string]$Description) {
  if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE." }
}

function Read-EnvironmentFile {
  $values = @{}
  $path = Join-Path $RepoRoot '.env'
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing $path. Copy .env.example to .env first." }
  foreach ($line in [System.IO.File]::ReadAllLines($path)) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $parts = $line.Split('=', 2)
    $values[$parts[0].Trim()] = $parts[1].Trim().Trim('"').Trim("'")
  }
  return $values
}

function Get-DatabaseSettings {
  $values = Read-EnvironmentFile
  if (-not $values.ContainsKey('DATABASE_URL')) { throw 'DATABASE_URL is missing from .env.' }
  $uri = [Uri]$values['DATABASE_URL']
  $credentials = $uri.UserInfo.Split(':', 2)
  return [PSCustomObject]@{
    Url = $values['DATABASE_URL']
    Host = $uri.Host
    Port = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
    Database = $uri.AbsolutePath.TrimStart('/')
    User = [Uri]::UnescapeDataString($credentials[0])
    Password = if ($credentials.Count -gt 1) { [Uri]::UnescapeDataString($credentials[1]) } else { '' }
  }
}

function Assert-LocalConfiguration($settings) {
  if ($settings.Host -notin @('localhost', '127.0.0.1')) {
    throw "Local PostgreSQL management refuses non-local host '$($settings.Host)'."
  }
  foreach ($binary in @($PgCtl, $InitDb, $Psql, $Createdb, $PgIsReady)) {
    if (-not (Test-Path -LiteralPath $binary)) { throw "Required PostgreSQL binary was not found: $binary" }
  }
}

function Test-OurServerRunning {
  if (-not (Test-Path -LiteralPath $DataDir)) { return $false }
  & $PgCtl status -D $DataDir *> $null
  return $LASTEXITCODE -eq 0
}

function Test-PortOccupied([int]$Port) {
  return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function New-ClusterSnapshot([string]$Reason) {
  if (-not (Test-Path -LiteralPath $DataDir)) { return $null }
  New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $target = Join-Path $BackupRoot "data-utf8-$Reason-$stamp"
  if (Test-Path -LiteralPath $target) { throw "Backup target already exists: $target" }
  Write-Host "Preserving PostgreSQL cluster at $target ..."
  Copy-Item -LiteralPath $DataDir -Destination $target -Recurse
  return $target
}

function Remove-StalePostmasterPid([int]$Port) {
  $pidFile = Join-Path $DataDir 'postmaster.pid'
  if (-not (Test-Path -LiteralPath $pidFile)) { return }
  if (Test-OurServerRunning) { return }
  if (Test-PortOccupied $Port) {
    throw "Port $Port is already occupied. Refusing to remove postmaster.pid or start another database."
  }
  $recordedPid = [System.IO.File]::ReadLines($pidFile) | Select-Object -First 1
  $process = if ($recordedPid -match '^\d+$') { Get-CimInstance Win32_Process -Filter "ProcessId=$recordedPid" -ErrorAction SilentlyContinue } else { $null }
  if ($process -and $process.Name -like 'postgres*') {
    throw "PID $recordedPid belongs to PostgreSQL. Refusing to treat postmaster.pid as stale."
  }
  $recentSnapshot = Get-ChildItem -LiteralPath $BackupRoot -Directory -Filter 'data-utf8-before-stale-pid-recovery-*' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-30) } |
    Select-Object -First 1
  if (-not $recentSnapshot) { New-ClusterSnapshot 'before-stale-pid-recovery' | Out-Null }
  $removed = $false
  for ($attempt = 1; $attempt -le 10 -and -not $removed; $attempt++) {
    try {
      [System.IO.File]::Delete($pidFile)
      $removed = $true
    } catch [System.IO.IOException] {
      if ($attempt -eq 10) { throw }
      Start-Sleep -Milliseconds 250
    }
  }
  Write-Host 'Removed a verified stale postmaster.pid after preserving the cluster.'
}

function Initialize-Cluster($settings) {
  New-Item -ItemType Directory -Path $LocalRoot -Force | Out-Null
  if (Test-Path -LiteralPath $DataDir) { throw "Cluster directory already exists: $DataDir" }
  $passwordFile = Join-Path $LocalRoot ("init-password-{0}.tmp" -f ([Guid]::NewGuid().ToString('N')))
  try {
    [System.IO.File]::WriteAllText($passwordFile, $settings.Password, (New-Object System.Text.UTF8Encoding($false)))
    & $InitDb -D $DataDir -U $settings.User -A 'scram-sha-256' --pwfile=$passwordFile --encoding='UTF8' --locale='C'
    Assert-CommandSucceeded 'PostgreSQL cluster initialization'
  } finally {
    if (Test-Path -LiteralPath $passwordFile) { Remove-Item -LiteralPath $passwordFile -Force }
  }
}

function Start-Cluster($settings, [bool]$AllowRebuild) {
  if (Test-OurServerRunning) { return }
  if (-not (Test-Path -LiteralPath (Join-Path $DataDir 'PG_VERSION'))) {
    if (-not $AllowRebuild) { throw "Local cluster is missing. Run 'npm run db:setup'." }
    Initialize-Cluster $settings
  }
  Remove-StalePostmasterPid $settings.Port
  if (Test-PortOccupied $settings.Port) { throw "Port $($settings.Port) is occupied by another process." }
  $logPath = Join-Path $LocalRoot 'postgres-utf8.log'
  & $PgCtl start -D $DataDir -l $logPath -o "-p $($settings.Port) -h 127.0.0.1" -w
  if ($LASTEXITCODE -eq 0) { return }
  if (-not $AllowRebuild) { throw "PostgreSQL could not start. Inspect $logPath or run 'npm run db:setup' for preserved recovery." }

  $preserved = New-ClusterSnapshot 'unrecoverable'
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $failedPath = Join-Path $BackupRoot "data-utf8-unrecoverable-original-$stamp"
  Move-Item -LiteralPath $DataDir -Destination $failedPath
  Write-Warning "Recovery failed. The original cluster remains at $preserved and $failedPath. Initializing a clean cluster."
  Initialize-Cluster $settings
  & $PgCtl start -D $DataDir -l $logPath -o "-p $($settings.Port) -h 127.0.0.1" -w
  Assert-CommandSucceeded 'PostgreSQL startup after clean initialization'
}

function Assert-DatabaseReady($settings) {
  $previousPassword = $env:PGPASSWORD
  try {
    $env:PGPASSWORD = $settings.Password
    & $PgIsReady -h '127.0.0.1' -p $settings.Port -U $settings.User -d 'postgres' -q
    Assert-CommandSucceeded 'PostgreSQL readiness check'
    $answer = & $Psql -h '127.0.0.1' -p $settings.Port -U $settings.User -d 'postgres' -tAc 'SELECT 1'
    Assert-CommandSucceeded 'PostgreSQL authenticated health query'
    if (($answer | Out-String).Trim() -ne '1') { throw 'PostgreSQL health query returned an unexpected result.' }
  } finally {
    $env:PGPASSWORD = $previousPassword
  }
}

function Ensure-ApplicationDatabase($settings) {
  $previousPassword = $env:PGPASSWORD
  try {
    $env:PGPASSWORD = $settings.Password
    $exists = & $Psql -h '127.0.0.1' -p $settings.Port -U $settings.User -d 'postgres' -tAc "SELECT 1 FROM pg_database WHERE datname = '$($settings.Database.Replace("'", "''"))'"
    Assert-CommandSucceeded 'Application database lookup'
    if (($exists | Out-String).Trim() -ne '1') {
      & $Createdb -h '127.0.0.1' -p $settings.Port -U $settings.User $settings.Database
      Assert-CommandSucceeded 'Application database creation'
      Write-Host "Created database $($settings.Database)."
    }
  } finally {
    $env:PGPASSWORD = $previousPassword
  }
}

function Deploy-And-Seed($settings) {
  $previousUrl = $env:DATABASE_URL
  try {
    $env:DATABASE_URL = $settings.Url
    Push-Location $RepoRoot
    try {
      & npx.cmd prisma migrate deploy
      Assert-CommandSucceeded 'Prisma migration deployment'
      & node.exe 'Script\Seeding\SeedAdminPermissions.js'
      Assert-CommandSucceeded 'Admin and permission seeding'
    } finally { Pop-Location }
  } finally { $env:DATABASE_URL = $previousUrl }
}

$settings = Get-DatabaseSettings
Assert-LocalConfiguration $settings

switch ($Action) {
  'setup' {
    Start-Cluster $settings $true
    Assert-DatabaseReady $settings
    Ensure-ApplicationDatabase $settings
    Deploy-And-Seed $settings
    Write-Host "PostgreSQL is ready at $($settings.Host):$($settings.Port)/$($settings.Database)."
  }
  'start' {
    Start-Cluster $settings $false
    Assert-DatabaseReady $settings
    Write-Host "PostgreSQL is ready at $($settings.Host):$($settings.Port)."
  }
  'stop' {
    if (Test-OurServerRunning) {
      & $PgCtl stop -D $DataDir -m fast -w
      Assert-CommandSucceeded 'PostgreSQL shutdown'
    }
    Write-Host 'Project-local PostgreSQL is stopped.'
  }
  'health' {
    if (-not (Test-OurServerRunning)) { throw 'Project-local PostgreSQL is not running.' }
    Assert-DatabaseReady $settings
    Write-Host 'Project-local PostgreSQL is healthy.'
  }
}
