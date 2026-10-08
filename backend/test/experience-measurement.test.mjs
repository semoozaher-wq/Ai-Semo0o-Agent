import assert from 'node:assert/strict';
import test from 'node:test';

import {
  recommendStrategy,
  weightedStats,
  wilsonLowerBound,
} from '../agent/experience.mjs';

/**
 * Experience Engine v2 — MEASUREMENT harness.
 *
 * The unit tests prove the estimators behave as specified. This file proves the
 * stronger claim the task demands: that the LEARNED policy actually makes BETTER
 * decisions than the static one, and that the data-quality protections (Wilson
 * lower bound, recency weighting) are what make it better. Every experiment is a
 * deterministic counterfactual simulation driven by a seeded PRNG, so the
 * numbers are reproducible and the comparison is apples-to-apples.
 *
 *   A. Estimator robustness  — Wilson lower bound vs a raw success rate when a
 *      newcomer arm has a lucky small sample.
 *   B. Decision quality       — learned strategy selection vs the static default
 *      over a long run, against a clairvoyant upper bound.
 *   C. Staleness adaptation   — recency-weighted vs unweighted when the world
 *      changes underneath the policy.
 *   D. No-regression          — with thin evidence the learned policy is
 *      byte-for-byte the static policy.
 */

/* ------------------------------ simulation kit ---------------------------- */

/** Deterministic PRNG (mulberry32) so every experiment is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sample one Bernoulli(p) outcome. */
const bernoulli = (rng, p) => (rng() < p ? 1 : 0);

/** The learned policy: pick the strategy the real recommender endorses. */
function chooseStrategy(obsByStrategy, { taskType = 'code', halfLifeHours, nowMs, weighted = true } = {}) {
  const table = {};
  for (const [strategy, obs] of Object.entries(obsByStrategy)) {
    const stats = weightedStats(obs, { halfLifeHours, nowMs });
    table[strategy] = {
      successRate: weighted ? stats.wilsonLowerBound : stats.successRate,
      confidence: stats.confidence,
      attempts: stats.attempts,
    };
  }
  const rec = recommendStrategy({ [taskType]: table }, taskType);
  return rec ? rec.strategy : 'single-agent';
}

/* --------------------- A. estimator robustness ---------------------------- */

test('MEASUREMENT A: the Wilson lower bound is not fooled by a lucky small sample', () => {
  const rng = mulberry32(0xC0FFEE);
  const TRIALS = 5000;
  // The incumbent (arm A) is genuinely better (0.90) but the newcomer (arm B)
  // has a tiny 2-observation sample that can look perfect by luck.
  const incumbent = { p: 0.9, n: 20 };
  const newcomer = { p: 0.5, n: 2 };
  let rawCorrect = 0;
  let wilsonCorrect = 0;
  for (let i = 0; i < TRIALS; i += 1) {
    let a = 0; for (let k = 0; k < incumbent.n; k += 1) a += bernoulli(rng, incumbent.p);
    let b = 0; for (let k = 0; k < newcomer.n; k += 1) b += bernoulli(rng, newcomer.p);
    // Raw mean picks the newcomer whenever its tiny sample looks perfect.
    if (!(b / newcomer.n > a / incumbent.n)) rawCorrect += 1;
    // Wilson lower bound discounts the tiny sample.
    if (!(wilsonLowerBound(b, newcomer.n) > wilsonLowerBound(a, incumbent.n))) wilsonCorrect += 1;
  }
  const rawAccuracy = rawCorrect / TRIALS;
  const wilsonAccuracy = wilsonCorrect / TRIALS;
  console.log(`  A: raw-rate accuracy ${(rawAccuracy * 100).toFixed(1)}% vs Wilson-LB accuracy ${(wilsonAccuracy * 100).toFixed(1)}%`);
  assert.ok(wilsonAccuracy > 0.97, `Wilson-LB should almost always pick the proven arm (got ${wilsonAccuracy})`);
  assert.ok(wilsonAccuracy - rawAccuracy > 0.1, `Wilson-LB must beat the raw rate by a real margin (got ${wilsonAccuracy - rawAccuracy})`);
  assert.ok(rawAccuracy < 0.9, 'the raw rate is demonstrably fooled by lucky small samples');
});

/* --------------------- B. decision quality over time ---------------------- */

test('MEASUREMENT B: the learned strategy beats the static default and approaches the clairvoyant bound', () => {
  const rng = mulberry32(0xBEEF);
  const ROUNDS = 800;
  const WARMUP = 400; // measure steady state, not the cold-start
  const EXPLORE = 0.3; // fraction of runs where a caller explicitly opts into multi-agent
  const TRUE = { 'single-agent': 0.55, 'multi-agent': 0.85 };
  const bestStrategy = 'multi-agent'; // clairvoyant choice

  // A fixed exploration schedule shared by BOTH policies, so the only thing that
  // differs is the exploit decision — this isolates the effect of learning.
  const explore = Array.from({ length: ROUNDS }, () => rng() < EXPLORE);

  const run = (learned) => {
    const obs = { 'single-agent': [], 'multi-agent': [] };
    let successes = 0;
    let steadySuccesses = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const strategy = explore[round]
        ? 'multi-agent'
        : (learned ? chooseStrategy(obs, { nowMs: round, halfLifeHours: 24 * 365 }) : 'single-agent');
      const outcome = bernoulli(rng, TRUE[strategy]);
      obs[strategy].push({ success: outcome === 1, atMs: round });
      successes += outcome;
      if (round >= WARMUP) steadySuccesses += outcome;
    }
    return { overall: successes / ROUNDS, steady: steadySuccesses / (ROUNDS - WARMUP) };
  };

  const staticResult = run(false);
  const learnedResult = run(true);
  const clairvoyant = TRUE[bestStrategy];
  console.log(`  B: static ${(staticResult.overall * 100).toFixed(1)}% | learned ${(learnedResult.overall * 100).toFixed(1)}% | clairvoyant ${(clairvoyant * 100).toFixed(1)}%`);
  console.log(`  B: learned steady-state ${(learnedResult.steady * 100).toFixed(1)}%`);

  assert.ok(learnedResult.overall > staticResult.overall + 0.1, 'learning must beat the static default by a real margin');
  assert.ok(learnedResult.steady > 0.8, 'in steady state the learned policy should exploit the proven winner');
  assert.ok(learnedResult.steady >= clairvoyant - 0.05, 'the learned policy should capture most of the available improvement');
});

/* --------------------- C. staleness adaptation ---------------------------- */

test('MEASUREMENT C: recency weighting adapts when the world changes; an unweighted policy lags', () => {
  const ROUNDS = 600;
  const CHANGE_AT = 150;
  const WINDOW = 150; // measure the transition window right after the change
  const EXPLORE = 0.3;
  const HOURS_PER_ROUND = 12; // sim time: each round advances 12h
  const HALF_LIFE_HOURS = 24 * 7; // 7-day half-life

  // Phase 1: multi-agent is great. Phase 2: it collapses; single-agent is now best.
  const rateAt = (strategy, round) => {
    if (strategy === 'multi-agent') return round < CHANGE_AT ? 0.9 : 0.2;
    return round < CHANGE_AT ? 0.5 : 0.6;
  };

  const run = (weighted) => {
    const rng = mulberry32(weighted ? 0x1234 : 0x1234); // identical noise for both
    const explore = Array.from({ length: ROUNDS }, () => rng() < EXPLORE);
    const obs = { 'single-agent': [], 'multi-agent': [] };
    let windowSuccesses = 0;
    let windowRounds = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const nowMs = round * HOURS_PER_ROUND * 3_600_000;
      const strategy = explore[round]
        ? 'multi-agent'
        : chooseStrategy(obs, { nowMs, halfLifeHours: weighted ? HALF_LIFE_HOURS : 24 * 3650, weighted });
      const outcome = bernoulli(rng, rateAt(strategy, round));
      obs[strategy].push({ success: outcome === 1, atMs: nowMs });
      if (round >= CHANGE_AT && round < CHANGE_AT + WINDOW) { windowSuccesses += outcome; windowRounds += 1; }
    }
    return windowSuccesses / windowRounds;
  };

  const weighted = run(true);
  const unweighted = run(false);
  console.log(`  C: transition-window success — recency-weighted ${(weighted * 100).toFixed(1)}% vs unweighted ${(unweighted * 100).toFixed(1)}%`);
  assert.ok(weighted > unweighted + 0.03, `recency weighting must adapt faster (got ${weighted} vs ${unweighted})`);
});

/* --------------------- D. no-regression on thin data ---------------------- */

test('MEASUREMENT D: with thin evidence the learned policy is exactly the static policy', () => {
  const cases = [
    {},
    { 'single-agent': [] },
    { 'single-agent': [{ success: true, atMs: 0 }] }, // one observation: below the gate
    { 'multi-agent': [{ success: true, atMs: 0 }, { success: true, atMs: 1 }] }, // one strategy only
  ];
  for (const obs of cases) {
    assert.equal(chooseStrategy(obs, { nowMs: 10 }), 'single-agent', 'thin evidence must never flip the default');
  }
});
