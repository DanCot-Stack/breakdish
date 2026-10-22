# Local PostgreSQL test tools

The Windows disposable-database harness and local backup-helper checks require PostgreSQL **16.15** portable executables in:

```text
tools/postgresql16/pgsql/bin
```

The required files are `initdb.exe`, `pg_ctl.exe`, `createdb.exe`, `psql.exe`, `postgres.exe`, `pg_dump.exe` and `pg_restore.exe`. The harness checks their version before starting its private disposable server.

These binaries are a machine-local prerequisite. Keep `tools/postgresql16/` untracked and out of commits; the project does not redistribute PostgreSQL executables.

From the repository root, run the release-tool checks in a normal, non-elevated Windows PowerShell window:

```powershell
.\tools\test-migration-runner-local.ps1 -ReleaseToolsOnly
```

The wrapper starts the bundled PowerShell 7 runtime in the same Windows account. It retains the execution-identity guard, clears ambient database connection variables, and creates only loopback disposable databases. This mode verifies the pre-013 baseline and rejection cases, pre/post-013 permissions, and the local custom-format backup/archive checks. It skips the full API integration suite. Do not run the local backup-helper test without `-LocalTestOnly`; that mode is specifically constrained to its synthetic loopback test database.
