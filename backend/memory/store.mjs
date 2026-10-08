import { randomUUID } from 'node:crypto';
import { createEmbeddingProvider, localEmbedding, LOCAL_EMBEDDING_MODEL } from './embeddings.mjs';
import { mapWithConcurrency, resolveConcurrency } from '../util/concurrency.mjs';

function tokens(text) { return String(text).toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []; }
function cosine(a, b) { return a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0); }

export class MemoryStore {
  constructor(db, options = {}) {
    this.db = db;
    // Prefer a managed embedding provider when one is configured; otherwise use
    // the deterministic local embedder. `options.embedder` lets tests inject a
    // provider directly.
    this.embedder = options.embedder ?? createEmbeddingProvider();
    this.model = this.embedder ? this.embedder.model : LOCAL_EMBEDDING_MODEL;
  }
  status() {
    return { model: this.model, managed: Boolean(this.embedder), provider: this.embedder?.provider ?? 'local' };
  }
  async embedText(text) {
    if (this.embedder) return this.embedder.embed(text);
    return localEmbedding(text);
  }
  assertProject(tenantId, projectId) {
    const project = this.db.get('SELECT id FROM projects WHERE id=? AND tenant_id=?', projectId, tenantId);
    if (!project) throw new Error('MEMORY_PROJECT_NOT_FOUND');
  }
  async addDocument({ tenantId, projectId, source, content }) {
    this.assertProject(tenantId, projectId);
    const id = `doc_${randomUUID()}`; const created = new Date().toISOString();
    const vector = await this.embedText(content);
    this.db.transaction(() => {
      this.db.run('INSERT INTO documents(id,tenant_id,project_id,source,content,created_at) VALUES(?,?,?,?,?,?)', id, tenantId, projectId, source, content, created);
      this.db.run('INSERT INTO embeddings(id,document_id,vector_json,model,created_at) VALUES(?,?,?,?,?)', `emb_${randomUUID()}`, id, JSON.stringify(vector), this.model, created);
    });
    return this.db.get('SELECT id,tenant_id,project_id,source,created_at FROM documents WHERE id=?', id);
  }
  /**
   * Insert or refresh a document identified by (project, source). Used by memory
   * consolidation so re-running it updates the single consolidated knowledge doc
   * instead of piling up duplicates. Re-embeds on every write so retrieval stays
   * accurate. Returns the row plus `updated` (true when an existing doc was
   * replaced, false when a new one was created).
   */
  async upsertDocument({ tenantId, projectId, source, content }) {
    this.assertProject(tenantId, projectId);
    const existing = this.db.get('SELECT id FROM documents WHERE tenant_id=? AND project_id=? AND source=? ORDER BY created_at DESC LIMIT 1', tenantId, projectId, source);
    const created = new Date().toISOString();
    const vector = await this.embedText(content);
    if (existing) {
      this.db.transaction(() => {
        this.db.run('UPDATE documents SET content=?, created_at=? WHERE id=?', content, created, existing.id);
        this.db.run('UPDATE embeddings SET vector_json=?, model=?, created_at=? WHERE document_id=?', JSON.stringify(vector), this.model, created, existing.id);
      });
      return { ...this.db.get('SELECT id,tenant_id,project_id,source,created_at FROM documents WHERE id=?', existing.id), updated: true };
    }
    const id = `doc_${randomUUID()}`;
    this.db.transaction(() => {
      this.db.run('INSERT INTO documents(id,tenant_id,project_id,source,content,created_at) VALUES(?,?,?,?,?,?)', id, tenantId, projectId, source, content, created);
      this.db.run('INSERT INTO embeddings(id,document_id,vector_json,model,created_at) VALUES(?,?,?,?,?)', `emb_${randomUUID()}`, id, JSON.stringify(vector), this.model, created);
    });
    return { ...this.db.get('SELECT id,tenant_id,project_id,source,created_at FROM documents WHERE id=?', id), updated: false };
  }
  /**
   * Hybrid lexical + semantic search. `recencyWeight` (default 0) adds a
   * time-decayed boost so freshly consolidated knowledge ranks above stale notes;
   * it is opt-in, so the default scoring is unchanged for existing callers.
   */
  async search({ tenantId, projectId, query, limit = 5, recencyWeight = 0, now: referenceIso = null }) {
    this.assertProject(tenantId, projectId);
    const q = await this.embedText(query); const queryTokens = new Set(tokens(query));
    const weight = Number.isFinite(recencyWeight) && recencyWeight > 0 ? recencyWeight : 0;
    const reference = referenceIso ? new Date(referenceIso).getTime() : Date.now();
    return this.db.all('SELECT d.id,d.source,d.content,d.created_at,e.vector_json FROM documents d JOIN embeddings e ON e.document_id=d.id WHERE d.tenant_id=? AND d.project_id=?', tenantId, projectId)
      .map((row) => {
        const lexical = tokens(row.content).filter((token) => queryTokens.has(token)).length;
        const semantic = cosine(q, JSON.parse(row.vector_json));
        let score = semantic + lexical * 0.05;
        if (weight) {
          const ageDays = Math.max(0, (reference - new Date(row.created_at).getTime()) / 86_400_000);
          score += weight / (1 + ageDays);
        }
        return { id: row.id, source: row.source, content: row.content, createdAt: row.created_at, score };
      })
      .sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(limit, 50)));
  }
  exportProject(tenantId, projectId) {
    this.assertProject(tenantId, projectId);
    return this.db.all('SELECT id,source,content,created_at FROM documents WHERE tenant_id=? AND project_id=? ORDER BY created_at,id', tenantId, projectId);
  }
  async reindexProject(tenantId, projectId, options = {}) {
    this.assertProject(tenantId, projectId);
    const documents = this.db.all('SELECT id,content FROM documents WHERE tenant_id=? AND project_id=?', tenantId, projectId);
    // Embed with bounded concurrency so a large project does not issue hundreds of
    // simultaneous provider calls (socket exhaustion / rate limits) nor crawl one
    // document at a time. Failures are collected so a single bad document cannot
    // abort the whole reindex.
    const limit = resolveConcurrency(options.concurrency ?? process.env.EMBEDDING_CONCURRENCY, 4);
    const outcomes = await mapWithConcurrency(documents, limit, async (document) => ({ id: document.id, vector: await this.embedText(document.content) }));
    const vectors = [];
    let failed = 0;
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') vectors.push(outcome.value);
      else failed += 1;
    }
    this.db.transaction(() => {
      for (const entry of vectors) this.db.run('UPDATE embeddings SET vector_json=?,model=? WHERE document_id=?', JSON.stringify(entry.vector), this.model, entry.id);
    });
    return { projectId, indexed: vectors.length, failed, model: this.model, concurrency: limit };
  }
  deleteExpired({ tenantId, projectId, before }) {
    this.assertProject(tenantId, projectId);
    if (!(before instanceof Date) || Number.isNaN(before.getTime())) throw new Error('MEMORY_RETENTION_DATE_INVALID');
    return this.db.run('DELETE FROM documents WHERE tenant_id=? AND project_id=? AND created_at<?', tenantId, projectId, before.toISOString());
  }
  deleteProject(tenantId, projectId) {
    this.assertProject(tenantId, projectId);
    return this.db.run('DELETE FROM documents WHERE tenant_id=? AND project_id=?', tenantId, projectId);
  }
}
