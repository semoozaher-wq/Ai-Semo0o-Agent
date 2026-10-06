import { id, now } from '../db/client.mjs';

// ===========================================================================
// Durable chat store.
//
// Before this module, chat was stateless: the server answered, the client kept
// the transcript in local storage, and a reload or a dropped stream lost the
// thread. Conversations are now first-class, tenant-scoped rows so the client
// can list threads, resume a conversation, and — crucially — recover an
// assistant reply that was interrupted mid-stream.
//
// Recovery model: an assistant message is written as `streaming` before any
// token is emitted and flipped to `complete` (or `error`) when the stream ends.
// If the process dies in between, the row is left `streaming`. `recoverInterrupted`
// sweeps those rows to `interrupted` so the UI can offer a retry instead of
// spinning forever. This is the same crash-recovery contract the run queue uses
// for leases, applied to chat.
// ===========================================================================

export const CHAT_MESSAGE_STATUSES = Object.freeze(['pending', 'streaming', 'complete', 'error', 'interrupted']);
const RECOVERABLE_STATUSES = Object.freeze(['pending', 'streaming']);
const ROLES = Object.freeze(['user', 'assistant', 'system']);
const MODES = Object.freeze(['chat', 'agent']);

function boundedTitle(value) {
  const title = typeof value === 'string' && value.trim() ? value.trim() : 'New chat';
  return title.slice(0, 200);
}

function clampLimit(value, fallback = 50, max = 200) {
  const n = Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(max, n));
}

function assertRole(role) {
  if (!ROLES.includes(role)) throw new Error('CHAT_ROLE_INVALID');
}

function assertStatus(status) {
  if (!CHAT_MESSAGE_STATUSES.includes(status)) throw new Error('CHAT_STATUS_INVALID');
}

function deserializeMessage(row) {
  let usage = null;
  if (row.usage_json) {
    try { usage = JSON.parse(row.usage_json); } catch { usage = null; }
  }
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    status: row.status,
    provider: row.provider ?? null,
    model: row.model ?? null,
    usage,
    error: row.error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ChatStore {
  constructor(db) {
    this.db = db;
  }

  createConversation({ tenantId, userId, title = 'New chat', projectId = null, mode = 'chat' }) {
    if (!MODES.includes(mode)) throw new Error('CHAT_MODE_INVALID');
    if (projectId) {
      const project = this.db.get('SELECT id FROM projects WHERE id=? AND tenant_id=?', projectId, tenantId);
      if (!project) throw new Error('PROJECT_NOT_FOUND');
    }
    const conversationId = id('conv');
    const timestamp = now();
    this.db.run(
      'INSERT INTO conversations(id,tenant_id,user_id,project_id,title,mode,status,last_message_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      conversationId, tenantId, userId, projectId, boundedTitle(title), mode, 'active', null, timestamp, timestamp,
    );
    return this.getConversation({ tenantId, userId, conversationId });
  }

  listConversations({ tenantId, userId, limit = 50, includeArchived = false }) {
    const rows = includeArchived
      ? this.db.all('SELECT id,title,mode,status,project_id,last_message_at,created_at,updated_at FROM conversations WHERE tenant_id=? AND user_id=? ORDER BY updated_at DESC LIMIT ?', tenantId, userId, clampLimit(limit))
      : this.db.all("SELECT id,title,mode,status,project_id,last_message_at,created_at,updated_at FROM conversations WHERE tenant_id=? AND user_id=? AND status='active' ORDER BY updated_at DESC LIMIT ?", tenantId, userId, clampLimit(limit));
    return rows;
  }

  getConversation({ tenantId, userId, conversationId }) {
    const conversation = this.db.get('SELECT * FROM conversations WHERE id=? AND tenant_id=? AND user_id=?', conversationId, tenantId, userId);
    if (!conversation) throw new Error('CONVERSATION_NOT_FOUND');
    const messages = this.db.all(
      'SELECT id,role,content,status,provider,model,usage_json,error,created_at,updated_at FROM chat_messages WHERE conversation_id=? AND tenant_id=? ORDER BY created_at ASC, rowid ASC',
      conversationId, tenantId,
    ).map(deserializeMessage);
    return { ...conversation, messages };
  }

  renameConversation({ tenantId, userId, conversationId, title }) {
    const result = this.db.run('UPDATE conversations SET title=?, updated_at=? WHERE id=? AND tenant_id=? AND user_id=?', boundedTitle(title), now(), conversationId, tenantId, userId);
    if (!result.changes) throw new Error('CONVERSATION_NOT_FOUND');
    return this.getConversation({ tenantId, userId, conversationId });
  }

  archiveConversation({ tenantId, userId, conversationId }) {
    const result = this.db.run("UPDATE conversations SET status='archived', updated_at=? WHERE id=? AND tenant_id=? AND user_id=?", now(), conversationId, tenantId, userId);
    if (!result.changes) throw new Error('CONVERSATION_NOT_FOUND');
    return { archived: true, conversationId };
  }

  deleteConversation({ tenantId, userId, conversationId }) {
    return this.db.transaction(() => {
      const conversation = this.db.get('SELECT id FROM conversations WHERE id=? AND tenant_id=? AND user_id=?', conversationId, tenantId, userId);
      if (!conversation) throw new Error('CONVERSATION_NOT_FOUND');
      const messages = this.db.run('DELETE FROM chat_messages WHERE conversation_id=? AND tenant_id=?', conversationId, tenantId).changes;
      this.db.run('DELETE FROM conversations WHERE id=? AND tenant_id=?', conversationId, tenantId);
      return { deleted: true, conversationId, messages };
    });
  }

  /**
   * Append a message. `userId` is required for `user` role (and ownership is
   * enforced); assistant/system messages may be written by the server without a
   * user identity. Returns the serialized message.
   */
  appendMessage({ tenantId, conversationId, userId = null, role, content, status = 'complete', provider = null, model = null, usage = null, error = null }) {
    assertRole(role);
    assertStatus(status);
    const conversation = this.db.get('SELECT id,user_id FROM conversations WHERE id=? AND tenant_id=?', conversationId, tenantId);
    if (!conversation) throw new Error('CONVERSATION_NOT_FOUND');
    if (role === 'user') {
      if (!userId || conversation.user_id !== userId) throw new Error('CONVERSATION_NOT_FOUND');
    }
    const messageId = id('msg');
    const timestamp = now();
    const body = typeof content === 'string' ? content.slice(0, 200_000) : '';
    this.db.transaction(() => {
      this.db.run(
        'INSERT INTO chat_messages(id,conversation_id,tenant_id,user_id,role,content,status,provider,model,usage_json,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        messageId, conversationId, tenantId, userId, role, body, status, provider, model, usage ? JSON.stringify(usage) : null, error, timestamp, timestamp,
      );
      this.db.run('UPDATE conversations SET last_message_at=?, updated_at=? WHERE id=? AND tenant_id=?', timestamp, timestamp, conversationId, tenantId);
    });
    return deserializeMessage(this.db.get('SELECT id,role,content,status,provider,model,usage_json,error,created_at,updated_at FROM chat_messages WHERE id=?', messageId));
  }

  updateMessage({ tenantId, messageId, patch = {} }) {
    const row = this.db.get('SELECT id FROM chat_messages WHERE id=? AND tenant_id=?', messageId, tenantId);
    if (!row) throw new Error('CHAT_MESSAGE_NOT_FOUND');
    const sets = [];
    const params = [];
    if (patch.content !== undefined) { sets.push('content=?'); params.push(String(patch.content).slice(0, 200_000)); }
    if (patch.status !== undefined) { assertStatus(patch.status); sets.push('status=?'); params.push(patch.status); }
    if (patch.provider !== undefined) { sets.push('provider=?'); params.push(patch.provider); }
    if (patch.model !== undefined) { sets.push('model=?'); params.push(patch.model); }
    if (patch.usage !== undefined) { sets.push('usage_json=?'); params.push(patch.usage ? JSON.stringify(patch.usage) : null); }
    if (patch.error !== undefined) { sets.push('error=?'); params.push(patch.error); }
    if (!sets.length) return deserializeMessage(this.db.get('SELECT id,role,content,status,provider,model,usage_json,error,created_at,updated_at FROM chat_messages WHERE id=?', messageId));
    sets.push('updated_at=?'); params.push(now());
    params.push(messageId, tenantId);
    this.db.run(`UPDATE chat_messages SET ${sets.join(',')} WHERE id=? AND tenant_id=?`, ...params);
    return deserializeMessage(this.db.get('SELECT id,role,content,status,provider,model,usage_json,error,created_at,updated_at FROM chat_messages WHERE id=?', messageId));
  }

  /**
   * Sweep messages that were left mid-stream (process crash / restart) into the
   * terminal `interrupted` state. Returns the affected messages so the caller can
   * surface them to the client for retry. Scoped to one conversation when given.
   */
  recoverInterrupted({ tenantId, userId, conversationId = null }) {
    const placeholders = RECOVERABLE_STATUSES.map(() => '?').join(',');
    return this.db.transaction(() => {
      const scope = conversationId ? ' AND m.conversation_id=?' : '';
      const params = conversationId ? [tenantId, userId, ...RECOVERABLE_STATUSES, conversationId] : [tenantId, userId, ...RECOVERABLE_STATUSES];
      const rows = this.db.all(
        `SELECT m.id,m.conversation_id,m.role,m.content,m.status,m.created_at
           FROM chat_messages m
           JOIN conversations c ON c.id=m.conversation_id
          WHERE c.tenant_id=? AND c.user_id=? AND m.role='assistant' AND m.status IN (${placeholders})${scope}
          ORDER BY m.created_at ASC`,
        ...params,
      );
      if (rows.length) {
        const timestamp = now();
        const ids = rows.map((row) => row.id);
        const marks = ids.map(() => '?').join(',');
        this.db.run(`UPDATE chat_messages SET status='interrupted', updated_at=? WHERE id IN (${marks})`, timestamp, ...ids);
      }
      return rows.map((row) => ({ id: row.id, conversationId: row.conversation_id, role: row.role, content: row.content, status: 'interrupted', createdAt: row.created_at }));
    });
  }

  /** List conversations that currently hold an interrupted assistant reply. */
  listRecoverable({ tenantId, userId }) {
    const placeholders = RECOVERABLE_STATUSES.map(() => '?').join(',');
    return this.db.all(
      `SELECT c.id AS conversation_id, c.title, COUNT(m.id) AS interrupted
         FROM conversations c
         JOIN chat_messages m ON m.conversation_id=c.id
        WHERE c.tenant_id=? AND c.user_id=? AND m.role='assistant' AND m.status IN (${placeholders})
        GROUP BY c.id, c.title
        ORDER BY MAX(m.created_at) DESC`,
      tenantId, userId, ...RECOVERABLE_STATUSES,
    ).map((row) => ({ conversationId: row.conversation_id, title: row.title, interrupted: Number(row.interrupted) || 0 }));
  }
}
