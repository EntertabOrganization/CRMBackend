param([ValidateSet('setup','start','stop','health')][string]$Action = 'setup', [int]$Port = 56549)
$ErrorActionPreference = 'Stop'
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$clusterRoot = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot '.process-pack-test-db'))
if (-not $clusterRoot.StartsWith($workspaceRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid test cluster path' }
$binaryRoot = Join-Path $env:LOCALAPPDATA 'TrueCRM-ProcessPack/Postgres/runtime/pgsql/bin'
$control = Join-Path $binaryRoot 'pg_ctl.exe'
if (-not (Test-Path -LiteralPath $control)) { throw 'Install the EDB PostgreSQL binaries into the dedicated ProcessPack cache first.' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid dedicated test port' }
if ($Action -eq 'stop') {
  if (Test-Path -LiteralPath (Join-Path $clusterRoot 'postmaster.pid')) { & $control -D $clusterRoot stop -m fast; if ($LASTEXITCODE -ne 0) { throw 'Test database stop failed' } }
  exit
}
if ($Action -eq 'health') { & (Join-Path $binaryRoot 'pg_isready.exe') -h 127.0.0.1 -p $Port; exit $LASTEXITCODE }
if (-not (Test-Path -LiteralPath (Join-Path $clusterRoot 'PG_VERSION'))) {
  if ($Action -ne 'setup') { throw 'Dedicated test cluster has not been initialized' }
  New-Item -ItemType Directory -Force -Path $clusterRoot | Out-Null
  $password = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
  $passwordFile = Join-Path $env:LOCALAPPDATA ('TrueCRM-ProcessPack/Postgres/init-' + [Guid]::NewGuid().ToString('N') + '.password')
  [System.IO.File]::WriteAllText($passwordFile, $password, (New-Object System.Text.UTF8Encoding($false)))
  & (Join-Path $binaryRoot 'initdb.exe') -D $clusterRoot -U process_pack_test --auth=scram-sha-256 --pwfile=$passwordFile -E UTF8 --locale=C
  if ($LASTEXITCODE -ne 0) { throw 'Dedicated test cluster initialization failed' }
  Remove-Item -LiteralPath $passwordFile
  $testUrl = "postgresql://process_pack_test:$password@127.0.0.1:$Port/truecrm_process_pack_test?schema=public"
  [System.IO.File]::WriteAllText((Join-Path $workspaceRoot '.process-pack-test-env.env'), "PROCESS_PACK_TEST_DATABASE_URL=$testUrl`nDATABASE_URL=$testUrl`n", (New-Object System.Text.UTF8Encoding($false)))
}
& $control -D $clusterRoot status *> $null
if ($LASTEXITCODE -ne 0) {
  & $control -D $clusterRoot -l (Join-Path $clusterRoot 'server.log') -o "-p $Port -h 127.0.0.1" -w start
  if ($LASTEXITCODE -ne 0) { throw 'Dedicated test database startup failed' }
}
if ($Action -eq 'setup') {
  $configuration = [System.IO.File]::ReadAllText((Join-Path $workspaceRoot '.process-pack-test-env.env'))
  $url = [Uri](($configuration -split "`n" | Where-Object { $_.StartsWith('PROCESS_PACK_TEST_DATABASE_URL=') }).Substring(31).Trim())
  $priorPassword = $env:PGPASSWORD
  try {
    $env:PGPASSWORD = $url.UserInfo.Split(':')[1]
    $exists = & (Join-Path $binaryRoot 'psql.exe') -h 127.0.0.1 -p $Port -U process_pack_test -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='truecrm_process_pack_test'"
    if ($LASTEXITCODE -ne 0) { throw 'Dedicated test database lookup failed' }
    if ($exists -ne '1') {
      & (Join-Path $binaryRoot 'createdb.exe') -h 127.0.0.1 -p $Port -U process_pack_test truecrm_process_pack_test
      if ($LASTEXITCODE -ne 0) { throw 'Dedicated test database creation failed' }
    }
  } finally { $env:PGPASSWORD = $priorPassword }
}
Write-Output "Dedicated ProcessPack PostgreSQL is available on 127.0.0.1:$Port. No application migration or test was executed."
