// Independent Recovery / Backup / Monitoring verification harness.
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Database, id, now } from '/workspace/Ai-Semo0o-Agent/backend/db/client.mjs';
import { RunQueue } from '/workspace/Ai-Semo0o-Agent/backend/queue/queue.mjs';
import { createEncryptedBackup, decryptBackup, verifyEncryptedBackup, restoreDrill, pruneBackups } from '/workspace/Ai-Semo0o-Agent/backend/ops/backup.mjs';
import { verifyDatabase } from '/workspace/Ai-Semo0o-Agent/backend/ops/sqlite-archive.mjs';
import { evaluateAlerts } from '/workspace/Ai-Semo0o-Agent/backend/observability/alerts.mjs';
import { degradedCapabilities } from '/workspace/Ai-Semo0o-Agent/backend/agent/safety.mjs';
import { errorTrackerStatus } from '/workspace/Ai-Semo0o-Agent/backend/observability/error-tracking.mjs';
import { collectMetrics, computeSlo, renderPrometheus } from '/workspace/Ai-Semo0o-Agent/backend/observability/metrics.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
}

function seed(db) {
  const t = now();
  const tenantId = id('tenant'), userId = id('user'), projectId = id('project'), workspaceId = id('workspace');
  db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, 'Rec Tenant', t);
  db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, 'rec@test', 'x', 'owner', t);
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'Rec Project', t);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, process.cwd(), t);
  return { tenantId, userId, projectId, workspaceId };
}
function seedRun(db, s, status, { attempts = 0, leaseUntil = null, workerId = 'w1' } = {}) {
  const taskId = id('task'); const runId = id('run'); const t = now();
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, s.tenantId, s.projectId, s.workspaceId, s.userId, 'g', 'queued', t, t);
  db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,worker_id,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', runId, taskId, s.tenantId, status, '{"kind":"code.run"}', attempts, workerId, leaseUntil, t, t);
  return { taskId, runId };
}

const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-rec-'));

try {
  // ---------------- RECOVERY ----------------
  console.log('\n[1] Queue crash/restart recovery (sweep)');
  {
    const db = new Database(path.join(dir, 'rec.sqlite'));
    const s = seed(db);
    const past = new Date(Date.now() - 60_000).toISOString();
    const expired = seedRun(db, s, 'running', { attempts: 0, leaseUntil: past, workerId: 'dead-worker' });
    const orphan = seedRun(db, s, 'running', { attempts: 5, leaseUntil: past, workerId: 'dead-worker' });
    const queue = new RunQueue(db, { pollMs: 5, maxAttempts: 3 });
    const result = await queue.sweep();
    const requeued = db.get('SELECT status, worker_id FROM runs WHERE id=?', expired.runId);
    const finalized = db.get('SELECT status, result_json FROM runs WHERE id=?', orphan.runId);
    check('expired-lease run is requeued', requeued.status === 'queued' && requeued.worker_id === null, JSON.stringify(requeued));
    check('exhausted orphan is finalized failed', finalized.status === 'failed', JSON.stringify(finalized));
    check('orphan result is ORPHANED_RUN_RECOVERED', /ORPHANED_RUN_RECOVERED/.test(finalized.result_json || ''), finalized.result_json);
    check('sweep reports requeued + finalized counts', result.requeued >= 1 && result.finalized >= 1, JSON.stringify(result));
    check('recovery writes an audit log', db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='run.recovered_orphan'").n >= 1);
    db.close();
  }

  // ---------------- BACKUP ----------------
  console.log('\n[2] Encrypted backup -> verify -> drill -> restore round-trip');
  const KEY = 'recovery-verify-key-material-0123456789';
  const backupDir = path.join(dir, 'backups');
  await mkdir(backupDir, { mode: 0o700 });
  {
    const srcPath = path.join(dir, 'source.sqlite');
    const db = new Database(srcPath);
    const tenantId = id('tenant');
    db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, 'Round Trip Co', now());
    db.close();

    const backupPath = path.join(backupDir, 'snap.bk');
    const created = await createEncryptedBackup(srcPath, backupPath, { key: KEY });
    check('backup created with AES-256-GCM', created.encryption === 'aes-256-gcm' && created.bytes > 0, JSON.stringify(created));
    const verified = await verifyEncryptedBackup(backupPath, { key: KEY });
    check('backup verifies (integrity)', verified.ok === true, JSON.stringify(verified));
    const drill = await restoreDrill(backupPath, { key: KEY });
    check('restore drill passes', drill.ok === true, JSON.stringify(drill));
    const restoredPath = path.join(dir, 'restored.sqlite');
    await decryptBackup(backupPath, restoredPath, { key: KEY });
    const v = await verifyDatabase(restoredPath);
    check('restored DB passes SQLite integrity + schema', v.schemaVersion >= 1, JSON.stringify(v));
    const rdb = new Database(restoredPath);
    const row = rdb.get('SELECT name FROM tenants WHERE id=?', tenantId);
    rdb.close();
    check('data round-trips (tenant survived)', row?.name === 'Round Trip Co', JSON.stringify(row));

    // tamper detection
    const bytes = await readFile(backupPath);
    bytes[bytes.length - 10] ^= 0xff;
    const tampered = path.join(backupDir, 'tampered.bk');
    await writeFile(tampered, bytes);
    let rejected = false;
    try { await verifyEncryptedBackup(tampered, { key: KEY }); } catch { rejected = true; }
    check('tampered ciphertext is rejected (GCM auth)', rejected);

    // wrong key
    let wrongKeyRejected = false;
    try { await decryptBackup(backupPath, path.join(dir, 'x.sqlite'), { key: 'wrong-key-material-000000000000000000' }); } catch { wrongKeyRejected = true; }
    check('wrong key is rejected', wrongKeyRejected);

    // prune retention
    for (let i = 0; i < 5; i++) await createEncryptedBackup(srcPath, path.join(backupDir, `snap-${i}.bk`), { key: KEY });
    const pruned = await pruneBackups(backupDir, { keep: 3 });
    const remaining = (await readdir(backupDir)).filter((f) => f.endsWith('.bk')).length;
    check('pruneBackups keeps only `keep` newest', remaining === 3, `remaining=${remaining} pruned=${JSON.stringify(pruned)}`);
  }

  // ---------------- MONITORING ----------------
  console.log('\n[3] Monitoring: metrics, SLO, alerts, degraded, error-tracking');
  {
    const db = new Database(path.join(dir, 'mon.sqlite'));
    seed(db);
    const metrics = collectMetrics(db, { windowHours: 24 });
    check('collectMetrics returns counters', metrics && typeof metrics === 'object', JSON.stringify(metrics).slice(0, 120));
    const slo = computeSlo(db, { windowHours: 24 });
    check('computeSlo returns targets/attainment', slo && typeof slo === 'object', JSON.stringify(slo).slice(0, 120));
    const prom = renderPrometheus(metrics, slo);
    check('renderPrometheus emits valid exposition text', /# (HELP|TYPE)/.test(prom), prom.slice(0, 80));
    const alerts = evaluateAlerts(db, { windowHours: 24 });
    check('evaluateAlerts returns metrics + slo + firing[]', alerts && Array.isArray(alerts.firing) && !!alerts.metrics, JSON.stringify(alerts).slice(0, 120));

    const degraded = degradedCapabilities({ tools: null, llm: null });
    check('degradedCapabilities flags missing LLM', degraded.degraded === true && degraded.unavailable.includes('llm'), JSON.stringify(degraded));
    const nominal = degradedCapabilities({ tools: { status: () => ({ live: ['files.scan'], unwired: [], failed: [] }) }, llm: { status: () => [{ id: 'openai', configured: true, healthy: true }] } });
    check('degradedCapabilities nominal when provider configured', nominal.degraded === false, JSON.stringify(nominal));

    const et = errorTrackerStatus({});
    check('errorTrackerStatus is honest when unconfigured', et && et.configured === false, JSON.stringify(et));
    db.close();
  }

  console.log(`\n==== RECOVERY/BACKUP/MONITORING: ${pass} passed, ${fail} failed ====`);
} catch (error) {
  fail++;
  console.log('HARNESS ERROR:', error?.stack || error);
} finally {
  await rm(dir, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
