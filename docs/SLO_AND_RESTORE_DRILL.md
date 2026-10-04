# SLO and Restore Drill

**These are target objectives, not measured production evidence.**

## Initial targets

| Service | Target |
|---|---|
| API availability | 99.9% monthly, excluding approved maintenance |
| API p95 latency | < 500 ms for non-provider requests |
| Run acceptance | 99.9% of accepted jobs persisted durably |
| Recovery Point Objective | <= 15 minutes once scheduled off-site backups exist |
| Recovery Time Objective | <= 60 minutes after an approved restore decision |
| Tenant isolation | 0 confirmed cross-tenant reads/writes |

## Restore drill procedure

1. Create a backup with `node backend/ops/sqlite-archive.mjs backup <source-db> <backup-file>`.
2. Verify it with `node backend/ops/sqlite-archive.mjs verify <backup-file>`.
3. Restore to a new path with `node backend/ops/sqlite-archive.mjs restore <backup-file> <restored-db>`.
4. Run `PRAGMA integrity_check`, foreign-key checks, schema checks, backend tests against the restored file, and a cross-tenant access test.
5. Record timestamps, hashes, schema version, row counts for critical tables, RPO/RTO, and any discrepancy.
6. Destroy temporary drill files securely after evidence is archived.

A real scheduled, off-site, encrypted restore drill remains **NOT VERIFIED** in this repository-only environment.
