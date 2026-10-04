# Production Incident Runbook

## Severity

- **SEV-1:** active data exposure, auth bypass, destructive cross-tenant behavior, or complete outage.
- **SEV-2:** material degradation, queue loss, provider failure, or billing inconsistency without confirmed exposure.
- **SEV-3:** isolated feature failure with a safe workaround.

## First response

1. Record UTC time, reporter, affected tenant(s), deployment version, and correlation IDs.
2. If exposure is suspected, disable the affected integration or route, revoke sessions/secrets, and preserve logs.
3. Do not delete evidence or run ad-hoc database updates on the primary.
4. Check `/health`, `/ready`, worker leases, queue status, error rate, latency, provider status, and disk/memory.
5. Declare an incident owner and communications owner.

## Data/security incident

- Stop the suspected path with a fail-closed configuration or access rule.
- Rotate affected credentials through the deployment secret manager.
- Review audit logs and tenant-scoped access evidence.
- Notify the responsible privacy/security contact according to the applicable legal process.

## Database recovery

- Take the primary out of write service if corruption is suspected.
- Verify the latest backup with `node backend/ops/sqlite-archive.mjs verify <backup>`.
- Restore only to a new private file with `node backend/ops/sqlite-archive.mjs restore <backup> <new-db>`.
- Run integrity, foreign-key, schema, application smoke, and tenant-isolation checks before cutover.
- Record source hash, restored hash, RPO, RTO, and operator approval.

## Exit criteria

The incident owner confirms mitigation, tests the affected path, records residual risk, and publishes a postmortem for SEV-1/SEV-2 incidents.
