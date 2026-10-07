/**
 * phase2-core/impact.mjs — Impact Analysis (blast radius).
 *
 * Consumes the index produced by `buildProjectIntelligence` (platform.mjs) and
 * answers a single question: "if these files change, what else is affected?".
 *
 * It builds a reverse dependency graph from the forward import graph, walks the
 * transitive closure (the blast radius), maps affected tests via the index test
 * mapping, lists the symbols whose behaviour may change, and produces a
 * deterministic, explainable risk score.
 *
 * This module is pure and side-effect free: it never touches the filesystem or
 * the network, so it is safe to call from tools, the backend runtime, and tests.
 * It does not re-implement any indexing — it only consumes the existing index.
 */

const toPosix = (value) => String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '');

/** Normalise a workspace-relative path to a stable POSIX form. */
export function normalizePath(value) {
  return toPosix(value).replace(/\/{2,}/g, '/');
}

/** Reverse dependency graph: imported file -> Set of files that import it. */
export function buildReverseGraph(edges = []) {
  const reverse = new Map();
  for (const edge of edges) {
    const from = normalizePath(edge?.from);
    const to = normalizePath(edge?.to);
    if (!from || !to || from === to) continue;
    if (!reverse.has(to)) reverse.set(to, new Set());
    reverse.get(to).add(from);
  }
  return reverse;
}

/** Forward dependency graph: file -> Set of files it imports. */
export function buildForwardGraph(edges = []) {
  const forward = new Map();
  for (const edge of edges) {
    const from = normalizePath(edge?.from);
    const to = normalizePath(edge?.to);
    if (!from || !to || from === to) continue;
    if (!forward.has(from)) forward.set(from, new Set());
    forward.get(from).add(to);
  }
  return forward;
}

/** Breadth-first transitive closure over the reverse graph, excluding seeds. */
function transitiveDependents(reverse, seeds, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : Infinity;
  const seedSet = new Set([...seeds].map(normalizePath));
  const depth = new Map();
  const order = [];
  let queue = [...seedSet].map((file) => ({ file, depth: 0 }));
  while (queue.length) {
    const next = [];
    for (const { file, depth: current } of queue) {
      if (current >= maxDepth) continue;
      for (const dependent of reverse.get(file) ?? []) {
        if (seedSet.has(dependent) || depth.has(dependent)) continue;
        depth.set(dependent, current + 1);
        order.push(dependent);
        next.push({ file: dependent, depth: current + 1 });
      }
    }
    queue = next;
  }
  return { files: order, depth };
}

/**
 * Deterministic risk score in [0, 100] from four explainable factors:
 * blast radius breadth, test coverage (untested changes are riskier), fan-in of
 * the most central changed file, and dependency-chain depth.
 */
export function scoreRisk({ changedFiles = [], blastRadius = [], affectedTests = [], maxFanIn = 0, maxDepth = 0 } = {}) {
  const factors = [];
  let score = 0;
  const changeCount = changedFiles.length + blastRadius.length;

  const breadth = Math.min(blastRadius.length, 40);
  const breadthWeight = (breadth / 40) * 35;
  score += breadthWeight;
  factors.push({ name: 'blast_radius', value: blastRadius.length, weight: round2(breadthWeight) });

  // An empty change set has nothing to test, so it is not penalised.
  const testWeight = changeCount === 0 ? 0 : affectedTests.length === 0 ? 30 : Math.max(0, 20 - affectedTests.length * 4);
  score += testWeight;
  factors.push({ name: 'test_coverage', value: affectedTests.length, weight: round2(testWeight) });

  const hubWeight = (Math.min(maxFanIn, 8) / 8) * 20;
  score += hubWeight;
  factors.push({ name: 'fan_in', value: maxFanIn, weight: round2(hubWeight) });

  const depthWeight = (Math.min(maxDepth, 6) / 6) * 15;
  score += depthWeight;
  factors.push({ name: 'dependency_depth', value: maxDepth, weight: round2(depthWeight) });

  const rounded = Math.round(Math.min(100, score));
  const level = rounded >= 75 ? 'critical' : rounded >= 50 ? 'high' : rounded >= 25 ? 'medium' : 'low';
  return { score: rounded, level, factors };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Analyse the impact of a set of changed files against a project index.
 *
 * @param {object} intelligence  Output of `buildProjectIntelligence`.
 * @param {object} [options]
 * @param {string[]} [options.changedFiles]  Workspace-relative changed paths.
 * @param {number} [options.maxDepth]        Limit the blast-radius depth.
 */
export function analyzeImpact(intelligence = {}, options = {}) {
  const changedFiles = [...new Set((options.changedFiles ?? []).map(normalizePath).filter(Boolean))];
  const changedSet = new Set(changedFiles);

  const edges = intelligence.importGraph ?? intelligence.dependencyGraph ?? [];
  const reverse = buildReverseGraph(edges);
  const forward = buildForwardGraph(edges);

  const { files: blastRadius, depth } = transitiveDependents(reverse, changedSet, { maxDepth: options.maxDepth });

  const directDependents = new Set();
  for (const file of changedFiles) {
    for (const dependent of reverse.get(file) ?? []) {
      if (!changedSet.has(dependent)) directDependents.add(dependent);
    }
  }

  const affectedFiles = [...new Set([...changedFiles, ...blastRadius])];
  const affectedSet = new Set(affectedFiles);

  const testMapping = intelligence.testMapping ?? [];
  const affectedTests = [];
  for (const entry of testMapping) {
    const sources = new Set([...(entry.importedSources ?? []), ...(entry.likelySources ?? [])].map(normalizePath));
    if ([...sources].some((source) => affectedSet.has(source))) affectedTests.push(entry.test);
  }

  const symbols = intelligence.symbols ?? [];
  const affectedSymbols = [];
  for (const symbol of symbols) {
    const file = normalizePath(symbol.file);
    if (changedSet.has(file)) affectedSymbols.push({ ...symbol, file, relation: 'changed' });
    else if (affectedSet.has(file)) affectedSymbols.push({ ...symbol, file, relation: 'dependent' });
  }

  let maxFanIn = 0;
  for (const file of changedFiles) maxFanIn = Math.max(maxFanIn, (reverse.get(file) ?? new Set()).size);
  const maxDepth = blastRadius.reduce((max, file) => Math.max(max, depth.get(file) ?? 0), 0);

  const risk = scoreRisk({ changedFiles, blastRadius, affectedTests, maxFanIn, maxDepth });

  return {
    changedFiles,
    directDependents: [...directDependents],
    blastRadius,
    affectedFiles,
    affectedTests,
    affectedSymbols,
    depth: Object.fromEntries(depth),
    risk,
    truncated: Boolean(intelligence.truncated),
  };
}

/** Short human-readable one-liner for logs / tool output. */
export function describeImpact(impact) {
  if (!impact) return 'no impact computed';
  const { changedFiles = [], blastRadius = [], affectedTests = [], risk } = impact;
  return `${changedFiles.length} file(s) changed, ${blastRadius.length} dependent(s) in blast radius, ${affectedTests.length} affected test(s), risk ${risk?.level ?? 'low'} (${risk?.score ?? 0}/100)`;
}
