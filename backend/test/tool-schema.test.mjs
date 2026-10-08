import assert from 'node:assert/strict';
import test from 'node:test';

import { assertValidArgs, strictArgsEnabled, validateArgs } from '../agent/tool-schema.mjs';

/**
 * Structured tool-argument validation. These tests prove the validator really
 * rejects malformed model output (wrong type / bad enum / out-of-range / missing
 * required / unknown key) and, crucially, that SAFE mode never rejects an
 * argument a handler would have accepted (non-breaking default).
 */

test('validateArgs enforces the declared type of a provided argument', () => {
  const schema = { type: 'object', properties: { count: { type: 'integer' } } };
  assert.equal(validateArgs(schema, { count: 3 }).valid, true);
  const bad = validateArgs(schema, { count: 'three' });
  assert.equal(bad.valid, false);
  assert.match(bad.errors[0], /expected integer, got string/);
});

test('validateArgs treats number/integer correctly and accepts integers for number', () => {
  assert.equal(validateArgs({ type: 'number' }, 1.5).valid, true);
  assert.equal(validateArgs({ type: 'number' }, 2).valid, true);
  assert.equal(validateArgs({ type: 'integer' }, 2.5).valid, false);
  assert.equal(validateArgs({ type: 'string' }, 'x').valid, true);
  assert.equal(validateArgs({ type: 'boolean' }, true).valid, true);
});

test('validateArgs enforces enum membership', () => {
  const schema = { type: 'string', enum: ['bash', 'python'] };
  assert.equal(validateArgs(schema, 'bash').valid, true);
  const bad = validateArgs(schema, 'ruby');
  assert.equal(bad.valid, false);
  assert.match(bad.errors[0], /not one of/);
});

test('validateArgs enforces numeric bounds, string length and array size', () => {
  assert.equal(validateArgs({ type: 'integer', minimum: 1, maximum: 10 }, 5).valid, true);
  assert.equal(validateArgs({ type: 'integer', minimum: 1, maximum: 10 }, 0).valid, false);
  assert.equal(validateArgs({ type: 'integer', minimum: 1, maximum: 10 }, 11).valid, false);
  assert.equal(validateArgs({ type: 'string', minLength: 2, maxLength: 4 }, 'abc').valid, true);
  assert.equal(validateArgs({ type: 'string', minLength: 2 }, 'a').valid, false);
  assert.equal(validateArgs({ type: 'array', minItems: 1, maxItems: 2 }, []).valid, false);
  assert.equal(validateArgs({ type: 'array', minItems: 1, maxItems: 2 }, [1, 2, 3]).valid, false);
});

test('validateArgs recurses into nested objects and array items', () => {
  const schema = {
    type: 'object',
    properties: {
      steps: { type: 'array', items: { type: 'object', properties: { toolId: { type: 'string' } } } },
    },
  };
  assert.equal(validateArgs(schema, { steps: [{ toolId: 'git.status' }] }).valid, true);
  const bad = validateArgs(schema, { steps: [{ toolId: 42 }] });
  assert.equal(bad.valid, false);
  assert.match(bad.errors[0], /steps\[0\]\.toolId/);
});

test('SAFE mode (default) ignores unknown keys and missing required (non-breaking)', () => {
  const schema = { type: 'object', required: ['goal'], additionalProperties: false, properties: { goal: { type: 'string' } } };
  // No goal, plus an unknown key: safe mode must NOT reject, because a handler
  // may legitimately tolerate both.
  const result = validateArgs(schema, { extra: 1 });
  assert.equal(result.valid, true, 'safe mode must not enforce required/additionalProperties');
});

test('STRICT mode enforces required and rejects unknown properties', () => {
  const schema = { type: 'object', required: ['goal'], additionalProperties: false, properties: { goal: { type: 'string' } } };
  const missing = validateArgs(schema, {}, { strict: true });
  assert.equal(missing.valid, false);
  assert.match(missing.errors[0], /goal: is required/);
  const unknown = validateArgs(schema, { goal: 'x', nope: true }, { strict: true });
  assert.equal(unknown.valid, false);
  assert.match(unknown.errors[0], /unknown property/);
  assert.equal(validateArgs(schema, { goal: 'x' }, { strict: true }).valid, true);
});

test('safe mode still enforces the type of a provided (optional) argument', () => {
  const schema = { type: 'object', properties: { timeout: { type: 'integer', minimum: 0 } } };
  assert.equal(validateArgs(schema, { timeout: -1 }).valid, false);
  assert.equal(validateArgs(schema, {}).valid, true);
});

test('assertValidArgs throws a precise, machine-readable error', () => {
  const schema = { type: 'object', properties: { language: { type: 'string', enum: ['bash'] } } };
  assert.doesNotThrow(() => assertValidArgs('code.run', schema, { language: 'bash' }));
  assert.throws(
    () => assertValidArgs('code.run', schema, { language: 'ruby' }),
    (error) => error.code === 'TOOL_ARGS_INVALID' && error.toolId === 'code.run' && /TOOL_ARGS_INVALID:code.run:/.test(error.message) && Array.isArray(error.details),
  );
});

test('a schema-less tool is always valid (no false rejections)', () => {
  assert.equal(validateArgs(undefined, { anything: true }).valid, true);
  assert.equal(validateArgs({}, { anything: true }).valid, true);
});

test('strictArgsEnabled reflects TOOL_ARG_STRICT exactly', () => {
  assert.equal(strictArgsEnabled({}), false);
  assert.equal(strictArgsEnabled({ TOOL_ARG_STRICT: 'true' }), true);
  assert.equal(strictArgsEnabled({ TOOL_ARG_STRICT: 'TRUE' }), true);
  assert.equal(strictArgsEnabled({ TOOL_ARG_STRICT: '1' }), false);
});
