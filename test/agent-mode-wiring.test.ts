import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

// -----------------------------------------------------------------------------
// Agent-mode wiring — the "mode: 'agent' is unreachable" incident.
//
// `useChatStore.send()` has always accepted `{ mode: 'agent' }` and, when set,
// drives a real backend run (`createRun` → `streamEvents` → `getRun`). But every
// call site in the UI invoked `send(text, { attachments })` with the default
// mode, so the entire agent path was dead from the app's point of view: tapping
// "send" could never start an agent run.
//
// These tests pin the wiring end-to-end at the source level (the same technique
// used by chat-recovery.test.ts), so a future refactor that silently drops the
// mode argument fails loudly instead of shipping a dead code path.
// -----------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function read(relative: string): string {
  return readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

test('Composer exposes a chat/agent mode toggle and forwards it to onSubmit', () => {
  const source = read('src/components/composite/Composer.tsx');
  // The mode type and state exist.
  assert.match(source, /export type TurnMode = 'chat' \| 'agent'/, 'Composer must export the TurnMode union');
  assert.match(source, /React\.useState<TurnMode>/, 'Composer must hold the current mode in state');
  // The toggle actually flips between the two modes.
  assert.match(source, /setMode\(\(prev\) => \(prev === 'agent' \? 'chat' : 'agent'\)\)/, 'the toggle must flip chat <-> agent');
  // The chosen mode is passed through to the parent on send (not dropped).
  assert.match(source, /onSubmit\(text\.trim\(\), attachments, mode\)/, 'Composer must forward the selected mode to onSubmit');
  // The callback contract carries the mode.
  assert.match(source, /onSubmit: \(text: string, attachments: Attachment\[\], mode: TurnMode\) => void/, 'onSubmit signature must include mode');
});

test('Chat screen forwards the composer mode into the chat store', () => {
  const source = read('src/screens/Chat.tsx');
  assert.match(source, /void send\(text, \{ attachments, mode \}\)/, 'Chat.handleSubmit must pass mode to send()');
  // handleSubmit must actually receive mode from the composer.
  assert.match(source, /text: string, attachments: Attachment\[\], mode: 'chat' \| 'agent'/, 'Chat.handleSubmit must accept the mode argument');
});

test('Dashboard forwards the composer mode into the chat store', () => {
  const source = read('src/screens/Dashboard.tsx');
  assert.match(source, /void send\(text, \{ attachments, mode \}\)/, 'Dashboard must pass mode to send()');
});

test('the store agent branch drives a real backend run (createRun -> streamEvents -> getRun)', () => {
  const source = read('src/store/useChatStore.ts');
  // Branch on the agent mode.
  assert.match(source, /if \(mode === 'chat'\)/, 'generateReply must branch on the mode');
  // Real backend actions for the agent path.
  assert.match(source, /backendApi\.createRun\(\{ kind: 'agent\.run'/, 'agent mode must create a real agent.run');
  assert.match(source, /backendApi\.streamEvents\(run\.runId/, 'agent mode must stream the run events');
  assert.match(source, /backendApi\.getRun\(run\.runId\)/, 'agent mode must read the final run snapshot');
  // The goal passed to the run is the (attachment-aware) prompt content.
  assert.match(source, /goal: content/, 'the run goal must be the composed prompt content');
});

test('send() defaults to chat but honours an explicit agent mode', () => {
  const source = read('src/store/useChatStore.ts');
  assert.match(source, /const mode = opts\?\.mode \?\? 'chat'/, "send() must default to 'chat' when no mode is given");
  assert.match(source, /generateReply\(conversationId, assistantId, withAttachmentReferences\(content, referenceOnly\), model, mode, token, attachmentIds\)/, 'send() must thread the resolved mode into generateReply');
});
