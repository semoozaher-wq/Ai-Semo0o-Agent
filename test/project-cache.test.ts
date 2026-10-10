import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectCache, type ProjectClient } from '../src/services/chat/project-cache';

// -----------------------------------------------------------------------------
// Session-scoped project cache — the cross-tenant / stuck-forever incident.
//
// The agent project was cached in a module-level object that was never
// invalidated, so (a) after a re-login as another account the previous tenant's
// project was reused, and (b) a failed creation cached its rejected promise
// forever. These tests pin the fixes.
// -----------------------------------------------------------------------------

function client(overrides: Partial<ProjectClient> = {}): ProjectClient {
  let counter = 0;
  return {
    requireSession: async () => ({ id: 'user_1', tenantId: 'tenant_1' }),
    createProject: async () => ({ projectId: `p_${(counter += 1)}`, workspaceId: `w_${counter}` }),
    ...overrides,
  };
}

test('resolve creates the project once and reuses it for the same session', async () => {
  let createCalls = 0;
  const cache = new ProjectCache(
    client({
      createProject: async () => {
        createCalls += 1;
        return { projectId: 'p1', workspaceId: 'w1' };
      },
    }),
  );
  const first = await cache.resolve();
  const second = await cache.resolve();
  assert.deepEqual(first, { projectId: 'p1', workspaceId: 'w1' });
  assert.deepEqual(second, first);
  assert.equal(createCalls, 1, 'the project must be created only once per session');
});

test('concurrent resolves share a single in-flight creation', async () => {
  let createCalls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const cache = new ProjectCache(
    client({
      createProject: async () => {
        createCalls += 1;
        await gate;
        return { projectId: 'p1', workspaceId: 'w1' };
      },
    }),
  );
  const first = cache.resolve();
  const second = cache.resolve();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(createCalls, 1, 'two concurrent calls must not create two projects');
  assert.deepEqual(a, b);
});

test('a session change invalidates the cache (no cross-tenant reuse)', async () => {
  let session = { id: 'user_1', tenantId: 'tenant_1' };
  const created: string[] = [];
  const cache = new ProjectCache(
    client({
      requireSession: async () => session,
      createProject: async () => {
        const id = `p_${session.tenantId}`;
        created.push(id);
        return { projectId: id, workspaceId: `w_${session.tenantId}` };
      },
    }),
  );
  const first = await cache.resolve();
  assert.deepEqual(first, { projectId: 'p_tenant_1', workspaceId: 'w_tenant_1' });

  // Re-login as a different tenant/user.
  session = { id: 'user_2', tenantId: 'tenant_2' };
  const second = await cache.resolve();
  assert.deepEqual(second, { projectId: 'p_tenant_2', workspaceId: 'w_tenant_2' });
  assert.deepEqual(created, ['p_tenant_1', 'p_tenant_2']);
});

test('reset() forces a fresh creation on the next resolve', async () => {
  let createCalls = 0;
  const cache = new ProjectCache(
    client({
      createProject: async () => {
        createCalls += 1;
        return { projectId: `p${createCalls}`, workspaceId: `w${createCalls}` };
      },
    }),
  );
  await cache.resolve();
  cache.reset();
  const after = await cache.resolve();
  assert.equal(createCalls, 2);
  assert.deepEqual(after, { projectId: 'p2', workspaceId: 'w2' });
});

test('a rejected creation is not cached and can be retried', async () => {
  let attempts = 0;
  const cache = new ProjectCache(
    client({
      createProject: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('NETWORK_DOWN');
        return { projectId: 'p_ok', workspaceId: 'w_ok' };
      },
    }),
  );
  await assert.rejects(() => cache.resolve(), /NETWORK_DOWN/);
  const retried = await cache.resolve();
  assert.deepEqual(retried, { projectId: 'p_ok', workspaceId: 'w_ok' });
  assert.equal(attempts, 2, 'the failed attempt must not be cached');
});
