PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  email_verified_at TEXT,
  mfa_secret TEXT,
  mfa_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mfa_enabled IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS tenant_members (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  status TEXT NOT NULL CHECK (status IN ('active','suspended')) DEFAULT 'active',
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member','viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('email_verification','password_reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_quotas (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  monthly_tokens INTEGER NOT NULL DEFAULT 100000,
  monthly_runs INTEGER NOT NULL DEFAULT 1000,
  -- Hard spending cap (USD) per billing period. A run/chat that would push the
  -- tenant past this limit is refused (MONTHLY_COST_QUOTA_EXCEEDED) so a runaway
  -- job can never burn unbounded provider budget.
  monthly_cost_usd REAL NOT NULL DEFAULT 10,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_counters (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  runs INTEGER NOT NULL DEFAULT 0,
  -- Accumulated provider spend (USD) for the period, summed from run_usage.
  cost_usd REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, period)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_customer_id TEXT,
  provider_subscription_id TEXT UNIQUE,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('trialing','active','past_due','canceled','incomplete','unpaid')),
  current_period_end TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

-- One-time owner-recovery ledger (backend/auth/recovery.mjs). Each applied
-- recovery writes a fingerprint so re-running the same recovery request on a
-- persistent database is a safe no-op (never a second password reset).
CREATE TABLE IF NOT EXISTS recovery_consumed (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  applied_at TEXT NOT NULL
);

-- Owner-approved access requests (backend/auth/approvals.mjs). A public request
-- NEVER creates an account or a session; it only records intent. Approval mints
-- a one-time setup token; completion creates a 'member' account (never owner).
CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','completed')) DEFAULT 'pending',
  setup_token_hash TEXT UNIQUE,
  setup_expires_at TEXT,
  used_at TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  completed_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- Optional device-trust ledger (backend/auth/approvals.mjs). Only consulted when
-- REQUIRE_DEVICE_APPROVAL is enabled; ordinary logins are never gated by default.
CREATE TABLE IF NOT EXISTS device_trust (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','trusted','rejected')) DEFAULT 'pending',
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  last_seen_at TEXT,
  UNIQUE (user_id, device_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_approval','blocked','paused','completed','completed_with_warnings','failed','cancelled','unverified')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  checkpoint_json TEXT,
  worker_id TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT,
  output_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  capability TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('pending','allow','deny','cancel')),
  reason TEXT NOT NULL,
  decided_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  sha256 TEXT,
  size_bytes INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  vector_json TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_usage (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
-- Auth lookups are case-insensitive (`WHERE lower(email)=lower(?)`) and so cannot
-- use the UNIQUE(tenant_id, email) index; this functional index keeps login,
-- registration, and password-reset off a full table scan.
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(email));
CREATE INDEX IF NOT EXISTS idx_members_user ON tenant_members(user_id, status);
CREATE INDEX IF NOT EXISTS idx_invitations_tenant_email ON invitations(tenant_id, email, accepted_at);
CREATE INDEX IF NOT EXISTS idx_account_tokens_lookup ON account_tokens(token_hash, kind, used_at);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id, used_at);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_projects_tenant ON projects(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status ON tasks(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_tenant_status ON runs(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_lease ON runs(status, lease_until);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions(tenant_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_tenant_idempotency ON runs(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_approvals_run_decision ON approvals(run_id, decision);
CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_logs(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_events_run_time ON run_events(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_usage_tenant_time ON run_usage(tenant_id, created_at);

-- ===========================================================================
-- Self-improvement / self-healing engine (tenant-scoped, human-gated).
-- The engine observes its own run outcomes, diagnoses recurring failures, and
-- proposes bounded, security-preserving remediations. Nothing here can modify
-- authentication, authorization, permissions, billing, or tenant isolation.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS self_improve_proposals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('tenant','platform')) DEFAULT 'tenant',
  signature TEXT NOT NULL,
  category TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tool_disable','planner_hint','retry_policy','limit_adjust','knowledge_note')),
  status TEXT NOT NULL CHECK (status IN ('proposed','applied','rejected','rolled_back','regressed')) DEFAULT 'proposed',
  severity TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  patch_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  regression_json TEXT,
  occurrences INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  decided_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  applied_at TEXT,
  rolled_back_at TEXT
);

CREATE TABLE IF NOT EXISTS self_improve_overrides (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('tenant','platform')) DEFAULT 'tenant',
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  value_json TEXT NOT NULL,
  proposal_id TEXT REFERENCES self_improve_proposals(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS self_improve_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  proposal_id TEXT,
  phase TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_self_improve_proposals_tenant ON self_improve_proposals(tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_self_improve_proposals_signature ON self_improve_proposals(tenant_id, signature);
CREATE INDEX IF NOT EXISTS idx_self_improve_overrides_lookup ON self_improve_overrides(tenant_id, kind, target, active);
CREATE INDEX IF NOT EXISTS idx_self_improve_events_tenant ON self_improve_events(tenant_id, created_at);

-- ===========================================================================
-- Transactional email outbox (durable queue; provider is fail-closed).
-- Account tokens / invitations are written here so delivery is a real, auditable
-- step instead of an in-memory claim. A provider adapter must be configured for
-- any message to reach 'sent'; otherwise it stays 'queued' and never lies.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS email_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  to_email TEXT NOT NULL,
  template TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','sent','failed','suppressed')) DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_outbox_status ON email_outbox(status, created_at);
CREATE INDEX IF NOT EXISTS idx_email_outbox_tenant ON email_outbox(tenant_id, created_at);
-- Data-rights export filters the outbox by recipient case-insensitively.
CREATE INDEX IF NOT EXISTS idx_email_outbox_recipient ON email_outbox(tenant_id, lower(to_email), created_at);

-- ===========================================================================
-- Durable chat state (conversations + messages).
--
-- Chat used to be stateless: a reload lost the thread and an interrupted stream
-- left no record. Conversations are now first-class, tenant-scoped rows so the
-- client can list, resume, retry, and recover an interrupted assistant reply.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('chat','agent')) DEFAULT 'chat',
  status TEXT NOT NULL CHECK (status IN ('active','archived')) DEFAULT 'active',
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','streaming','complete','error','interrupted')) DEFAULT 'complete',
  provider TEXT,
  model TEXT,
  usage_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_user ON conversations(tenant_id, user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_status ON chat_messages(tenant_id, status, created_at);

-- Uploaded chat attachments. The binary payload lives on disk under a
-- tenant-scoped directory (never in the row), and this table holds only the
-- metadata plus the storage path. Every lookup is tenant+user scoped so one
-- tenant can never read another tenant's uploads. `sha256` lets the server
-- verify the bytes it later loads match what was uploaded.
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','document','audio','code','other')) DEFAULT 'other',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  storage_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_tenant_user ON attachments(tenant_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversation_id);

-- Hot-path indexes added during the performance pass: tool-call status scans
-- (metrics/SLO), per-user message history, and session lookup by user.
CREATE INDEX IF NOT EXISTS idx_tool_calls_status ON tool_calls(status, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_tenant_user ON messages(tenant_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status, requested_at);
CREATE INDEX IF NOT EXISTS idx_access_requests_email ON access_requests(lower(email), status);
CREATE INDEX IF NOT EXISTS idx_device_trust_user ON device_trust(user_id, status);

-- GitHub connections: per-tenant OAuth/installation credentials. The access
-- token is stored encrypted (AES-256-GCM via the secrets vault); only the
-- non-sensitive login/scope metadata is stored in the clear for display.
CREATE TABLE IF NOT EXISTS github_connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'oauth',
  login TEXT,
  scope TEXT,
  token_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_github_connections_tenant ON github_connections(tenant_id, updated_at);

-- ===========================================================================
-- Scheduled / recurring autonomy (Trigger Scheduler).
-- A trigger is a durable, tenant-scoped definition of *when* to start a run
-- ("every Monday 09:00", "every 15m", "once at <ISO>"). The scheduler creates an
-- ordinary task + queued run on each fire, so scheduled work flows through the
-- same RunQueue/worker as everything else.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS scheduled_triggers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cron','interval','once')),
  schedule TEXT NOT NULL,
  goal TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  last_run_at TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_triggers_due ON scheduled_triggers(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_triggers_tenant ON scheduled_triggers(tenant_id, created_at);

-- ===========================================================================
-- Cross-run reflection & episodic lessons.
-- After a run reaches a terminal state the runtime distils a bounded set of
-- lessons from the run's own events and stores them here; the next run for the
-- same project surfaces them as "Learned guidance" in the planner prompt.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS agent_reflections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  lessons_json TEXT NOT NULL DEFAULT '[]',
  quality_score REAL,
  reward REAL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_reflections_project ON agent_reflections(tenant_id, project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_reflections_run ON agent_reflections(run_id);

-- =============================================================================
-- Creation Studio durable job registry (backend/creation/job-store.mjs)
-- -----------------------------------------------------------------------------
-- The Director is a long, stateful process (brief -> storyboard -> render ->
-- critique -> improve -> deliver). Its jobs used to live ONLY in a bounded,
-- in-memory Map, so every job and every generated artifact (GIF/AVI/MP4/bundle)
-- vanished the moment the process restarted. These three tables turn that
-- transient registry into a durable, restart-surviving record:
--   * creation_jobs           - one row per job (state + result manifest);
--   * creation_job_events     - the append-only, replayable event log;
--   * creation_job_artifacts  - the artifact bytes themselves (BLOB) + a SHA-256
--                               so a restore can prove the file is intact.
-- Storing the bytes IN the database keeps a job and its deliverables atomic with
-- the rest of the platform: the existing encrypted backup (VACUUM INTO) captures
-- everything in one consistent snapshot and a restore brings the whole job back.
-- All statements are idempotent so an existing database picks them up on boot.
-- =============================================================================

CREATE TABLE IF NOT EXISTS creation_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  user_id TEXT,
  goal TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  progress_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_creation_jobs_tenant ON creation_jobs(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_creation_jobs_status ON creation_jobs(status, updated_at);

CREATE TABLE IF NOT EXISTS creation_job_events (
  job_id TEXT NOT NULL,
  tenant_id TEXT,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_creation_job_events_job ON creation_job_events(job_id, seq);

CREATE TABLE IF NOT EXISTS creation_job_artifacts (
  job_id TEXT NOT NULL,
  tenant_id TEXT,
  name TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  content BLOB,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, name)
);
CREATE INDEX IF NOT EXISTS idx_creation_job_artifacts_job ON creation_job_artifacts(job_id);
