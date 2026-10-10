import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

// -----------------------------------------------------------------------------
// Artifact download — the "download button 401s" incident.
//
// The Creation Studio's download button used to hand the bare artifact URL to
// `Linking.openURL`. But the backend's artifact route is tenant-scoped and
// Bearer-authenticated (the API uses NO cookies), so a bare URL returns 401 and
// the user can never download the GIF/AVI/MP4/ZIP they just generated.
//
// The fix: fetch the bytes through the API client (which attaches the session
// token) and then trigger a real download. These tests pin that wiring so the
// regression cannot silently return.
// -----------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function read(relative: string): string {
  return readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

test('the Creation screen downloads artifacts with the session token, not a bare URL', () => {
  const source = read('src/screens/Creation.tsx');
  // It must fetch the bytes through the authenticated client...
  assert.match(source, /backendApi\.fetchCreationArtifact\(jobId, name\)/, 'openArtifact must fetch the artifact with auth');
  // ...and then trigger a real download.
  assert.match(source, /downloadBytes\(bytes, filename, mimeType\)/, 'openArtifact must download the fetched bytes');
  // ...and must NOT open the bare (unauthenticated) URL, which 401s.
  assert.doesNotMatch(source, /Linking\.openURL\(artifactUrl\(/, 'must not open the bare artifact URL (it requires auth)');
});

test('fetchCreationArtifact attaches the Bearer token and surfaces server errors', () => {
  const source = read('src/services/api/client.ts');
  assert.match(source, /async fetchCreationArtifact\(id: string, name: 'gif' \| 'avi' \| 'bundle' \| 'mp4'\)/, 'the client must expose fetchCreationArtifact');
  // The request must carry the session token.
  assert.match(source, /authorization: `Bearer \$\{this\.token\}`/, 'fetchCreationArtifact must send the Bearer token');
  // A non-OK response must throw the backend error, never a silent empty file.
  assert.match(source, /throw new Error\(String\(payload\.error \?\? `BACKEND_\$\{response\.status\}`\)\)/, 'fetchCreationArtifact must throw on failure');
  // The misleading "token-free" contract must be gone.
  assert.doesNotMatch(source, /Public \(token-free\) URL for a job artefact/, 'the stale "token-free" claim must be corrected');
});
