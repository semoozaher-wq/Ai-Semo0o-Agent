# Semo0o AI — Privacy Policy

**Status: Draft — legal review required before public launch.**

## Data we process

Semo0o AI may process account identifiers, organization membership, workspace files, prompts, model responses, run evidence, usage/quota data, audit events, and optional integration data. Secrets and provider credentials must remain server-side and are not intentionally exposed to the mobile client.

## Purpose and isolation

Data is processed to authenticate users, run agents, provide workspace and memory features, enforce organization permissions, calculate usage, and maintain security evidence. Workspace documents and memory queries are scoped by tenant and project. No cross-tenant access is a supported behavior.

## Retention

Operational records are retained only for the configured business and security retention period. Operators must configure a documented retention value, backup retention, and deletion schedule before launch. Backups may retain deleted records until their retention window expires.

## User controls

Users should be able to request export and deletion of their account, organization, workspace, and memory data. Deletion must be authenticated, authorized, audited, and propagated to active stores and backup-expiration workflows. The current repository provides MemoryStore export/delete primitives; a public account-deletion workflow is still pending.

## Processors and transfers

AI, email, billing, GitHub, calendar, browser, and image providers may process data only after an explicit connector is configured. Connector availability and data-transfer regions must be documented per deployment.

## Security contact

Deployments must publish a monitored security contact and incident-response process. Do not submit secrets or personal data in public issue trackers.

## Changes

The deployed policy, effective date, controller identity, jurisdiction, legal basis, and user rights must be completed by the operator and reviewed by qualified counsel before release.
