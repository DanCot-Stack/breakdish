param(
    [switch]$LocalTestOnly
)

$ErrorActionPreference = 'Stop'
$script:summary = [ordered]@{
    success = $false
    failureStage = $null
    failureCheck = $null
    safeCategory = $null
    targetChecks = $null
    productionPreflightPassed = $false
    database = $null
    postgresVersion = $null
    migrationEntryCount = $null
    migration012Applied = $null
    migration013Applied = $null
    tlsEncrypted = $false
    backupTlsMode = $null
    archiveVerified = $false
    backupPath = $null
    backupSizeBytes = $null
    credentialsCleared = $false
    localTestArchiveDeleted = $null
    localTestArchiveSizeBytes = $null
    failedOutputRemoved = $null
}
$script:databaseUrlText = $null
$script:databaseUser = $null
$script:databasePassword = $null
$script:rawStdout = $null
$script:rawStderr = $null
$script:backupDirectory = $null
$script:backupFile = $null
$script:backupDirectoryCreated = $false
$script:success = $false
$script:targetChecks = [ordered]@{
    urlPresent = $false
    urlParsed = $false
    postgresScheme = $false
    renderHostMatched = $false
    databaseNameMatched = $false
    portAccepted = $false
    credentialsPresent = $false
}
$script:failureCheck = 'url-present'

function ConvertTo-BreakDishWindowsArgument {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $slashes++
            continue
        }
        if ($character -eq '"') {
            if ($slashes -gt 0) { [void]$builder.Append(('\' * (2 * $slashes + 1))) }
            else { [void]$builder.Append('\') }
            [void]$builder.Append('"')
            $slashes = 0
            continue
        }
        if ($slashes -gt 0) { [void]$builder.Append(('\' * $slashes)) }
        [void]$builder.Append($character)
        $slashes = 0
    }
    if ($slashes -gt 0) { [void]$builder.Append(('\' * (2 * $slashes))) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Invoke-BreakDishNativeProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][hashtable]$EnvironmentVariables,
        [int]$TimeoutMilliseconds = 120000
    )

    $process = $null
    $stdoutTask = $null
    $stderrTask = $null
    $stdoutText = $null
    $stderrText = $null
    try {
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $Executable
        $startInfo.Arguments = [string]::Join(' ', @($Arguments | ForEach-Object { ConvertTo-BreakDishWindowsArgument -Value ([string]$_) }))
        $startInfo.WorkingDirectory = $WorkingDirectory
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true

        # Do not let ambient libpq settings or DATABASE_URL alter this child process.
        $childEnvironment = $startInfo.EnvironmentVariables
        foreach ($name in @($childEnvironment.Keys)) {
            if ([string]$name -match '^(?i)PG') { [void]$childEnvironment.Remove([string]$name) }
        }
        [void]$childEnvironment.Remove('DATABASE_URL')
        foreach ($entry in $EnvironmentVariables.GetEnumerator()) {
            $childEnvironment[[string]$entry.Key] = [string]$entry.Value
        }

        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo
        if (-not $process.Start()) {
            return @{ started = $false; exitCode = $null; timedOut = $false; stdout = ''; stderr = '' }
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $timedOut = -not $process.WaitForExit($TimeoutMilliseconds)
        if ($timedOut) {
            try { $process.Kill() } catch { }
            $process.WaitForExit()
        }
        $stdoutText = $stdoutTask.GetAwaiter().GetResult()
        $stderrText = $stderrTask.GetAwaiter().GetResult()
        return @{
            started = $true
            exitCode = [int]$process.ExitCode
            timedOut = $timedOut
            stdout = $stdoutText
            stderr = $stderrText
        }
    }
    catch {
        return @{ started = $false; exitCode = $null; timedOut = $false; stdout = ''; stderr = '' }
    }
    finally {
        if ($process) { $process.Dispose() }
        $stdoutTask = $null
        $stderrTask = $null
        $stdoutText = $null
        $stderrText = $null
    }
}

function Get-BreakDishSafeFailureCategory {
    param([AllowNull()][string]$Diagnostic)

    if ([string]::IsNullOrEmpty($Diagnostic)) { return 'other' }
    if ($Diagnostic -match '(?i)(password authentication failed|no password supplied|authentication failed|no pg_hba\.conf entry|role .* does not exist|SASL authentication|SCRAM authentication)') { return 'authentication' }
    if ($Diagnostic -match '(?i)(certificate|SSL|TLS|sslmode|handshake)') { return 'tls' }
    if ($Diagnostic -match '(?i)(could not translate host name|name or service not known|temporary failure in name resolution|getaddrinfo)') { return 'dns' }
    if ($Diagnostic -match '(?i)(timeout expired|connection timed out|operation timed out|timed out)') { return 'timeout' }
    if ($Diagnostic -match '(?i)(connection reset|server closed the connection unexpectedly|connection terminated unexpectedly|connection refused|could not connect to server)') { return 'connection' }
    if ($Diagnostic -match '(?i)(too many connections|remaining connection slots|too many clients|connection limit exceeded)') { return 'server-capacity' }
    if ($Diagnostic -match '(?i)(database .* does not exist|invalid catalog name|database system is starting up|database system is shutting down)') { return 'database-target' }
    if ($Diagnostic -match '(?i)(server version mismatch|server version .*not supported|server version .*too new)') { return 'server-version' }
    if ($Diagnostic -match '(?i)(permission denied|must be owner of|insufficient privilege|not permitted|must be superuser)') { return 'database-permission' }
    if ($Diagnostic -match '(?i)(could not open output file|could not create .*file|access is denied|no space left on device|disk full|could not write .*file)') { return 'local-storage' }
    if ($Diagnostic -match '(?i)(unrecognized option|invalid option|unsupported archive format|could not execute.*pg_dump)') { return 'tool-configuration' }
    if ($Diagnostic -match '(?i)(ERROR:|FATAL:|SQLSTATE|SQL state|query failed|could not execute query)') { return 'database-query' }
    return 'other'
}

function Set-BreakDishPrivateDirectoryAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($userSid)
    $acl.SetAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($userSid, [Security.AccessControl.FileSystemRights]::FullControl, ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)))
    $acl.SetAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($systemSid, [Security.AccessControl.FileSystemRights]::FullControl, ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)))
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop

    $verified = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $rules = @($verified.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
    $allowedSids = @($rules | Where-Object { $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow } | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
    if (-not $verified.AreAccessRulesProtected -or $allowedSids.Count -ne 2 -or
        $allowedSids -notcontains $userSid.Value -or $allowedSids -notcontains $systemSid.Value) {
        throw 'private-acl'
    }
}

function Test-BreakDishPathIsPrivateLocal {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$ProjectRoot)

    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $project = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if ($fullPath.StartsWith($project, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    if ($fullPath -match '(?i)(^|[\\/])(OneDrive[^\\/]*|Dropbox|Google Drive|iCloudDrive|SharePoint)([\\/]|$)') { return $false }
    return $true
}

function Clear-BreakDishCredentialEnvironment {
    $clearOk = $true
    try { [Environment]::SetEnvironmentVariable('DATABASE_URL', $null, 'Process') }
    catch { $clearOk = $false }
    foreach ($name in @('PGPASSWORD', 'PGPASSFILE', 'PGSERVICEFILE')) {
        try { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
        catch { $clearOk = $false }
    }
    foreach ($name in @('DATABASE_URL', 'PGPASSWORD', 'PGPASSFILE', 'PGSERVICEFILE')) {
        if (-not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($name, 'Process'))) { $clearOk = $false }
    }
    return $clearOk
}

try {
    $stage = 'input'
    $script:databaseUrlText = [Environment]::GetEnvironmentVariable('DATABASE_URL', 'Process')
    $script:targetChecks.urlPresent = -not [string]::IsNullOrWhiteSpace($script:databaseUrlText)
    if ([string]::IsNullOrWhiteSpace($script:databaseUrlText)) { throw 'missing-url' }

    $uri = $null
    $script:failureCheck = 'url-parse'
    if (-not [Uri]::TryCreate($script:databaseUrlText, [UriKind]::Absolute, [ref]$uri)) { throw 'invalid-url' }
    $script:targetChecks.urlParsed = $true
    $databaseName = [Uri]::UnescapeDataString($uri.AbsolutePath.Trim('/'))
    $protocolValid = @('postgres', 'postgresql') -contains $uri.Scheme
    $script:targetChecks.postgresScheme = $protocolValid
    $script:targetChecks.renderHostMatched = $uri.DnsSafeHost.EndsWith('.render.com', [StringComparison]::OrdinalIgnoreCase)
    $script:targetChecks.databaseNameMatched = $databaseName -eq 'breakdish'
    $localTarget = $uri.DnsSafeHost -eq '127.0.0.1' -and $databaseName -eq 'breakdish_pgdump_backup_test'
    $productionTarget = $script:targetChecks.renderHostMatched -and $script:targetChecks.databaseNameMatched
    $script:failureCheck = 'expected-scheme-host-database'
    if (-not $protocolValid -or (($LocalTestOnly -and -not $localTarget) -or (-not $LocalTestOnly -and -not $productionTarget))) { throw 'target' }
    # PostgreSQL URLs commonly omit :5432. .NET Uri reports -1 for an
    # unspecified port on the postgres/postgresql schemes, so mirror the
    # successful diagnostic's explicit default while still rejecting bad ports.
    $validatedPort = if ($uri.IsDefaultPort) { 5432 } else { [int]$uri.Port }
    $script:failureCheck = 'port'
    if ($validatedPort -lt 1 -or $validatedPort -gt 65535) { throw 'target' }
    $script:targetChecks.portAccepted = $true
    $script:failureCheck = 'credentials-shape'
    $colon = $uri.UserInfo.IndexOf(':')
    $userInfo = $uri.UserInfo
    if ($colon -lt 1) {
        if (-not $LocalTestOnly -or [string]::IsNullOrWhiteSpace($userInfo)) { throw 'target' }
        $script:databaseUser = [Uri]::UnescapeDataString($userInfo)
        $script:databasePassword = ''
    }
    else {
        $script:databaseUser = [Uri]::UnescapeDataString($userInfo.Substring(0, $colon))
        $script:databasePassword = [Uri]::UnescapeDataString($userInfo.Substring($colon + 1))
    }
    if ([string]::IsNullOrWhiteSpace($script:databaseUser) -or (-not $LocalTestOnly -and [string]::IsNullOrEmpty($script:databasePassword))) { throw 'target' }
    $script:targetChecks.credentialsPresent = $true

    $stage = 'tools'
    $script:failureCheck = 'postgres-tools'
    $projectRoot = Split-Path -Parent $PSScriptRoot
    $projectRoot = [IO.Path]::GetFullPath($projectRoot)
    $pgBin = Join-Path $projectRoot 'tools\postgresql16\pgsql\bin'
    $pgDump = Join-Path $pgBin 'pg_dump.exe'
    $pgRestore = Join-Path $pgBin 'pg_restore.exe'
    if (-not (Test-Path -LiteralPath $pgDump -PathType Leaf) -or -not (Test-Path -LiteralPath $pgRestore -PathType Leaf)) { throw 'tools' }

    $versionDump = Invoke-BreakDishNativeProcess -Executable $pgDump -Arguments @('--version') -WorkingDirectory $pgBin -EnvironmentVariables @{} -TimeoutMilliseconds 10000
    $versionRestore = Invoke-BreakDishNativeProcess -Executable $pgRestore -Arguments @('--version') -WorkingDirectory $pgBin -EnvironmentVariables @{} -TimeoutMilliseconds 10000
    if (-not $versionDump.started -or $versionDump.exitCode -ne 0 -or $versionDump.stdout -notmatch '\b16\.15\b' -or
        -not $versionRestore.started -or $versionRestore.exitCode -ne 0 -or $versionRestore.stdout -notmatch '\b16\.15\b') { throw 'tools' }
    $script:rawStdout = $null
    $script:rawStderr = $null
    $versionDump = $null
    $versionRestore = $null

    $stage = 'storage'
    $script:failureCheck = 'private-backup-path'
    $timestamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmssfff')
    if ($LocalTestOnly) {
        if ([string]::IsNullOrWhiteSpace($env:TEMP)) { throw 'storage' }
        $storageRoot = $env:TEMP
    }
    else {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'storage' }
        $storageRoot = Join-Path $env:LOCALAPPDATA 'BREAK-DISH\ProductionBackups'
    }
    if (-not (Test-BreakDishPathIsPrivateLocal -Path $storageRoot -ProjectRoot $projectRoot)) { throw 'storage' }
    $script:failureCheck = 'backup-root-create'
    $null = New-Item -ItemType Directory -Path $storageRoot -Force -ErrorAction Stop
    $runName = 'run-' + $timestamp + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $script:backupDirectory = Join-Path $storageRoot $runName
    $script:failureCheck = 'run-folder-unique'
    if (Test-Path -LiteralPath $script:backupDirectory) { throw 'storage' }
    $script:failureCheck = 'run-folder-create'
    $null = New-Item -ItemType Directory -Path $script:backupDirectory -ErrorAction Stop
    $script:backupDirectoryCreated = $true
    $script:failureCheck = 'run-folder-acl'
    Set-BreakDishPrivateDirectoryAcl -Path $script:backupDirectory
    $script:backupFile = Join-Path $script:backupDirectory ("breakdish-before-migration-013-$timestamp.dump")
    $script:failureCheck = 'backup-file-unique'
    if (Test-Path -LiteralPath $script:backupFile) { throw 'storage' }

    if ($LocalTestOnly) {
        $script:summary.database = 'breakdish_pgdump_backup_test'
        $script:summary.tlsEncrypted = $false
        $script:summary.backupTlsMode = 'local-test-only; TLS disabled'
    }
    else {
        $stage = 'confirmation'
        $script:failureCheck = 'backup-confirmation'
        $confirmation = Read-Host 'Read-only preflight plus a permanent backup of the verified Render breakdish database before migration 013; no migrations will run. Type BACKUP to continue'
        if ($confirmation -cne 'BACKUP') { throw 'cancelled' }

        $stage = 'read-only-preflight'
        $nodeExe = $null
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($nodeCommand -and $nodeCommand.Source) { $nodeExe = $nodeCommand.Source }
        if (-not $nodeExe) { $nodeExe = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
        $verifier = Join-Path $projectRoot 'api\verify-db-readonly.mjs'
        if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf) -or -not (Test-Path -LiteralPath $verifier -PathType Leaf)) { throw 'tools' }
        $verifierEnvironment = @{ DATABASE_URL = $script:databaseUrlText }
        $verifierResult = Invoke-BreakDishNativeProcess -Executable $nodeExe -Arguments @($verifier) -WorkingDirectory $projectRoot -EnvironmentVariables $verifierEnvironment -TimeoutMilliseconds 30000
        if (-not $verifierResult.started -or $verifierResult.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($verifierResult.stdout)) { throw 'preflight' }
        try { $verification = $verifierResult.stdout.Trim() | ConvertFrom-Json -ErrorAction Stop }
        catch { throw 'preflight' }
        if ($verification.PSObject.Properties.Name -contains 'failure') { throw 'preflight' }
        $migrationsMatch = $verification.migrationEntryCount -eq 12 -and $verification.migrationHistoryMatches -eq $true -and
            @($verification.missingMigrations).Count -eq 0 -and @($verification.unexpectedMigrations).Count -eq 0
        $preflightOk = $verification.database -eq 'breakdish' -and ([string]$verification.postgresVersion).StartsWith('16.15') -and
            $verification.tlsEncrypted -eq $true -and $verification.tlsRequired -eq $true -and $verification.transactionReadOnly -eq $true -and
            $migrationsMatch -and $verification.migration012Applied -eq $true -and $verification.migration013Applied -eq $false -and
            $verification.raceToColumnsAbsent -eq $true -and @($verification.missingTables).Count -eq 0
        if (-not $preflightOk) { throw 'preflight' }
        $script:summary.productionPreflightPassed = $true
        $script:summary.database = 'breakdish'
        $script:summary.postgresVersion = [string]$verification.postgresVersion
        $script:summary.migrationEntryCount = 12
        $script:summary.migration012Applied = $true
        $script:summary.migration013Applied = $false
        $script:summary.tlsEncrypted = $true
        $script:summary.backupTlsMode = 'sslmode=require (encrypted; server identity is not verified like verify-full)'
        $verifierResult = $null
        $verification = $null
        $verifierEnvironment = $null
    }

    $stage = 'pg-dump'
    $connectionPort = [string]$validatedPort
    $connectionEnvironment = @{
        PGHOST = $uri.DnsSafeHost
        PGPORT = $connectionPort
        PGUSER = $script:databaseUser
        PGPASSWORD = $script:databasePassword
        PGDATABASE = $databaseName
        PGSSLMODE = if ($LocalTestOnly) { 'disable' } else { 'require' }
        PGCONNECT_TIMEOUT = '20'
        PGAPPNAME = 'breakdish-production-backup'
    }
    $dumpArguments = @('--no-password', '--format=custom', '--no-owner', '--no-acl', '--file', $script:backupFile)
    $dumpResult = Invoke-BreakDishNativeProcess -Executable $pgDump -Arguments $dumpArguments -WorkingDirectory $pgBin -EnvironmentVariables $connectionEnvironment -TimeoutMilliseconds 1800000
    if (-not $dumpResult.started) { throw 'pg-dump-start' }
    if ($dumpResult.timedOut) { throw 'pg-dump-timeout' }
    if ($dumpResult.exitCode -ne 0) {
        $script:safeCategory = Get-BreakDishSafeFailureCategory -Diagnostic ($dumpResult.stderr + [Environment]::NewLine + $dumpResult.stdout)
        throw 'pg-dump-failed'
    }
    $dumpResult = $null
    $script:rawStdout = $null
    $script:rawStderr = $null

    $stage = 'archive-verification'
    $archiveInfo = Get-Item -LiteralPath $script:backupFile -ErrorAction Stop
    if (-not $archiveInfo -or $archiveInfo.Length -le 0) { throw 'archive-size' }
    $restoreResult = Invoke-BreakDishNativeProcess -Executable $pgRestore -Arguments @('--list', $script:backupFile) -WorkingDirectory $pgBin -EnvironmentVariables @{} -TimeoutMilliseconds 120000
    if (-not $restoreResult.started -or $restoreResult.timedOut -or $restoreResult.exitCode -ne 0) { throw 'archive-list' }
    $expectedObjects = @(
        'TABLE public breakdish_app_migrations',
        'TABLE public matches',
        'TABLE public match_frames',
        'TABLE public league_match_format_templates',
        'TABLE public match_format_snapshots',
        'TABLE public match_format_snapshot_frames',
        'TABLE public user'
    )
    if ($LocalTestOnly) { $expectedObjects += 'TABLE public breakdish_backup_probe' }
    foreach ($objectName in $expectedObjects) {
        if ($restoreResult.stdout -notmatch [Regex]::Escape($objectName)) { throw 'archive-objects' }
    }
    $script:rawStdout = $null
    $script:rawStderr = $null
    $restoreResult = $null
    $script:summary.archiveVerified = $true
    $script:summary.backupPath = $script:backupFile
    $script:summary.backupSizeBytes = [long]$archiveInfo.Length
    if ($LocalTestOnly) { $script:summary.localTestArchiveSizeBytes = [long]$archiveInfo.Length }
    $script:summary.success = $true
    $script:success = $true
    if ($LocalTestOnly) { $script:summary.localTestArchiveDeleted = $true }
}
catch {
    $script:summary.failureStage = $stage
    $script:summary.failureCheck = $script:failureCheck
    $script:summary.targetChecks = $script:targetChecks
    if (-not $script:safeCategory) {
        $failureToken = if ($_.Exception) { [string]$_.Exception.Message } else { '' }
        switch ($failureToken) {
            'missing-url' { $script:safeCategory = 'input' }
            'invalid-url' { $script:safeCategory = 'target' }
            'target' { $script:safeCategory = 'target' }
            'tools' { $script:safeCategory = 'tools' }
            'storage' { $script:safeCategory = 'local-storage' }
            'private-acl' { $script:safeCategory = 'local-permissions' }
            'cancelled' { $script:safeCategory = 'cancelled' }
            'preflight' { $script:safeCategory = 'preflight' }
            'pg-dump-start' { $script:safeCategory = 'tool-start' }
            'pg-dump-timeout' { $script:safeCategory = 'timeout' }
            'pg-dump-failed' { if (-not $script:safeCategory) { $script:safeCategory = 'other' } }
            'archive-size' { $script:safeCategory = 'archive-size' }
            'archive-list' { $script:safeCategory = 'archive-verification' }
            'archive-objects' { $script:safeCategory = 'archive-contents' }
            default { $script:safeCategory = 'other' }
        }
    }
    if ($script:safeCategory -eq 'other') {
        switch ($script:failureCheck) {
            { $_ -like 'url-*' -or $_ -like 'expected-*' -or $_ -eq 'port' -or $_ -eq 'credentials-shape' } { $script:safeCategory = 'target' }
            'private-backup-path' { $script:safeCategory = 'local-storage' }
            { $_ -like '*folder-acl' } { $script:safeCategory = 'local-permissions' }
            'backup-confirmation' { $script:safeCategory = 'cancelled' }
        }
    }
}
finally {
    $script:rawStdout = $null
    $script:rawStderr = $null
    $script:databaseUrlText = $null
    $script:databaseUser = $null
    $script:databasePassword = $null
    $userInfo = $null
    $uri = $null
    $verification = $null
    $verifierResult = $null
    $verifierEnvironment = $null
    $connectionEnvironment = $null
    $dumpArguments = $null
    $dumpResult = $null
    $restoreResult = $null

    $script:summary.credentialsCleared = Clear-BreakDishCredentialEnvironment
    if ($script:safeCategory) { $script:summary.safeCategory = $script:safeCategory }
    if ((-not $script:success -or $LocalTestOnly) -and $script:backupDirectoryCreated -and $script:backupDirectory) {
        try {
            Remove-Item -LiteralPath $script:backupDirectory -Recurse -Force -ErrorAction Stop
            $script:summary.localTestArchiveDeleted = $true
            if (-not $script:success) { $script:summary.failedOutputRemoved = -not (Test-Path -LiteralPath $script:backupDirectory) }
            if (-not $script:success) { $script:summary.backupPath = $null; $script:summary.backupSizeBytes = $null }
        }
        catch {
            if ($LocalTestOnly) { $script:summary.localTestArchiveDeleted = $false }
            $script:summary.failedOutputRemoved = $false
            $script:summary.safeCategory = 'local-cleanup'
            $script:summary.success = $false
        }
    }
    if (-not $script:summary.credentialsCleared) {
        $script:summary.success = $false
        $script:summary.safeCategory = 'credential-cleanup'
    }
    if ($script:summary.success -and -not $LocalTestOnly) {
        $script:summary.failureStage = $null
        $script:summary.failureCheck = $null
        $script:summary.safeCategory = 'none'
    }
    elseif ($script:summary.success -and $LocalTestOnly) {
        $script:summary.failureStage = $null
        $script:summary.failureCheck = $null
        $script:summary.safeCategory = 'none'
        $script:summary.backupPath = $null
        $script:summary.backupSizeBytes = $null
    }
    elseif ($script:summary.success -eq $false -and -not $script:summary.safeCategory) {
        $script:summary.safeCategory = 'other'
    }
    $script:summary | ConvertTo-Json -Compress -Depth 6
}
