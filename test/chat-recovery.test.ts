import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import {
  sweepInterruptedChats,
  markInterruptedMessages,
  planInterruptedRetry,
  runBootstrapRecovery,
  type ChatRecoveryClient,
} from '../src/services/chat/recovery';
import type { Conversation, Message } from '../src/types/chat';

// -----------------------------------------------------------------------------
// Chat recovery — the "reply left mid-stream" incident.
//
// When the app or the backend dies mid-stream, an assistant turn is stuck
// `streaming` forever. The backend exposes `GET /chat/recoverable` +
// `POST /conversations/:id/recover` to reconcile it, and the chat store has a
// `recoverInterrupted()` method — but nothing ever called it, so the endpoints
// were dead from the app's point of view and the UI spun forever.
//
// These tests pin the extracted, dependency-free recovery logic AND the startup
// wiring that was missing.
// -----------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function message(overrides: Partial<Message> & Pick<Message, 'id' | 'role' | 'status'>): Message {
  return {
    conversationId: 'conv_local',
    content: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  } as Message;
}

function conversation(overrides: Partial<Conversation> & Pick<Conversation, 'id'>): Conversation {
  return {
    title: 't',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    model: 'gpt-4o-mini',
    messageCount: 0,
    ...overrides,
  } as Conversation;
}

function client(overrides: Partial<ChatRecoveryClient>): ChatRecoveryClient {
  return {
    getRecoverableChats: async () => ({ conversations: [] }),
    recoverChat: async () => ({ recovered: [] }),
    ...overrides,
  };
}

test('sweepInterruptedChats is a no-op when the backend reports nothing recoverable', async () => {
  let recoverCalls = 0;
  const result = await sweepInterruptedChats(
    client({
      getRecoverableChats: async () => ({ conversations: [] }),
      recoverChat: async () => {
        recoverCalls += 1;
        return { recovered: [] };
      },
    }),
  );
  assert.deepEqual(result, { recoveredCount: 0, recoveredBackendIds: [] });
  assert.equal(recoverCalls, 0, 'must not call recover when nothing is recoverable');
});

test('sweepInterruptedChats sweeps every thread and sums the recovered turns', async () => {
  const swept: string[] = [];
  const result = await sweepInterruptedChats(
    client({
      getRecoverableChats: async () => ({ conversations: [{ conversationId: 'c1' }, { conversationId: 'c2' }] }),
      recoverChat: async (id) => {
        swept.push(id);
        return { recovered: id === 'c1' ? [{ id: 'm1' }] : [{ id: 'm2' }, { id: 'm3' }] };
      },
    }),
  );
  assert.deepEqual(swept, ['c1', 'c2']);
  assert.equal(result.recoveredCount, 3);
  assert.deepEqual(result.recoveredBackendIds, ['c1', 'c2']);
});

test('a single failing thread does not abort the sweep of the rest', async () => {
  const result = await sweepInterruptedChats(
    client({
      getRecoverableChats: async () => ({ conversations: [{ conversationId: 'bad' }, { conversationId: 'good' }] }),
      recoverChat: async (id) => {
        if (id === 'bad') throw new Error('CHAT_RECOVER_FAILED');
        return { recovered: [{ id: 'm1' }] };
      },
    }),
  );
  assert.equal(result.recoveredCount, 1);
  assert.deepEqual(result.recoveredBackendIds, ['good'], 'the failed thread is not reported as recovered');
});

test('markInterruptedMessages sweeps only streaming/pending assistant turns in recovered threads', () => {
  const messages: Record<string, Message[]> = {
    localA: [
      message({ id: 'a1', role: 'user', status: 'complete', content: 'hi' }),
      message({ id: 'a2', role: 'assistant', status: 'streaming', content: 'partial' }),
    ],
    localB: [
      message({ id: 'b1', role: 'assistant', status: 'complete', content: 'done' }),
      message({ id: 'b2', role: 'assistant', status: 'pending' }),
    ],
    localC: [message({ id: 'c1', role: 'assistant', status: 'streaming' })],
  };
  const conversations: Conversation[] = [
    conversation({ id: 'localA', backendId: 'backendA' }),
    conversation({ id: 'localB', backendId: 'backendB' }),
    conversation({ id: 'localC', backendId: 'backendC' }),
  ];

  const next = markInterruptedMessages(messages, conversations, ['backendA', 'backendB']);

  assert.equal(next.localA?.[1]?.status, 'interrupted');
  assert.equal(next.localB?.[1]?.status, 'interrupted');
  // Not recovered -> untouched.
  assert.equal(next.localC?.[0]?.status, 'streaming');
  // Completed turns are never rewritten.
  assert.equal(next.localB?.[0]?.status, 'complete');
  // The input map is not mutated.
  assert.equal(messages.localA?.[1]?.status, 'streaming');
});

test('markInterruptedMessages returns the same reference when nothing changed', () => {
  const messages: Record<string, Message[]> = { localA: [message({ id: 'a1', role: 'assistant', status: 'complete' })] };
  const conversations = [conversation({ id: 'localA', backendId: 'backendA' })];
  assert.equal(markInterruptedMessages(messages, conversations, []), messages);
  assert.equal(markInterruptedMessages(messages, conversations, ['backendA']), messages);
  // A thread the backend recovered but that has no local messages is untouched.
  assert.equal(markInterruptedMessages(messages, [conversation({ id: 'missing', backendId: 'backendZ' })], ['backendZ']), messages);
});

test('planInterruptedRetry replays the user turn behind the last interrupted reply', () => {
  const list: Message[] = [
    message({ id: 'u1', role: 'user', status: 'complete', content: 'first' }),
    message({ id: 'a1', role: 'assistant', status: 'complete', content: 'ok' }),
    message({ id: 'u2', role: 'user', status: 'complete', content: 'second' }),
    message({ id: 'a2', role: 'assistant', status: 'interrupted', content: 'partial' }),
  ];
  assert.deepEqual(planInterruptedRetry(list), { content: 'second', keepCount: 3 });
});

test('planInterruptedRetry returns null when there is nothing to retry', () => {
  assert.equal(planInterruptedRetry(undefined), null);
  assert.equal(planInterruptedRetry([]), null);
  assert.equal(planInterruptedRetry([message({ id: 'a1', role: 'assistant', status: 'complete' })]), null);
  // An interrupted assistant turn with no preceding user turn cannot be replayed.
  assert.equal(planInterruptedRetry([message({ id: 'a1', role: 'assistant', status: 'interrupted' })]), null);
});

test('runBootstrapRecovery invokes recovery and swallows failures (never blocks startup)', async () => {
  let called = 0;
  const ok = await runBootstrapRecovery({
    recoverInterrupted: async () => {
      called += 1;
      return 2;
    },
  });
  assert.equal(called, 1);
  assert.equal(ok, 2);

  const failed = await runBootstrapRecovery({
    recoverInterrupted: async () => {
      throw new Error('BACKEND_OFFLINE');
    },
  });
  assert.equal(failed, 0, 'a failing recovery must resolve to 0, not reject');
});

test('useBootstrap actually invokes the recovery sweep on startup (regression guard)', () => {
  // The bug this whole module exists for: `recoverInterrupted()` was defined on
  // the store but called from nowhere, so the backend recovery endpoints were
  // never reached. This guards the wiring.
  const source = readFileSync(path.join(__dirname, '..', 'src', 'hooks', 'useBootstrap.ts'), 'utf8');
  assert.match(source, /runBootstrapRecovery\(useChatStore\.getState\(\)\)/, 'useBootstrap must run chat recovery after hydration');
});
