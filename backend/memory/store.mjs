import { createHash, randomUUID } from 'node:crypto';

function tokens(text) { return String(text).toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []; }
function embedding(text, dimensions = 64) { const vector = Array(dimensions).fill(0); for (const token of tokens(text)) vector[parseInt(createHash('sha256').update(token).digest('hex').slice(0, 8), 16) % dimensions] += 1; const norm = Math.sqrt(vector.reduce((a, b) => a + b * b, 0)) || 1; return vector.map((v) => v / norm); }
function cosine(a, b) { return a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0); }

export class MemoryStore {
  constructor(db) { this.db = db; }
  assertProject(tenantId, projectId) {
    const project = this.db.get('SELECT id FROM projects WHERE id=? AND tenant_id=?', projectId, tenantId);
    if (!project) throw new Error('MEMORY_PROJECT_NOT_FOUND');
  }
  addDocument({ tenantId, projectId, source, content }) {
    this.assertProject(tenantId, projectId);
    const id = `doc_${randomUUID()}`; const created = new Date().toISOString();
    this.db.transaction(() => {
      this.db.run('INSERT INTO documents(id,tenant_id,project_id,source,content,created_at) VALUES(?,?,?,?,?,?)', id, tenantId, projectId, source, content, created);
      this.db.run('INSERT INTO embeddings(id,document_id,vector_json,model,created_at) VALUES(?,?,?,?,?)', `emb_${randomUUID()}`, id, JSON.stringify(embedding(content)), 'local-hash-v1', created);
    });
    return this.db.get('SELECT id,tenant_id,project_id,source,created_at FROM documents WHERE id=?', id);
  }
  search({ tenantId, projectId, query, limit = 5 }) {
    this.assertProject(tenantId, projectId);
    const q = embedding(query); const queryTokens = new Set(tokens(query));
    return this.db.all('SELECT d.id,d.source,d.content,e.vector_json FROM documents d JOIN embeddings e ON e.document_id=d.id WHERE d.tenant_id=? AND d.project_id=?', tenantId, projectId)
      .map((row) => { const lexical = tokens(row.content).filter((token) => queryTokens.has(token)).length; const semantic = cosine(q, JSON.parse(row.vector_json)); return { id: row.id, source: row.source, content: row.content, score: semantic + lexical * 0.05 }; })
      .sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(limit, 50)));
  }
  exportProject(tenantId, projectId) {
    this.assertProject(tenantId, projectId);
    return this.db.all('SELECT id,source,content,created_at FROM documents WHERE tenant_id=? AND project_id=? ORDER BY created_at,id', tenantId, projectId);
  }
  reindexProject(tenantId, projectId) {
    this.assertProject(tenantId, projectId);
    const documents = this.db.all('SELECT id,content FROM documents WHERE tenant_id=? AND project_id=?', tenantId, projectId);
    this.db.transaction(() => {
      for (const document of documents) this.db.run('UPDATE embeddings SET vector_json=?,model=? WHERE document_id=?', JSON.stringify(embedding(document.content)), 'local-hash-v1', document.id);
    });
    return { projectId, indexed: documents.length, model: 'local-hash-v1' };
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
