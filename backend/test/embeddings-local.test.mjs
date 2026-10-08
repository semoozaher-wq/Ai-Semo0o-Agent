import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  localEmbedding,
  LOCAL_EMBEDDING_DIMENSIONS,
  LOCAL_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_VERSION,
} from '../memory/embeddings.mjs';

/**
 * Local hash embedder v2 (the always-available fallback for RAG / memory search).
 *
 * v2 keeps the same 64 dimensions and the dependency-free, deterministic
 * contract of v1 but hashes word unigrams + character 4-grams with the signed
 * hashing trick, so morphological variants and typos still match. These tests pin
 * the contract AND prove the recall upgrade against a faithful re-implementation
 * of v1 on a labelled related/unrelated set.
 */

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i += 1) dot += a[i] * b[i];
  return dot;
}

// Faithful re-implementation of the ORIGINAL v1 embedder (single sha256 hash,
// bag-of-words unigrams, positive counts, 64-dim, L2-normalised) so we can show
// v2 separates related from unrelated text strictly better than v1 did.
function v1Embedding(text, dimensions = 64) {
  const vector = Array(dimensions).fill(0);
  for (const token of String(text).toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []) {
    const hash = parseInt(createHash('sha256').update(token).digest('hex').slice(0, 8), 16);
    vector[hash % dimensions] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

const RELATED = [
  ['optimize', 'optimization'], ['authenticate', 'authentication'], ['deploy', 'deployment'],
  ['connect', 'connection'], ['configure', 'configuration'],
  ['authentication', 'authentcation'], ['database', 'databse'], ['performance', 'performace'],
  ['optimize the database query', 'database query optimization'],
  ['the user authentication failed', 'user authentication error occurred'],
  ['summarize the long document', 'write a summary of the document'],
  ['deploy the application to production', 'production deployment of the app'],
  ['fix the login bug', 'login bug fix'], ['parse the json response', 'json response parsing'],
];
const UNRELATED = [
  ['optimize', 'banana'], ['deploy the app', 'the volcano erupted'], ['authentication', 'volcano'],
  ['database query', 'sunset painting'], ['user login failed', 'the cat sleeps'],
  ['summarize the document', 'rocket engine thrust'], ['configuration', 'thunderstorm'],
  ['parse the json response', 'bake a chocolate cake'], ['connection', 'guitar'],
  ['performance', 'butterfly'], ['deployment', 'rainforest'],
];

function margin(embed) {
  const mean = (pairs) => pairs.reduce((sum, [a, b]) => sum + cosine(embed(a), embed(b)), 0) / pairs.length;
  return mean(RELATED) - mean(UNRELATED);
}

test('local embedder reports the v2 identity and stays 64-dimensional', () => {
  assert.equal(LOCAL_EMBEDDING_MODEL, 'local-hash-v2');
  assert.equal(LOCAL_EMBEDDING_VERSION, 2);
  assert.equal(LOCAL_EMBEDDING_DIMENSIONS, 64);
  assert.equal(localEmbedding('hello world').length, 64);
  assert.equal(localEmbedding('hello world', 32).length, 32);
});

test('local embedder is deterministic and unit-normalised', () => {
  const a = localEmbedding('optimize the database query');
  const b = localEmbedding('optimize the database query');
  assert.deepEqual(a, b, 'same input => identical vector');
  const norm = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, 'vectors are unit length so cosine == dot product');
  assert.ok(Math.abs(cosine(localEmbedding('hello world'), localEmbedding('hello world')) - 1) < 1e-9);
});

test('local embedder v2 matches morphological variants better than unrelated text', () => {
  const relatedScore = cosine(localEmbedding('optimize'), localEmbedding('optimization'));
  const unrelatedScore = cosine(localEmbedding('optimize'), localEmbedding('banana'));
  assert.ok(relatedScore > unrelatedScore, `morphological variants (${relatedScore.toFixed(3)}) must beat unrelated text (${unrelatedScore.toFixed(3)})`);
  assert.ok(relatedScore > 0.2, 'shared character 4-grams give a real signal');
});

test('local embedder v2 tolerates a typo through shared character n-grams', () => {
  const correct = localEmbedding('authentication');
  const typo = localEmbedding('authentcation'); // missing an "i"
  const unrelated = localEmbedding('volcano');
  assert.ok(cosine(correct, typo) > cosine(correct, unrelated), 'a single-character typo stays close to the intended word');
  assert.ok(cosine(correct, typo) > 0.2);
});

test('local embedder v2 separates related from unrelated text strictly better than v1', () => {
  const v2Margin = margin(localEmbedding);
  const v1Margin = margin(v1Embedding);
  assert.ok(v1Margin < 0.3, `v1 baseline margin should be weak (got ${v1Margin.toFixed(3)})`);
  assert.ok(v2Margin > v1Margin, `v2 (${v2Margin.toFixed(3)}) must beat v1 (${v1Margin.toFixed(3)})`);
  assert.ok(v2Margin > 0.35, `v2 should give a strong positive margin (got ${v2Margin.toFixed(3)})`);
});

test('local embedder handles empty / non-string input without throwing', () => {
  assert.equal(localEmbedding('').length, 64);
  assert.equal(localEmbedding(undefined).length, 64);
  assert.equal(localEmbedding(12345).length, 64);
});
