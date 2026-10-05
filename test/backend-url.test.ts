import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_BACKEND_URL, normalizeBackendUrl, resolveBackendUrl } from '../src/services/api/backend-url';

// -----------------------------------------------------------------------------
// Regression tests for the "فشل التشغيل التنفيذي عبر الـBackend" incident.
//
// The deployed Vercel bundle inlined EXPO_PUBLIC_BACKEND_URL as the malformed
// markdown string `[https://printer-turbo.onrender.com](https://printer-turbo.onrender.com)`.
// `fetch()` then threw, so no agent run could start. The resolver must normalise
// that value and fall back to the known-good backend when it is unusable.
// -----------------------------------------------------------------------------

test('normalizeBackendUrl accepts a plain https origin and strips trailing slashes', () => {
  assert.equal(normalizeBackendUrl('https://ai-semo0o-agent-3.onrender.com'), 'https://ai-semo0o-agent-3.onrender.com');
  assert.equal(normalizeBackendUrl('https://ai-semo0o-agent-3.onrender.com/'), 'https://ai-semo0o-agent-3.onrender.com');
  assert.equal(normalizeBackendUrl('  https://ai-semo0o-agent-3.onrender.com///  '), 'https://ai-semo0o-agent-3.onrender.com');
});

test('normalizeBackendUrl rejects markdown link syntax (the real production bug)', () => {
  // The deployed bundle inlined exactly this WRONG, markdown-wrapped backend.
  // Unwrapping it would keep pointing at the wrong host, so it must be rejected
  // (-> resolveBackendUrl falls back to the known-good default).
  assert.equal(normalizeBackendUrl('[https://printer-turbo.onrender.com](https://printer-turbo.onrender.com)'), '');
  assert.equal(normalizeBackendUrl('[Semo](https://ai-semo0o-agent-3.onrender.com/)'), '');
});

test('normalizeBackendUrl preserves an explicit base path but drops the trailing slash', () => {
  assert.equal(normalizeBackendUrl('https://example.com/api/'), 'https://example.com/api');
});

test('normalizeBackendUrl rejects empty, relative and non-http values', () => {
  assert.equal(normalizeBackendUrl(''), '');
  assert.equal(normalizeBackendUrl('   '), '');
  assert.equal(normalizeBackendUrl(undefined), '');
  assert.equal(normalizeBackendUrl(null), '');
  assert.equal(normalizeBackendUrl('ai-semo0o-agent-3.onrender.com'), '');
  assert.equal(normalizeBackendUrl('/relative/path'), '');
  assert.equal(normalizeBackendUrl('ftp://example.com'), '');
  assert.equal(normalizeBackendUrl('https://exa mple.com'), '');
});

test('resolveBackendUrl falls back to the known-good production backend when unusable', () => {
  assert.equal(resolveBackendUrl(undefined), DEFAULT_BACKEND_URL);
  assert.equal(resolveBackendUrl(''), DEFAULT_BACKEND_URL);
  assert.equal(resolveBackendUrl('not a url'), DEFAULT_BACKEND_URL);
  // The exact malformed production value must resolve to the correct backend.
  assert.equal(
    resolveBackendUrl('[https://printer-turbo.onrender.com](https://printer-turbo.onrender.com)'),
    'https://ai-semo0o-agent-3.onrender.com',
  );
  assert.equal(DEFAULT_BACKEND_URL, 'https://ai-semo0o-agent-3.onrender.com');
});

test('resolveBackendUrl prefers a valid configured backend', () => {
  assert.equal(resolveBackendUrl('https://ai-semo0o-agent-3.onrender.com/'), 'https://ai-semo0o-agent-3.onrender.com');
});
