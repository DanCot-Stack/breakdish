param(
  [switch] $InternalChild,
  [switch] $ReleaseVerifierSummaryOnly,
  [switch] $ReleaseToolsOnly
)

if (-not $InternalChild) {
  $pwsh = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe"
  if (-not (Test-Path -LiteralPath $pwsh -PathType Leaf)) {
    [ordered]@{
      success = $false
      failureStage = "preflight"
      failedCheck = "powershell7-runtime"
      powershellMajorVersion = $PSVersionTable.PSVersion.Major
      powershell7Available = $false
      productionConnectionUsed = $false
    } | ConvertTo-Json -Compress | Write-Output
    return
  }
  Write-Host "[BREAK DISH local test] Starting the bundled PowerShell 7 runner in this Windows account."
  & $pwsh -NoLogo -NoProfile -File $PSCommandPath -InternalChild `
    -ReleaseVerifierSummaryOnly:$ReleaseVerifierSummaryOnly `
    -ReleaseToolsOnly:$ReleaseToolsOnly
  exit $LASTEXITCODE
}

$ErrorActionPreference = "Stop"

$stage = "preflight"
$preflightCheck = "powershell-version"
$success = $false
$cleanupPending = $false
$testRoot = $null
$testRootCreated = $false
$dataDirectory = $null
$locationPushed = $false
$postgresVersion = $null
$failureReason = $null
$processExitCode = $null
$releaseToolDiagnostic = $null
$checks = [ordered]@{
  powershell7 = $null
  nonSandboxIdentity = $null
  nonElevatedToken = $null
  nodeExecutable = $null
  betterAuthCli = $null
  apiDirectory = $null
  postgresqlExecutables = $null
  postgresqlPrerequisite = $null
  postgresVersion = $null
  localTempOutsideSync = $null
  tempFolderCreated = $null
  loopbackPortSelected = $null
  betterAuthSchemaPrepared = $null
  applicationSchemaPrepared = $null
  releaseVerifierSummaryProbe = $null
  releaseToolUnitTestsPassed = $null
  applicationSuiteSkippedForReleaseToolsOnly = $null
}
$marker = [Guid]::NewGuid().ToString("N")
$savedPath = $env:PATH
$changedEnvironment = @(
  "DATABASE_URL", "TEST_DATABASE_URL", "MIGRATION_RUNNER_PLAIN_TEST_DATABASE_URL",
  "MIGRATION_RUNNER_TLS_TEST_DATABASE_URL", "MIGRATION_RUNNER_UNTRUSTED_CA_FILE",
  "BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "ALLOWED_ORIGINS", "NODE_ENV", "PORT",
  "DOTENV_CONFIG_PATH", "NODE_EXTRA_CA_CERTS", "RESEND_API_KEY", "CONTACT_FROM_EMAIL",
  "CONTACT_TO_EMAIL", "API_DATABASE_ROLE", "PGHOST", "PGPORT", "PGDATABASE", "PGUSER",
  "PGPASSWORD", "PGPASSFILE", "PGSERVICE", "PGSERVICEFILE", "PGSSLMODE", "PGSSLROOTCERT",
  "PGSSLCERT", "PGSSLKEY", "PGCONNECT_TIMEOUT", "PGDATA"
)
foreach ($name in $changedEnvironment) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }

function New-TestCertificate {
  param(
    [Parameter(Mandatory)] [string] $CommonName,
    [Parameter(Mandatory)] [string] $CertificatePath,
    [string] $KeyPath,
    [Parameter(Mandatory)] [bool] $CertificateAuthority,
    [Parameter(Mandatory)] [bool] $ServerCertificate
  )

  $rsa = [System.Security.Cryptography.RSA]::Create(2048)
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=$CommonName",
    $rsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
  )
  $request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new(
      $CertificateAuthority, $false, 0, $true
    )
  )

  $keyUsage = [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
  if ($CertificateAuthority) {
    $keyUsage = $keyUsage -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor
      [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign
  }
  $request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($keyUsage, $true)
  )

  if ($ServerCertificate) {
    $alternativeNames = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $alternativeNames.AddDnsName("localhost")
    $alternativeNames.AddIpAddress([System.Net.IPAddress]::Loopback)
    $request.CertificateExtensions.Add($alternativeNames.Build())
    $serverAuth = [System.Security.Cryptography.OidCollection]::new()
    $null = $serverAuth.Add([System.Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.1"))
    $request.CertificateExtensions.Add(
      [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($serverAuth, $false)
    )
  }

  $now = [DateTimeOffset]::UtcNow
  $certificate = $request.CreateSelfSigned($now.AddMinutes(-5), $now.AddDays(2))
  [System.IO.File]::WriteAllText(
    $CertificatePath,
    $certificate.ExportCertificatePem(),
    [System.Text.Encoding]::ASCII
  )
  if ($KeyPath) {
    [System.IO.File]::WriteAllText(
      $KeyPath,
      $rsa.ExportPkcs8PrivateKeyPem(),
      [System.Text.Encoding]::ASCII
    )
  }
  $certificate.Dispose()
  $rsa.Dispose()
}

function Invoke-BoundedProcess {
  param(
    [Parameter(Mandatory)] [string] $FilePath,
    [Parameter(Mandatory)] [string[]] $ArgumentList,
    [Parameter(Mandatory)] [string] $Label,
    [Parameter(Mandatory)] [int] $TimeoutSeconds,
    [Parameter(Mandatory)] [string] $WorkingDirectory,
    [switch] $NoCaptureOutput,
    [switch] $AllowNonZeroExit
  )

  Write-Host "[BREAK DISH local test] $Label starting (timeout: $TimeoutSeconds seconds)."
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = -not $NoCaptureOutput
  $startInfo.RedirectStandardError = -not $NoCaptureOutput
  foreach ($argument in $ArgumentList) { [void] $startInfo.ArgumentList.Add($argument) }

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  $processStarted = $false
  try {
    if (-not $process.Start()) {
      $script:failureReason = "process-start-failed"
      throw "$Label could not start."
    }
    $processStarted = $true

    $stdoutTask = $null
    $stderrTask = $null
    if (-not $NoCaptureOutput) {
      $stdoutTask = $process.StandardOutput.ReadToEndAsync()
      $stderrTask = $process.StandardError.ReadToEndAsync()
    }
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $heartbeatSeconds = 15
    $nextHeartbeat = $heartbeatSeconds
    $timedOut = $false
    while (-not $process.WaitForExit(1000)) {
      if ($watch.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
        $timedOut = $true
        $script:failureReason = "process-timeout"
        $script:processExitCode = $null
        try { $process.Kill($true) } catch { }
        $null = $process.WaitForExit(5000)
        break
      }
      if ($watch.Elapsed.TotalSeconds -ge $nextHeartbeat) {
        Write-Host "[BREAK DISH local test] $Label still running ($([int]$watch.Elapsed.TotalSeconds)s elapsed)."
        $nextHeartbeat += $heartbeatSeconds
      }
    }

    if ($timedOut) {
      throw "$Label exceeded its local timeout."
    }

    $process.WaitForExit()
    $exitCode = $process.ExitCode
    $script:processExitCode = $exitCode
    if (-not $NoCaptureOutput) {
      if (-not [System.Threading.Tasks.Task]::WhenAll($stdoutTask, $stderrTask).Wait(5000)) {
        $script:failureReason = "process-output-timeout"
        try { $process.StandardOutput.Close() } catch { }
        try { $process.StandardError.Close() } catch { }
        throw "$Label output streams did not close after the process exited."
      }
      $stdout = $stdoutTask.GetAwaiter().GetResult()
      $stderr = $stderrTask.GetAwaiter().GetResult()
    } else {
      $stdout = ""
      $stderr = ""
    }
    Write-Host "[BREAK DISH local test] $Label finished (exit code: $exitCode)."
    if ($exitCode -ne 0 -and -not $AllowNonZeroExit) {
      $script:failureReason = "process-nonzero-exit"
      $script:processExitCode = $exitCode
    }
    return [pscustomobject]@{
      ExitCode = $exitCode
      StandardOutput = $stdout
      StandardError = $stderr
    }
  } finally {
    if ($processStarted -and $process -and -not $process.HasExited) {
      try { $process.Kill($true) } catch { }
      $null = $process.WaitForExit(5000)
    }
    $process.Dispose()
  }
}

function Invoke-LocalPostgresSql {
  param(
    [Parameter(Mandatory)] [string] $DatabaseName,
    [Parameter(Mandatory)] [string] $Sql,
    [Parameter(Mandatory)] [string] $Label
  )
  $previousSslMode = $env:PGSSLMODE
  try {
    $env:PGSSLMODE = "disable"
    $result = Invoke-BoundedProcess -FilePath $psql -ArgumentList @(
      "-h", "127.0.0.1", "-p", [string] $port, "-U", "postgres", "-d", $DatabaseName,
      "-v", "ON_ERROR_STOP=1", "-c", $Sql
    ) -Label $Label -TimeoutSeconds 20 -WorkingDirectory $apiDirectory -AllowNonZeroExit
    if ($result.ExitCode -ne 0) { throw "Disposable local PostgreSQL fixture setup failed." }
  } finally {
    if ($null -eq $previousSslMode) { Remove-Item Env:PGSSLMODE -ErrorAction SilentlyContinue }
    else { $env:PGSSLMODE = $previousSslMode }
  }
}

function Invoke-ReleaseSafetyVerifier {
  param(
    [Parameter(Mandatory)] [string] $ScriptName,
    [Parameter(Mandatory)] [string] $DatabaseUrl,
    [Parameter(Mandatory)] [string] $ApiRole,
    [Parameter(Mandatory)] [bool] $ExpectedSuccess,
    [Parameter(Mandatory)] [string] $Label
  )
  $env:DATABASE_URL = $DatabaseUrl
  $env:API_DATABASE_ROLE = $ApiRole
  $env:NODE_ENV = "test"
  $result = Invoke-BoundedProcess -FilePath $node -ArgumentList @(
    (Join-Path $apiDirectory $ScriptName)
  ) -Label $Label -TimeoutSeconds 30 -WorkingDirectory $apiDirectory -AllowNonZeroExit
  $json = $null
  try { $json = $result.StandardOutput.Trim() | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "A release verifier returned no safe JSON result." }
  $hasPrivateOutput = $result.StandardOutput.Contains($DatabaseUrl) -or
    $result.StandardOutput.Contains($ApiRole) -or $result.StandardError.Contains($DatabaseUrl) -or
    $result.StandardError.Contains($ApiRole)
  if ($hasPrivateOutput) { throw "A release verifier exposed test connection details." }
  $reportedSuccess = $json.success -eq $true
  if ($ScriptName -eq "verify-db-readonly.mjs") {
    $reportedSuccess = $json.migrationHistoryMatches -eq $true -and
      @($json.missingMigrations).Count -eq 0 -and @($json.unexpectedMigrations).Count -eq 0 -and
      $json.migration012Applied -eq $true -and $json.migration013Applied -eq $false -and
      $json.migrationEntryCount -eq 12 -and $json.raceToColumnsAbsent -eq $true -and
      $json.transactionReadOnly -eq $true -and $json.tlsRequired -eq $false -and $json.tlsEncrypted -eq $false -and
      @($json.missingTables).Count -eq 0 -and @($json.missingViews).Count -eq 0
  } elseif ($ScriptName -in @("verify-db-view-permissions-pre013.mjs", "verify-db-view-permissions-post013.mjs")) {
    $expectedPhase = if ($ScriptName -eq "verify-db-view-permissions-pre013.mjs") { "pre013" } else { "post013" }
    $expectedMigrationCount = if ($expectedPhase -eq "pre013") { 12 } else { 13 }
    $reportedSuccess = $json.success -eq $true -and $json.phase -eq $expectedPhase -and
      $json.migrationCount -eq $expectedMigrationCount -and $json.migrationHistoryMatches -eq $true -and
      @($json.missingMigrations).Count -eq 0 -and @($json.unexpectedMigrations).Count -eq 0 -and
      $json.migration012Applied -eq $true -and $json.migration013Applied -eq ($expectedPhase -eq "post013") -and
        $json.readOnly -eq $true -and $json.tlsEnabled -eq $false -and $json.migrationRoleIsApiRole -eq $false -and
      @($json.failedChecks).Count -eq 0
  }
  if ($ExpectedSuccess) {
    if ($result.ExitCode -ne 0 -or -not $reportedSuccess) {
      $script:failureReason = "release-verifier-rejected"
      $script:processExitCode = $result.ExitCode
      $script:releaseToolDiagnostic = [ordered]@{
        verifier = $ScriptName
        label = $Label
        processExitCode = $result.ExitCode
        failureStage = if ($json.PSObject.Properties.Name -contains "failureStage") { $json.failureStage } else { $null }
        failureCategory = if ($json.PSObject.Properties.Name -contains "failureCategory") { $json.failureCategory } else { $null }
        phase = if ($json.PSObject.Properties.Name -contains "phase") { $json.phase } else { $null }
        success = if ($json.PSObject.Properties.Name -contains "success") { $json.success } else { $null }
        failedChecks = if ($json.PSObject.Properties.Name -contains "failedChecks") { @($json.failedChecks) } else { @() }
        checks = if ($json.PSObject.Properties.Name -contains "checks") { $json.checks } else { $null }
        migrationCount = if ($json.PSObject.Properties.Name -contains "migrationCount") { $json.migrationCount } else { $null }
        migrationHistoryMatches = if ($json.PSObject.Properties.Name -contains "migrationHistoryMatches") { $json.migrationHistoryMatches } else { $null }
        apiRoleExists = if ($json.PSObject.Properties.Name -contains "apiRoleExists") { $json.apiRoleExists } else { $null }
        viewPermissions = if ($json.PSObject.Properties.Name -contains "viewPermissions") { $json.viewPermissions } else { $null }
        migrationRoleIsSuperuser = if ($json.PSObject.Properties.Name -contains "migrationRoleIsSuperuser") { $json.migrationRoleIsSuperuser } else { $null }
        migrationRoleIsApiRole = if ($json.PSObject.Properties.Name -contains "migrationRoleIsApiRole") { $json.migrationRoleIsApiRole } else { $null }
        migrationRoleCanApply013 = if ($json.PSObject.Properties.Name -contains "migrationRoleCanApply013") { $json.migrationRoleCanApply013 } else { $null }
        migrationRoleChecks = if ($json.PSObject.Properties.Name -contains "migrationRoleChecks") { $json.migrationRoleChecks } else { $null }
        migration012SchemaValid = if ($json.PSObject.Properties.Name -contains "migration012SchemaValid") { $json.migration012SchemaValid } else { $null }
        raceToColumnsAbsent = if ($json.PSObject.Properties.Name -contains "raceToColumnsAbsent") { $json.raceToColumnsAbsent } else { $null }
        matchLifecycleTriggersValid = if ($json.PSObject.Properties.Name -contains "matchLifecycleTriggersValid") { $json.matchLifecycleTriggersValid } else { $null }
        readOnly = if ($json.PSObject.Properties.Name -contains "readOnly") { $json.readOnly } else { $null }
        tlsEnabled = if ($json.PSObject.Properties.Name -contains "tlsEnabled") { $json.tlsEnabled } else { $null }
        verifierErrorCode = if ($json.PSObject.Properties.Name -contains "errorCode") { $json.errorCode } else { $null }
        verifierErrorKind = if ($json.PSObject.Properties.Name -contains "errorKind") { $json.errorKind } else { $null }
        verifierUndefinedReference = if ($json.PSObject.Properties.Name -contains "undefinedReference") { $json.undefinedReference } else { $null }
        verifierSourceFile = if ($json.PSObject.Properties.Name -contains "sourceFile") { $json.sourceFile } else { $null }
        verifierSourceFunction = if ($json.PSObject.Properties.Name -contains "sourceFunction") { $json.sourceFunction } else { $null }
        verifierSourceLine = if ($json.PSObject.Properties.Name -contains "sourceLine") { $json.sourceLine } else { $null }
      }
      $failed = @($script:releaseToolDiagnostic.failedChecks)
      if ($failed.Count -gt 0) {
        throw "A local release verifier rejected the disposable database; failed checks: $($failed -join ', ')."
      }
      throw "A local release verifier rejected the disposable database; sanitized details are in the run summary."
    }
  } else {
    if ($result.ExitCode -eq 0 -or $reportedSuccess) { throw "An invalid local release state was accepted." }
  }
  return $json
}

try {
  if ($ReleaseVerifierSummaryOnly -and $ReleaseToolsOnly) {
    $preflightCheck = "test-mode-selection"
    throw "Choose either the verifier summary probe or release-tools-only mode, not both."
  }
  Write-Host "[BREAK DISH local test] Preflight: checking PowerShell and Windows execution context."
  $preflightCheck = "powershell-version"
  $checks.powershell7 = $PSVersionTable.PSVersion.Major -ge 7
  if (-not $checks.powershell7) { throw "PowerShell 7 is required for local certificate generation." }

  $preflightCheck = "execution-identity"
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $checks.nonSandboxIdentity = $identity.Name -notmatch "(?i)\\CodexSandboxOffline$"
  if (-not $checks.nonSandboxIdentity) {
    throw "Run this script from the owner's normal Windows account, not the Codex sandbox account."
  }

  $preflightCheck = "administrator-token"
  $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
  $checks.nonElevatedToken = -not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $checks.nonElevatedToken) {
    throw "Run this script without an elevated Administrator token."
  }

  $preflightCheck = "repository-and-tool-paths"
  Write-Host "[BREAK DISH local test] Preflight: checking the bundled Node.js, PostgreSQL tools and project folders."
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $apiDirectory = Join-Path $repoRoot "api"
  $node = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  $betterAuthCli = Join-Path $apiDirectory "node_modules\auth\dist\index.mjs"
  $postgresBin = Join-Path $repoRoot "tools\postgresql16\pgsql\bin"
  $initdb = Join-Path $postgresBin "initdb.exe"
  $pgctl = Join-Path $postgresBin "pg_ctl.exe"
  $createdb = Join-Path $postgresBin "createdb.exe"
  $psql = Join-Path $postgresBin "psql.exe"
  $postgres = Join-Path $postgresBin "postgres.exe"
  $checks.nodeExecutable = Test-Path -LiteralPath $node -PathType Leaf
  $checks.betterAuthCli = Test-Path -LiteralPath $betterAuthCli -PathType Leaf
  $postgresToolStates = @()
  foreach ($postgresTool in @($postgres, $initdb, $pgctl, $createdb, $psql)) {
    $postgresToolStates += Test-Path -LiteralPath $postgresTool -PathType Leaf
  }
  $checks.postgresqlExecutables = $postgresToolStates -notcontains $false
  $checks.postgresqlPrerequisite = "PostgreSQL 16.15 portable tools must be present under tools/postgresql16/pgsql/bin; binaries are local-only and must not be committed."
  $checks.apiDirectory = Test-Path -LiteralPath $apiDirectory -PathType Container
  if (-not $checks.postgresqlExecutables) {
    $preflightCheck = "postgresql16-portable-binaries"
    throw "PostgreSQL 16.15 tools are missing; see tools/README.md for the local prerequisite."
  }
  if (-not $checks.nodeExecutable -or -not $checks.betterAuthCli -or -not $checks.apiDirectory) {
    throw "A required local test tool or project folder is unavailable."
  }
  Push-Location -LiteralPath $apiDirectory
  $locationPushed = $true

  $preflightCheck = "postgres-version"
  $postgresVersionText = (& $postgres --version 2>&1 | Out-String).Trim()
  if ($postgresVersionText -match "(?i)PostgreSQL\)?\s+(\d+\.\d+)") { $postgresVersion = $Matches[1] }
  $checks.postgresVersion = $postgresVersion -eq "16.15"
  if (-not $checks.postgresVersion) { throw "The bundled local PostgreSQL tools are not version 16.15." }

  $preflightCheck = "local-temp-path"
  Write-Host "[BREAK DISH local test] Preflight: checking the private local temporary location."
  $localAppData = [System.IO.Path]::GetFullPath($env:LOCALAPPDATA)
  $tempBase = [System.IO.Path]::GetFullPath((Join-Path $localAppData "Temp"))
  $checks.localTempOutsideSync = $true
  foreach ($syncRoot in @($env:OneDrive, $env:OneDriveCommercial, $env:OneDriveConsumer)) {
    if ($syncRoot) {
      $syncPath = [System.IO.Path]::GetFullPath($syncRoot).TrimEnd('\') + '\'
      if ($tempBase.StartsWith($syncPath, [StringComparison]::OrdinalIgnoreCase)) {
          $checks.localTempOutsideSync = $false
          throw "The local temp folder resolves inside a synchronized folder."
      }
    }
  }
  if ($tempBase -match "(?i)\\OneDrive(?:\\|$)") {
    $checks.localTempOutsideSync = $false
    throw "The local temp folder resolves inside OneDrive."
  }

  $preflightCheck = "temp-folder-permissions"
  Write-Host "[BREAK DISH local test] Preflight: checking temporary-folder write access."
  $testRoot = Join-Path $tempBase ("breakdish-migration-runner-" + [Guid]::NewGuid().ToString("N"))
  if (Test-Path -LiteralPath $testRoot) { throw "A unique local test folder could not be reserved." }
  $checks.tempFolderCreated = $false
  $null = New-Item -ItemType Directory -Path $testRoot
  $testRootCreated = $true
  [System.IO.File]::WriteAllText((Join-Path $testRoot ".breakdish-test-owner"), $marker, [System.Text.Encoding]::ASCII)
  $checks.tempFolderCreated = $true
  $dataDirectory = Join-Path $testRoot "data"
  $logFile = Join-Path $testRoot "postgres.log"
  $serverCertificate = Join-Path $dataDirectory "server.crt"
  $serverKey = Join-Path $dataDirectory "server.key"
  $untrustedCertificate = Join-Path $testRoot "untrusted-ca.crt"

  $preflightCheck = "loopback-port-selection"
  Write-Host "[BREAK DISH local test] Preflight: reserving a loopback port for the disposable database."
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $checks.loopbackPortSelected = $false
  $listener.Start()
  $port = $listener.LocalEndpoint.Port
  $listener.Stop()
  $checks.loopbackPortSelected = $true

  $stage = "initdb"
  $env:PATH = "$postgresBin;$savedPath"
  $initdbResult = Invoke-BoundedProcess -FilePath $initdb -ArgumentList @(
    "-D", $dataDirectory, "-U", "postgres", "-A", "trust", "--no-locale", "-E", "UTF8"
  ) -Label "initdb" -TimeoutSeconds 120 -WorkingDirectory $apiDirectory
  if ($initdbResult.ExitCode -ne 0) { throw "Disposable PostgreSQL initialization failed." }

  $stage = "test-certificate"
  Write-Host "[BREAK DISH local test] Generating short-lived certificates for local TLS tests."
  New-TestCertificate -CommonName "localhost" -CertificatePath $serverCertificate -KeyPath $serverKey -CertificateAuthority $true -ServerCertificate $true
  New-TestCertificate -CommonName "untrusted.invalid" -CertificatePath $untrustedCertificate -CertificateAuthority $true -ServerCertificate $false
  $configPath = Join-Path $dataDirectory "postgresql.conf"
  $configEncoding = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::AppendAllText(
    $configPath,
    "`nlisten_addresses = '127.0.0.1'`nport = $port`nssl = on`n",
    $configEncoding
  )

  $stage = "postgres-start"
  $startResult = Invoke-BoundedProcess -FilePath $pgctl -ArgumentList @(
    "-D", $dataDirectory, "-l", $logFile, "-w", "-t", "60", "start"
  ) -Label "pg_ctl start" -TimeoutSeconds 75 -WorkingDirectory $apiDirectory -NoCaptureOutput
  if ($startResult.ExitCode -ne 0) {
    $failureReason = "postgres-start-nonzero-exit"
    throw "Disposable PostgreSQL startup failed."
  }

  $stage = "create-test-databases"
  $databaseNames = @(
    "breakdish_api_test",
    "breakdish_migration_plain_test",
    "breakdish_migration_tls_test",
    "breakdish_pre013_test",
    "breakdish_post013_test",
    "breakdish_wrongstate_test",
    "breakdish_verify_test",
    "breakdish_pgdump_backup_test"
  )
  foreach ($databaseName in $databaseNames) {
    $createResult = Invoke-BoundedProcess -FilePath $createdb -ArgumentList @(
      "-h", "127.0.0.1", "-p", [string] $port, "-U", "postgres", $databaseName
    ) -Label "createdb $databaseName" -TimeoutSeconds 20 -WorkingDirectory $apiDirectory
    if ($createResult.ExitCode -ne 0) { throw "A new disposable test database could not be created." }
  }

  $plainUrl = "postgresql://postgres@127.0.0.1:$port/breakdish_migration_plain_test?sslmode=disable"
  $tlsUrl = "postgresql://postgres@127.0.0.1:$port/breakdish_migration_tls_test?sslmode=disable"
  $pre013Url = "postgresql://postgres@127.0.0.1:$port/breakdish_pre013_test?sslmode=disable"
  $post013Url = "postgresql://postgres@127.0.0.1:$port/breakdish_post013_test?sslmode=disable"
  $wrongStateUrl = "postgresql://postgres@127.0.0.1:$port/breakdish_wrongstate_test?sslmode=disable"
  $verifyUrl = "postgresql://postgres@127.0.0.1:$port/breakdish_verify_test?sslmode=disable"
  $backupUrl = "postgresql://postgres@127.0.0.1:$port/breakdish_pgdump_backup_test?sslmode=disable"
  $apiUrl = "postgresql://postgres@127.0.0.1:$port/breakdish_api_test?sslmode=disable"
  $env:DATABASE_URL = $apiUrl
  $env:TEST_DATABASE_URL = $apiUrl
  $env:MIGRATION_RUNNER_PLAIN_TEST_DATABASE_URL = $plainUrl
  $env:MIGRATION_RUNNER_TLS_TEST_DATABASE_URL = $tlsUrl
  $env:MIGRATION_RUNNER_UNTRUSTED_CA_FILE = $untrustedCertificate
  $env:BETTER_AUTH_URL = "http://localhost:3001"
  $env:BETTER_AUTH_SECRET = "local-only-migration-runner-integration-secret-32-characters-minimum"
  $env:ALLOWED_ORIGINS = "http://localhost:5500"
  $env:NODE_ENV = "test"
  $env:PORT = "0"
  $env:DOTENV_CONFIG_PATH = Join-Path $testRoot "no-project-env-file.env"
  $env:NODE_EXTRA_CA_CERTS = $serverCertificate
  Remove-Item Env:RESEND_API_KEY, Env:CONTACT_FROM_EMAIL, Env:CONTACT_TO_EMAIL, Env:API_DATABASE_ROLE -ErrorAction SilentlyContinue
  foreach ($name in @(
    "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGPASSFILE", "PGSERVICE",
    "PGSERVICEFILE", "PGSSLMODE", "PGSSLROOTCERT", "PGSSLCERT", "PGSSLKEY", "PGCONNECT_TIMEOUT", "PGDATA"
  )) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }

  $stage = "better-auth-schema"
  Write-Host "[BREAK DISH local test] Preparing Better Auth tables in each fresh disposable database."
  $authTargets = @(
    [pscustomobject]@{ Label = "Better Auth schema for plain migration database"; Url = $plainUrl },
    [pscustomobject]@{ Label = "Better Auth schema for TLS migration database"; Url = $tlsUrl },
    [pscustomobject]@{ Label = "Better Auth schema for migration 013 preflight database"; Url = $pre013Url },
    [pscustomobject]@{ Label = "Better Auth schema for migration 013 post-check database"; Url = $post013Url },
    [pscustomobject]@{ Label = "Better Auth schema for incorrect-state database"; Url = $wrongStateUrl },
    [pscustomobject]@{ Label = "Better Auth schema for read-only verifier database"; Url = $verifyUrl },
    [pscustomobject]@{ Label = "Better Auth schema for local backup verifier database"; Url = $backupUrl }
  )
  if (-not $ReleaseToolsOnly) {
    $authTargets = @([pscustomobject]@{ Label = "Better Auth schema for API integration database"; Url = $apiUrl }) + $authTargets
  }
  foreach ($target in $authTargets) {
    $env:DATABASE_URL = $target.Url
    $authMigrationResult = Invoke-BoundedProcess -FilePath $node -ArgumentList @(
      $betterAuthCli, "migrate", "--config", "./auth.js", "--yes"
    ) -Label $target.Label -TimeoutSeconds 90 -WorkingDirectory $apiDirectory -AllowNonZeroExit
    if ($authMigrationResult.ExitCode -ne 0) {
      $failureReason = "better-auth-schema-nonzero-exit"
      $processExitCode = $authMigrationResult.ExitCode
      throw "Better Auth schema preparation failed for a disposable local database."
    }
  }
  $checks.betterAuthSchemaPrepared = $true

  if (-not $ReleaseToolsOnly) {
    $stage = "application-schema"
    Write-Host "[BREAK DISH local test] Applying all application migrations to the isolated API integration database."
    $env:DATABASE_URL = $apiUrl
    $applicationMigrationResult = Invoke-BoundedProcess -FilePath $node -ArgumentList @(
      (Join-Path $apiDirectory "migrate.js"), "up"
    ) -Label "application migrations for API integration database" -TimeoutSeconds 180 `
      -WorkingDirectory $apiDirectory -AllowNonZeroExit
    if ($applicationMigrationResult.ExitCode -ne 0) {
      $failureReason = "application-schema-nonzero-exit"
      $processExitCode = $applicationMigrationResult.ExitCode
      throw "Application schema preparation failed for the disposable local API database."
    }
    $checks.applicationSchemaPrepared = $true
  }

  $stage = "release-tool-test-schemas"
  Write-Host "[BREAK DISH local test] Preparing isolated migration 013 pre/post verification databases."
  foreach ($migrationTarget in @(
    [pscustomobject]@{ Label = "pre-013 release tool database"; Url = $pre013Url; Count = "12" },
    [pscustomobject]@{ Label = "post-013 release tool database"; Url = $post013Url; Count = $null },
    [pscustomobject]@{ Label = "read-only verifier database"; Url = $verifyUrl; Count = "12" },
    [pscustomobject]@{ Label = "local backup verifier database"; Url = $backupUrl; Count = $null }
  )) {
    $env:DATABASE_URL = $migrationTarget.Url
    $migrationArgs = @((Join-Path $apiDirectory "migrate.js"), "up")
    if ($migrationTarget.Count) { $migrationArgs += $migrationTarget.Count }
    $migrationResult = Invoke-BoundedProcess -FilePath $node -ArgumentList $migrationArgs `
      -Label "Application migrations for $($migrationTarget.Label)" -TimeoutSeconds 180 `
      -WorkingDirectory $apiDirectory -AllowNonZeroExit
    if ($migrationResult.ExitCode -ne 0) {
      throw "Application schema preparation failed for a disposable release-tool database."
    }
  }

  $verifyIncompleteDatabase = "breakdish_verify_incomplete_test"
  $cloneResult = Invoke-BoundedProcess -FilePath $createdb -ArgumentList @(
    "-h", "127.0.0.1", "-p", [string] $port, "-U", "postgres", "-T", "breakdish_verify_test", $verifyIncompleteDatabase
  ) -Label "Clone disposable baseline for incomplete-schema rejection" -TimeoutSeconds 30 -WorkingDirectory $apiDirectory
  if ($cloneResult.ExitCode -ne 0) { throw "A disposable incomplete-schema verifier fixture could not be created." }
  $verifyIncompleteUrl = "postgresql://postgres@127.0.0.1:$port/$verifyIncompleteDatabase?sslmode=disable"
  $verifyMissingViewDatabase = "breakdish_verify_missing_view_test"
  $cloneViewResult = Invoke-BoundedProcess -FilePath $createdb -ArgumentList @(
    "-h", "127.0.0.1", "-p", [string] $port, "-U", "postgres", "-T", "breakdish_verify_test", $verifyMissingViewDatabase
  ) -Label "Clone disposable baseline for required-view rejection" -TimeoutSeconds 30 -WorkingDirectory $apiDirectory
  if ($cloneViewResult.ExitCode -ne 0) { throw "A disposable required-view verifier fixture could not be created." }
  $verifyMissingViewUrl = "postgresql://postgres@127.0.0.1:$port/$verifyMissingViewDatabase?sslmode=disable"

  $stage = "release-tool-test-permissions"
  Invoke-LocalPostgresSql -DatabaseName "postgres" -Sql `
    "CREATE ROLE breakdish_api_runtime_test NOLOGIN; CREATE ROLE breakdish_api_missing_test NOLOGIN;" `
    -Label "Create disposable API permission test roles"
  $viewGrantSql = "GRANT SELECT ON public.match_scoreboard, public.match_player_statistics, public.practice_player_statistics, public.official_competitive_player_statistics TO breakdish_api_runtime_test;"
  Invoke-LocalPostgresSql -DatabaseName "breakdish_pre013_test" -Sql $viewGrantSql -Label "Grant view access in pre-013 test database"
  Invoke-LocalPostgresSql -DatabaseName "breakdish_post013_test" -Sql `
    ($viewGrantSql + " GRANT SELECT (race_to), INSERT (race_to) ON public.league_match_format_templates TO breakdish_api_runtime_test; GRANT SELECT (race_to), INSERT (race_to), UPDATE (race_to) ON public.match_format_snapshots TO breakdish_api_runtime_test;") `
    -Label "Grant least-privilege Race-to access in post-013 test database"
  Invoke-LocalPostgresSql -DatabaseName "breakdish_pgdump_backup_test" -Sql `
    "CREATE TABLE public.breakdish_backup_probe (id integer PRIMARY KEY);" `
    -Label "Prepare disposable archive-list probe table"

  if ($ReleaseVerifierSummaryOnly) {
    $stage = "release-verifier-summary-reproduction"
    Write-Host "[BREAK DISH local test] Running only the pre-013 and post-013 permission verifiers against disposable databases, before cleanup."
    $null = Invoke-ReleaseSafetyVerifier -ScriptName "verify-db-view-permissions-pre013.mjs" `
      -DatabaseUrl $pre013Url -ApiRole "breakdish_api_runtime_test" -ExpectedSuccess $true `
      -Label "Targeted pre-013 verifier and competitive-statistics summary reproduction"
    $null = Invoke-ReleaseSafetyVerifier -ScriptName "verify-db-view-permissions-post013.mjs" `
      -DatabaseUrl $post013Url -ApiRole "breakdish_api_runtime_test" -ExpectedSuccess $true `
      -Label "Targeted post-013 column privilege and summary verification"
    $checks.releaseVerifierSummaryProbe = $true
    $success = $true
  } else {
  $stage = "release-tool-verification-tests"
  Write-Host "[BREAK DISH local test] Exercising read-only migration-baseline and separate API-role permission checks."
  $env:DATABASE_URL = $verifyUrl
  $env:API_DATABASE_ROLE = "breakdish_api_runtime_test"
  $env:NODE_ENV = "test"
  $verifyReadOnlyPre = Invoke-ReleaseSafetyVerifier -ScriptName "verify-db-readonly.mjs" `
    -DatabaseUrl $verifyUrl -ApiRole "breakdish_api_runtime_test" -ExpectedSuccess $true `
    -Label "Read-only verification of migrations 001-012"
  Invoke-LocalPostgresSql -DatabaseName "breakdish_verify_test" `
    -Sql "DELETE FROM public.breakdish_app_migrations WHERE name = '012_test_only_practice_matches';" `
    -Label "Remove migration 012 temporarily in disposable read-only-verifier database"
  $rejectMissing012 = Invoke-ReleaseSafetyVerifier -ScriptName "verify-db-readonly.mjs" `
    -DatabaseUrl $verifyUrl -ApiRole "breakdish_api_runtime_test" -ExpectedSuccess $false `
    -Label "Reject missing migration 012 from the pre-013 read-only verifier"
  Invoke-LocalPostgresSql -DatabaseName "breakdish_verify_test" `
    -Sql "INSERT INTO public.breakdish_app_migrations (name, run_on) VALUES ('012_test_only_practice_matches', NOW());" `
    -Label "Restore migration 012 in disposable read-only-verifier database"
  Invoke-LocalPostgresSql -DatabaseName "breakdish_verify_test" `
    -Sql "INSERT INTO public.breakdish_app_migrations (name, run_on) VALUES ('099_unexpected_test_only', NOW());" `
    -Label "Insert unexpected migration in disposable read-only-verifier database"
  $rejectUnexpectedReadonlyMigration = Invoke-ReleaseSafetyVerifier -ScriptName "verify-db-readonly.mjs" `
    -DatabaseUrl $verifyUrl -ApiRole "breakdish_api_runtime_test" -ExpectedSuccess $false `
    -Label "Reject unexpected migration from the pre-013 read-only verifier"
  Invoke-LocalPostgresSql -DatabaseName "breakdish_verify_test" `
    -Sql "DELETE FROM public.breakdish_app_migrations WHERE name = '099_unexpected_test_only';" `
    -Label "Remove unexpected migration from disposable read-only-verifier database"
  $verifyReadOnlyRestored = Invoke-ReleaseSafetyVerifier -ScriptName "verify-db-readonly.mjs" `
    -DatabaseUrl $verifyUrl -ApiRole "breakdish_api_runtime_test" -ExpectedSuccess $true `
    -Label "Reaccept the restored exact 001-012 baseline"
  Invoke-LocalPostgresSql -DatabaseName $verifyIncompleteDatabase `
    -Sql 'DROP TABLE public."rateLimit";' -Label "Remove expected object from cloned disposable database"
  $rejectIncompleteReadonlySchema = Invoke-ReleaseSafetyVerifier -ScriptName "verify-db-readonly.mjs" `
    -DatabaseUrl $verifyIncompleteUrl -ApiRole "breakdish_api_runtime_test" -ExpectedSuccess $false `
    -Label "Reject incomplete schema from the pre-013 read-only verifier"
  Invoke-LocalPostgresSql -DatabaseName $verifyMissingViewDatabase `
    -Sql "DROP VIEW public.match_scoreboard CASCADE;" -Label "Remove required public view from cloned disposable database"
  $rejectMissingReadonlyView = Invoke-ReleaseSafetyVerifier -ScriptName "verify-db-readonly.mjs" `
    -DatabaseUrl $verifyMissingViewUrl -ApiRole "breakdish_api_runtime_test" -ExpectedSuccess $false `
    -Label "Reject missing required view from the pre-013 read-only verifier"
  $verifyReadOnlyPostRejected = Invoke-ReleaseSafetyVerifier -ScriptName "verify-db-readonly.mjs" `
    -DatabaseUrl $post013Url -ApiRole "breakdish_api_runtime_test" -ExpectedSuccess $false `
    -Label "Reject migration 013 from the pre-013 read-only verifier"
  $verifyPre013 = Invoke-ReleaseSafetyVerifier -ScriptName "verify-db-view-permissions-pre013.mjs" `
    -DatabaseUrl $pre013Url -ApiRole "breakdish_api_runtime_test" -ExpectedSuccess $true `
    -Label "Pre-013 permission and migration-role preflight"
  $verifyPost013 = Invoke-ReleaseSafetyVerifier -ScriptName "verify-db-view-permissions-post013.mjs" `
    -DatabaseUrl $post013Url -ApiRole "breakdish_api_runtime_test" -ExpectedSuccess $true `
    -Label "Post-013 schema and separate API-role verification"
  $rejectPremature013 = Invoke-ReleaseSafetyVerifier -ScriptName "verify-db-view-permissions-pre013.mjs" `
    -DatabaseUrl $post013Url -ApiRole "breakdish_api_runtime_test" -ExpectedSuccess $false `
    -Label "Reject a post-013 database in the preflight check"
  $rejectMissing013 = Invoke-ReleaseSafetyVerifier -ScriptName "verify-db-view-permissions-post013.mjs" `
    -DatabaseUrl $pre013Url -ApiRole "breakdish_api_runtime_test" -ExpectedSuccess $false `
    -Label "Reject a pre-013 database in the post-migration check"
  $rejectMissingApiGrants = Invoke-ReleaseSafetyVerifier -ScriptName "verify-db-view-permissions-post013.mjs" `
    -DatabaseUrl $post013Url -ApiRole "breakdish_api_missing_test" -ExpectedSuccess $false `
    -Label "Reject missing API view and Race-to column grants"
  $rejectWrongDatabaseState = Invoke-ReleaseSafetyVerifier -ScriptName "verify-db-view-permissions-post013.mjs" `
    -DatabaseUrl $wrongStateUrl -ApiRole "breakdish_api_runtime_test" -ExpectedSuccess $false `
    -Label "Reject an incomplete database schema"

  Invoke-LocalPostgresSql -DatabaseName "breakdish_post013_test" `
    -Sql "GRANT SELECT ON public.match_scoreboard TO PUBLIC;" `
    -Label "Introduce a temporary public grant on a protected disposable view"
  $rejectPublicViewAccess = Invoke-ReleaseSafetyVerifier -ScriptName "verify-db-view-permissions-post013.mjs" `
    -DatabaseUrl $post013Url -ApiRole "breakdish_api_runtime_test" -ExpectedSuccess $false `
    -Label "Reject public access to a protected view"
  Invoke-LocalPostgresSql -DatabaseName "breakdish_post013_test" `
    -Sql "REVOKE SELECT ON public.match_scoreboard FROM PUBLIC;" `
    -Label "Restore protected view least-privilege state"

  Invoke-LocalPostgresSql -DatabaseName "breakdish_post013_test" `
    -Sql "ALTER TABLE public.match_format_snapshots DROP CONSTRAINT match_format_snapshot_race_to_valid; ALTER TABLE public.match_format_snapshots ADD CONSTRAINT match_format_snapshot_race_to_valid CHECK (race_to IS NULL OR race_to BETWEEN 1 AND 249);" `
    -Label "Weaken Race-to constraint temporarily in disposable database"
  $rejectIncorrectConstraint = Invoke-ReleaseSafetyVerifier -ScriptName "verify-db-view-permissions-post013.mjs" `
    -DatabaseUrl $post013Url -ApiRole "breakdish_api_runtime_test" -ExpectedSuccess $false `
    -Label "Reject an incorrect Race-to constraint"
  Invoke-LocalPostgresSql -DatabaseName "breakdish_post013_test" `
    -Sql "ALTER TABLE public.match_format_snapshots DROP CONSTRAINT match_format_snapshot_race_to_valid; ALTER TABLE public.match_format_snapshots ADD CONSTRAINT match_format_snapshot_race_to_valid CHECK (race_to IS NULL OR race_to BETWEEN 1 AND 250);" `
    -Label "Restore Race-to constraint in disposable database"
  $verifyPost013Restored = Invoke-ReleaseSafetyVerifier -ScriptName "verify-db-view-permissions-post013.mjs" `
    -DatabaseUrl $post013Url -ApiRole "breakdish_api_runtime_test" -ExpectedSuccess $true `
    -Label "Reaccept restored Race-to schema and permission state"

  Invoke-LocalPostgresSql -DatabaseName "breakdish_post013_test" `
    -Sql "INSERT INTO public.breakdish_app_migrations (name, run_on) VALUES ('099_unexpected_test_only', NOW());" `
    -Label "Insert temporary unexpected migration row in disposable database"
  $rejectUnexpectedMigration = Invoke-ReleaseSafetyVerifier -ScriptName "verify-db-view-permissions-post013.mjs" `
    -DatabaseUrl $post013Url -ApiRole "breakdish_api_runtime_test" -ExpectedSuccess $false `
    -Label "Reject unexpected migration history"
  Invoke-LocalPostgresSql -DatabaseName "breakdish_post013_test" `
    -Sql "DELETE FROM public.breakdish_app_migrations WHERE name = '099_unexpected_test_only';" `
    -Label "Remove temporary unexpected migration row from disposable database"

  $stage = "local-backup-helper-test"
  Write-Host "[BREAK DISH local test] Exercising the backup helper only against disposable local PostgreSQL."
  $backupHelper = Join-Path $repoRoot "tools\backup-production.ps1"
  $backupResult = $null
  $backupSource = Get-Content -LiteralPath $backupHelper -Raw
  if ($backupSource -notmatch "run-folder-unique" -or $backupSource -notmatch "backup-file-unique" -or
      -not ($backupSource.Contains("-Executable " + '$pgRestore' + " -Arguments @(") -and $backupSource.Contains("'--list'"))) {
    throw "The backup helper is missing its unique-path or archive-list safeguards."
  }
  $backupStorage = Join-Path $testRoot "backup-helper-storage"
  $null = New-Item -ItemType Directory -Path $backupStorage
  $savedTemp = $env:TEMP
  $sentinelDirectory = Join-Path $backupStorage "existing-backup-preserve"
  $sentinelFile = Join-Path $sentinelDirectory "existing.dump"
  $sentinelHash = $null
  try {
    $null = New-Item -ItemType Directory -Path $sentinelDirectory
    [System.IO.File]::WriteAllText($sentinelFile, "local-test-sentinel-$marker", [System.Text.Encoding]::ASCII)
    $sentinelHash = (Get-FileHash -LiteralPath $sentinelFile -Algorithm SHA256).Hash
    $env:TEMP = $backupStorage
    $env:DATABASE_URL = $backupUrl
    try { $backupResult = (& $backupHelper -LocalTestOnly | Out-String | ConvertFrom-Json -ErrorAction Stop) }
    catch { throw "The local-only backup helper returned no safe JSON result." }
    if ($backupResult.success -ne $true -or $backupResult.archiveVerified -ne $true -or
        $backupResult.localTestArchiveDeleted -ne $true -or $backupResult.credentialsCleared -ne $true -or
        $backupResult.localTestArchiveSizeBytes -le 0 -or $backupResult.backupPath -or $backupResult.backupSizeBytes) {
      throw "The disposable local backup helper archive verification did not pass safely."
    }
    if (-not [string]::IsNullOrEmpty($env:DATABASE_URL)) {
      throw "The local backup helper left its synthetic database URL in the process environment."
    }
    if (-not (Test-Path -LiteralPath $sentinelFile -PathType Leaf) -or
        (Get-FileHash -LiteralPath $sentinelFile -Algorithm SHA256).Hash -ne $sentinelHash) {
      throw "The local backup helper changed an existing file in its output root."
    }

    $env:DATABASE_URL = "postgresql://breakdish_release_backup_missing_role@127.0.0.1:$port/breakdish_pgdump_backup_test?sslmode=disable"
    $failedBackupResult = $null
    try { $failedBackupResult = (& $backupHelper -LocalTestOnly | Out-String | ConvertFrom-Json -ErrorAction Stop) }
    catch { throw "The failed local backup attempt returned no safe JSON result." }
    if ($failedBackupResult.success -ne $false -or $failedBackupResult.failureStage -ne "pg-dump" -or
        $failedBackupResult.safeCategory -ne "authentication" -or $failedBackupResult.credentialsCleared -ne $true -or
        $failedBackupResult.failedOutputRemoved -ne $true -or $failedBackupResult.backupPath -or
        $failedBackupResult.backupSizeBytes) {
      throw "The local backup helper did not fail safely or clean up its partial output."
    }
    $failedBackupSafeJson = $failedBackupResult | ConvertTo-Json -Compress -Depth 6
    if ($failedBackupSafeJson -match "breakdish_release_backup_missing_role|postgresql://|127\.0\.0\.1|pg_dump:|FATAL:") {
      throw "The failed local backup helper exposed raw connection or process details."
    }
    if (-not [string]::IsNullOrEmpty($env:DATABASE_URL)) {
      throw "The failed local backup helper left its synthetic database URL in the process environment."
    }
    $failedBackupSafeJson = $null
    if (-not (Test-Path -LiteralPath $sentinelFile -PathType Leaf) -or
        (Get-FileHash -LiteralPath $sentinelFile -Algorithm SHA256).Hash -ne $sentinelHash) {
      throw "The failed local backup attempt changed an existing file in its output root."
    }
  } finally {
    $env:TEMP = $savedTemp
    if ($sentinelDirectory -and (Test-Path -LiteralPath $sentinelDirectory)) {
      Remove-Item -LiteralPath $sentinelDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  Invoke-LocalPostgresSql -DatabaseName "breakdish_post013_test" `
    -Sql "ALTER TABLE public.league_match_format_templates DROP COLUMN race_to CASCADE;" `
    -Label "Remove Race-to column from disposable database to test schema rejection"
  $rejectMissingRaceColumn = Invoke-ReleaseSafetyVerifier -ScriptName "verify-db-view-permissions-post013.mjs" `
    -DatabaseUrl $post013Url -ApiRole "breakdish_api_runtime_test" -ExpectedSuccess $false `
    -Label "Reject a missing Race-to column"

  $env:DATABASE_URL = $apiUrl
  $env:TEST_DATABASE_URL = $apiUrl
  Remove-Item Env:API_DATABASE_ROLE -ErrorAction SilentlyContinue

  $stage = "syntax-checks"
  foreach ($scriptPath in @(
    (Join-Path $repoRoot "script.js"),
    (Join-Path $apiDirectory "migrate.js"),
    (Join-Path $apiDirectory "migrate.test.js"),
    (Join-Path $apiDirectory "db-view-permissions-verifier.mjs"),
    (Join-Path $apiDirectory "release-migration-baseline.mjs"),
    (Join-Path $apiDirectory "verify-db-readonly.mjs"),
    (Join-Path $apiDirectory "verify-db-view-permissions-pre012.mjs"),
    (Join-Path $apiDirectory "verify-db-view-permissions-post012.mjs"),
    (Join-Path $apiDirectory "verify-db-view-permissions-pre013.mjs"),
    (Join-Path $apiDirectory "verify-db-view-permissions-post013.mjs")
  )) {
    $syntaxResult = Invoke-BoundedProcess -FilePath $node -ArgumentList @("--check", $scriptPath) `
      -Label ("node --check " + [System.IO.Path]::GetFileName($scriptPath)) -TimeoutSeconds 20 -WorkingDirectory $apiDirectory
    if ($syntaxResult.ExitCode -ne 0) { throw "A required JavaScript syntax check failed." }
  }

  if ($ReleaseToolsOnly) {
    $stage = "release-tool-unit-tests"
    $releaseUnitResult = Invoke-BoundedProcess -FilePath $node -ArgumentList @(
      "--test", "db-view-permissions-verifier.test.js"
    ) -Label "Release verifier unit tests" -TimeoutSeconds 60 -WorkingDirectory $apiDirectory -AllowNonZeroExit
    if ($releaseUnitResult.ExitCode -ne 0) { throw "Release verifier unit tests failed." }
    $checks.releaseToolUnitTestsPassed = $true
  }

  if ($ReleaseToolsOnly) {
    $checks.applicationSuiteSkippedForReleaseToolsOnly = $true
    Write-Host "[BREAK DISH local test] Release-tools-only mode: application integration suite not rerun."
  } else {
  $stage = "api-test-suite"
  $testResult = Invoke-BoundedProcess -FilePath $node -ArgumentList @("--test") `
    -Label "Node.js API and PostgreSQL test suite" -TimeoutSeconds 300 -WorkingDirectory $apiDirectory -AllowNonZeroExit
  $testExitCode = $testResult.ExitCode
  $testText = $testResult.StandardOutput + [Environment]::NewLine + $testResult.StandardError
  Write-Output $testText
  if ($testExitCode -ne 0) {
    $failureReason = "test-suite-nonzero-exit"
    $processExitCode = $testExitCode
    throw "The PostgreSQL-backed API test suite failed."
  }

  $summaryText = $testText -replace "`r", ""
  $testCount = if ($summaryText -match "(?m)^.*tests (\d+)$") { [int]$Matches[1] } else { $null }
  $passedCount = if ($summaryText -match "(?m)^.*pass (\d+)$") { [int]$Matches[1] } else { $null }
  $failedCount = if ($summaryText -match "(?m)^.*fail (\d+)$") { [int]$Matches[1] } else { $null }
  $skippedCount = if ($summaryText -match "(?m)^.*skipped (\d+)$") { [int]$Matches[1] } else { $null }
  if ($null -eq $testCount -or $failedCount -ne 0 -or $skippedCount -ne 0) {
    throw "The full test output did not report zero failures and zero skips."
  }
  }

  $stage = "git-diff-check"
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($git) {
    $diffResult = Invoke-BoundedProcess -FilePath $git.Source -ArgumentList @("-C", $repoRoot, "diff", "--check") `
      -Label "git diff --check" -TimeoutSeconds 20 -WorkingDirectory $repoRoot
    if ($diffResult.ExitCode -ne 0) { throw "git diff --check failed." }
  }
  $success = $true
  }
} catch {
  $success = $false
  if (-not $failureReason) { $failureReason = "step-failed" }
  $failedLabel = if ($stage -eq "preflight") { $preflightCheck } else { $stage }
  Write-Host "[BREAK DISH local test] Stopped at $failedLabel ($failureReason)."
} finally {
  if ($locationPushed) { Pop-Location }
  foreach ($name in $changedEnvironment) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
  $env:PATH = $savedPath

  if ($dataDirectory -and (Test-Path -LiteralPath $dataDirectory)) {
    $cleanupPgctl = Join-Path (Split-Path -Parent $initdb) "pg_ctl.exe"
    $serverRunning = $true
    try {
      $statusResult = Invoke-BoundedProcess -FilePath $cleanupPgctl -ArgumentList @("-D", $dataDirectory, "status") `
        -Label "cleanup status check" -TimeoutSeconds 10 -WorkingDirectory $apiDirectory -AllowNonZeroExit
      if ($statusResult.ExitCode -eq 0) {
        $serverRunning = $true
      } elseif ($statusResult.ExitCode -eq 3) {
        $serverRunning = $false
        Write-Host "[BREAK DISH local test] Disposable PostgreSQL is already stopped (pg_ctl status code 3)."
      } else {
        $serverRunning = $true
        $cleanupPending = $true
        Write-Host "[BREAK DISH local test] PostgreSQL status is indeterminate; preserving the private test folder until cleanup can be confirmed."
      }
    } catch {
      $serverRunning = $true
      $cleanupPending = $true
    }
    if ($serverRunning) {
      Write-Host "[BREAK DISH local test] Stopping only the disposable PostgreSQL instance created for this run."
      try {
        $stopResult = Invoke-BoundedProcess -FilePath $cleanupPgctl -ArgumentList @(
          "-D", $dataDirectory, "-m", "fast", "-w", "-t", "20", "stop"
        ) -Label "pg_ctl fast stop" -TimeoutSeconds 25 -WorkingDirectory $apiDirectory -AllowNonZeroExit
        if ($stopResult.ExitCode -ne 0) {
          $stopResult = Invoke-BoundedProcess -FilePath $cleanupPgctl -ArgumentList @(
            "-D", $dataDirectory, "-m", "immediate", "-w", "-t", "10", "stop"
          ) -Label "pg_ctl immediate stop" -TimeoutSeconds 15 -WorkingDirectory $apiDirectory -AllowNonZeroExit
        }
        $statusResult = Invoke-BoundedProcess -FilePath $cleanupPgctl -ArgumentList @("-D", $dataDirectory, "status") `
          -Label "cleanup status recheck" -TimeoutSeconds 10 -WorkingDirectory $apiDirectory -AllowNonZeroExit
        if ($statusResult.ExitCode -eq 0) {
          $serverRunning = $true
          $cleanupPending = $true
        } elseif ($statusResult.ExitCode -eq 3) {
          $serverRunning = $false
          $cleanupPending = $false
          Write-Host "[BREAK DISH local test] Disposable PostgreSQL is stopped (pg_ctl status code 3)."
        } else {
          $serverRunning = $true
          $cleanupPending = $true
          Write-Host "[BREAK DISH local test] PostgreSQL status is indeterminate; preserving the private test folder."
        }
      } catch {
        $serverRunning = $true
        $cleanupPending = $true
      }
    }
    if ($serverRunning) { $cleanupPending = $true }
  }

  $tempRemoved = $false
  if ($testRoot -and (Test-Path -LiteralPath $testRoot) -and -not $cleanupPending) {
    $resolvedRoot = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $testRoot).Path)
    $resolvedTemp = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Temp")).TrimEnd('\') + '\'
    $markerPath = Join-Path $resolvedRoot ".breakdish-test-owner"
    $markerMatches = (Test-Path -LiteralPath $markerPath -PathType Leaf) -and
      ([System.IO.File]::ReadAllText($markerPath) -eq $marker)
    if ($resolvedRoot.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and ($markerMatches -or $testRootCreated)) {
      Remove-Item -LiteralPath $resolvedRoot -Recurse -Force -ErrorAction SilentlyContinue
      $tempRemoved = -not (Test-Path -LiteralPath $resolvedRoot)
    }
  }
}

$summary = [ordered]@{
  success = $success
  releaseToolsOnly = [bool] $ReleaseToolsOnly
  failureStage = if ($success) { $null } else { $stage }
  failedCheck = if ($success) { $null } elseif ($stage -eq "preflight") { $preflightCheck } else { $stage }
  failureReason = if ($success) { $null } else { $failureReason }
  processExitCode = $processExitCode
  releaseToolDiagnostic = if ($success) { $null } else { $releaseToolDiagnostic }
  powershellMajorVersion = $PSVersionTable.PSVersion.Major
  postgresVersion = $postgresVersion
  checks = $checks
  tests = if ($success) { $testCount } else { $testCount }
  passed = if ($success) { $passedCount } else { $passedCount }
  failed = if ($success) { $failedCount } elseif ($stage -eq "api-test-suite") { $failedCount } else { $null }
  skipped = if ($success) { $skippedCount } else { $skippedCount }
  disposableServerStopped = -not $cleanupPending
  temporaryTestFolderRemoved = if ($testRoot) { $tempRemoved } else { $null }
  productionConnectionUsed = $false
}
Write-Output ($summary | ConvertTo-Json -Compress)
if (-not $success -or $cleanupPending -or -not $tempRemoved) { exit 1 }
