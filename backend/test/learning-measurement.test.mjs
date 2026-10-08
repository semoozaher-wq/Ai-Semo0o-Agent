import assert from 'node:assert/strict';
import test from 'node:test';

import { OUTCOME_SCORES } from '../agent/evaluation.mjs';
import { gradedReward, weightedStats } from '../agent/experience.mjs';

/**
 * Learning-loop MEASUREMENT harness — does the GRADED signal actually make better
 * decisions than the old BINARY one?
 *
 * v2 learned from a coin-flip success signal; v3 learns from the graded outcome
 * (completed=1.0 ... failed=0.0). This file proves, with a deterministic
 * counterfactual, that the graded signal produces measurably better decisions
 * against the SAME objective (the true graded reward):
 *
 *   A. Ranking  — on a fixed dataset the binary estimate mis-ranks two arms that
 *      the graded estimate orders correctly.
 *   B. Decision quality — over a long simulated run the graded policy earns a
 *      higher true graded reward than the binary policy, and approaches the
 *      clairvoyant optimum.
 *   C. No-regression — when outcomes are purely completed/failed (no partial
 *      outcomes) the graded and binary policies are identical.
 */

/* ------------------------------ simulation kit ---------------------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUCCESS = new Set(['completed', 'completed_with_warnings']);

/** Draw a terminal status from an arm's outcome distribution. */
function sampleOutcome(rng, dist) {
  const r = rng();
  let acc = 0;
  for (const [status, p] of Object.entries(dist)) {
    acc += p;
    if (r < acc) return status;
  }
  return Object.keys(dist)[Object.keys(dist).length - 1];
}

/** The learned policy: pick the arm with the highest Wilson lower bound. */
function chooseArm(obsByArm, { rewardMode, nowMs }) {
  let best = null;
  let bestScore = -1;
  for (const [arm, obs] of Object.entries(obsByArm)) {
    const stats = weightedStats(obs, { rewardMode, nowMs, halfLifeHours: 24 * 365 });
    if (stats.wilsonLowerBound > bestScore) { bestScore = stats.wilsonLowerBound; best = arm; }
  }
  return best ?? Object.keys(obsByArm)[0];
}

/* --------------------------- A. ranking quality --------------------------- */

test('MEASUREMENT A: the graded estimate ranks arms by true graded reward; binary mis-ranks them', () => {
  // Arm "warn-heavy" is a binary success every time but earns a low graded reward
  // (it mostly produces warnings). Arm "clean" fails sometimes but is usually a
  // clean completion, so its graded reward is higher.
  const warnHeavy = { completed: 0.2, completed_with_warnings: 0.8, failed: 0 };
  const clean = { completed: 0.85, completed_with_warnings: 0.05, failed: 0.1 };
  const trueGraded = (dist) => Object.entries(dist).reduce((sum, [status, p]) => sum + p * OUTCOME_SCORES[status], 0);
  assert.ok(trueGraded(clean) > trueGraded(warnHeavy), 'ground truth: clean has the higher graded reward');

  // A fixed, identical dataset of 40 outcomes per arm.
  const rng = mulberry32(0xA11CE);
  const build = (dist) => Array.from({ length: 40 }, () => {
    const status = sampleOutcome(rng, dist);
    return { success: SUCCESS.has(status), reward: gradedReward(status), atMs: 0 };
  });
  const obs = { warnHeavy: build(warnHeavy), clean: build(clean) };

  const gradedPick = chooseArm(obs, { rewardMode: 'graded', nowMs: 1 });
  const binaryPick = chooseArm(obs, { rewardMode: 'binary', nowMs: 1 });
  assert.equal(gradedPick, 'clean', 'the graded policy picks the truly better arm');
  assert.equal(binaryPick, 'warnHeavy', 'the binary policy is fooled by the perfect success rate');
});

/* --------------------------- B. decision quality -------------------------- */

test('MEASUREMENT B: the graded policy earns a higher true graded reward than the binary policy', () => {
  const arms = {
    warnHeavy: { completed: 0.2, completed_with_warnings: 0.8, failed: 0 },
    clean: { completed: 0.85, completed_with_warnings: 0.05, failed: 0.1 },
  };
  const ROUNDS = 1500;
  const WARMUP = 500;
  const EXPLORE = 0.3;
  const clairvoyant = Math.max(
    Object.entries(arms.warnHeavy).reduce((s, [k, p]) => s + p * OUTCOME_SCORES[k], 0),
    Object.entries(arms.clean).reduce((s, [k, p]) => s + p * OUTCOME_SCORES[k], 0),
  );

  const run = (rewardMode) => {
    const rng = mulberry32(0xBEEF); // identical noise + exploration for both policies
    const explore = Array.from({ length: ROUNDS }, () => rng() < EXPLORE);
    const obs = { warnHeavy: [], clean: [] };
    let steadySum = 0;
    let steadyN = 0;
    for (let r = 0; r < ROUNDS; r += 1) {
      const arm = explore[r] ? (rng() < 0.5 ? 'warnHeavy' : 'clean') : chooseArm(obs, { rewardMode, nowMs: r });
      const status = sampleOutcome(rng, arms[arm]);
      const reward = gradedReward(status); // the TRUE objective for both policies
      obs[arm].push({ success: SUCCESS.has(status), reward, atMs: r });
      if (r >= WARMUP) { steadySum += reward; steadyN += 1; }
    }
    return steadySum / steadyN;
  };

  const binaryResult = run('binary');
  const gradedResult = run('graded');
  console.log(`  B: steady-state true graded reward — binary ${(binaryResult * 100).toFixed(1)}% vs graded ${(gradedResult * 100).toFixed(1)}% (clairvoyant ${(clairvoyant * 100).toFixed(1)}%)`);

  assert.ok(gradedResult > binaryResult + 0.05, `graded must beat binary by a real margin (got ${gradedResult} vs ${binaryResult})`);
  assert.ok(gradedResult >= clairvoyant - 0.03, 'the graded policy captures most of the available improvement');
});

/* --------------------------- C. no-regression ----------------------------- */

test('MEASUREMENT C: with no partial outcomes the graded and binary policies are identical', () => {
  // Pure completed/failed: the graded reward is exactly the binary signal.
  const arms = {
    a: { completed: 0.6, failed: 0.4 },
    b: { completed: 0.5, failed: 0.5 },
  };
  const rng = mulberry32(0x5EED);
  const obs = { a: [], b: [] };
  for (let r = 0; r < 200; r += 1) {
    for (const arm of ['a', 'b']) {
      const status = sampleOutcome(rng, arms[arm]);
      obs[arm].push({ success: SUCCESS.has(status), reward: gradedReward(status), atMs: r });
    }
  }
  assert.equal(
    chooseArm(obs, { rewardMode: 'graded', nowMs: 200 }),
    chooseArm(obs, { rewardMode: 'binary', nowMs: 200 }),
    'no partial outcomes -> graded and binary agree exactly',
  );
});
