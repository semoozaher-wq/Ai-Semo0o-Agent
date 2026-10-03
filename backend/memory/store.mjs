import { createHash, randomUUID } from 'node:crypto';

function tokens(text) { return String(text).toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []; }
function embedding(text, dimensions = 64) { const vector = Array(dimensions).fill(0); for (const token of tokens(text)) vector[parseInt(createHash('sha256').update(token).digest('hex').slice(0, 8), 16) % dimensions] += 1; const norm = Math.sqrt(vector.reduce((a, b) => a + b * b, 0)) || 1; return vector.map((v) => v / norm); }
function cosine(a, b) { return a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0); }

export class MemoryStore {
  constructor(db) { this.db = db; }
  addDocument({ tenantId, projectId, source, content }) {
    const id = `doc_${randomUUID()}`; const created = new Date().toISOString();
    this.db.transaction(() => {
      this.db.run('INSERT INTO documents(id,tenant_id,project_id,source,content,created_at) VALUES(?,?,?,?,?,?)', id, tenantId, projectId, source, content, created);
      this.db.run('INSERT INTO embeddings(id,document_id,vector_json,model,created_at) VALUES(?,?,?,?,?)', `emb_${randomUUID()}`, id, JSON.stringify(embedding(content)), 'local-hash-v1', created);
    });
    return this.db.get('SELECT id,tenant_id,project_id,source,created_at FROM documents WHERE id=?', id);
  }
  search({ tenantId, projectId, query, limit = 5 }) {
    const q = embedding(query); const queryTokens = new Set(tokens(query));
    return this.db.all('SELECT d.id,d.source,d.content,e.vector_json FROM documents d JOIN embeddings e ON e.document_id=d.id WHERE d.tenant_id=? AND d.project_id=?', tenantId, projectId)
      .map((row) => { const lexical = tokens(row.content).filter((token) => queryTokens.has(token)).length; const semantic = cosine(q, JSON.parse(row.vector_json)); return { id: row.id, source: row.source, content: row.content, score: semantic + lexical * 0.05 }; })
      .sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(limit, 50)));
  }
  deleteProject(tenantId, projectId) { return this.db.run('DELETE FROM documents WHERE tenant_id=? AND project_id=?', tenantId, projectId); }
}
