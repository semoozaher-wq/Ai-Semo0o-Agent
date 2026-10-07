/**
 * Delivery stage for the agent lifecycle.
 *
 * The lifecycle is Goal -> Plan -> Execute -> Test -> Repair -> Verify ->
 * **Delivery**. Every planned step has already been verified by the time this
 * runs; Delivery turns the verified work into something a human can pick up:
 *
 *   1. Capture the exact diff of the isolated task workspace.
 *   2. Commit the verified changes to the task branch as a checkpoint
 *      (`git.checkpoint`), which structurally refuses the protected default
 *      branch (main/master) and never stages run evidence.
 *   3. Return a delivery artifact: `{ delivered, branch, revision, message,
 *      changed, diff }`.
 *
 * Delivery is HONEST and fail-closed: when there is no git checkout, the head is
 * detached, the branch is protected, the worktree is already clean, or the
 * commit fails, it returns `delivered: false` with a machine-readable `reason`
 * instead of pretending the work shipped. Opening a pull request is a separate,
 * credential-gated action and is never attempted here.
 */

export const DELIVERY_EVENTS = Object.freeze({
  completed: 'delivery_completed',
  skipped: 'delivery_skipped',
  failed: 'delivery_failed',
});

const DEFAULT_MAX_DIFF_BYTES = 200_000;
const MAX_MESSAGE_LENGTH = 240;
const GOAL_SUMMARY_LENGTH = 160;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Build a bounded, deterministic checkpoint message from the run goal. */
export function deliveryMessage(goal) {
  const text = String(goal ?? '').replace(/\s+/g, ' ').trim();
  const summary = text.length > GOAL_SUMMARY_LENGTH ? `${text.slice(0, GOAL_SUMMARY_LENGTH - 3)}...` : text;
  return `semo0o: deliver ${summary || 'agent run'}`.slice(0, MAX_MESSAGE_LENGTH);
}

function boundedDiff(diff, maxBytes) {
  const stdout = String(diff?.stdout ?? '');
  return {
    available: diff?.ok === true,
    stdout: stdout.length > maxBytes ? `${stdout.slice(0, maxBytes)}\n...[truncated]` : stdout,
    stderr: String(diff?.stderr ?? '').slice(0, 4_000),
    exitCode: diff?.exitCode ?? null,
  };
}

/**
 * Deliver the verified work from a resolved task-workspace engine.
 *
 * @param {object} opts
 * @param {object} opts.engine  The AgentExecutionEngine for the task workspace.
 * @param {string} [opts.goal]  The run goal (used for the checkpoint message).
 * @param {number} [opts.maxDiffBytes] Cap on the captured diff size.
 * @returns {Promise<object>} A delivery artifact (never throws for expected
 *   states; only truly unexpected errors are reported as `delivery_error`).
 */
export async function deliverRun({ engine, goal, maxDiffBytes = DEFAULT_MAX_DIFF_BYTES } = {}) {
  const git = engine?.git;
  if (!git || typeof git.checkpoint !== 'function' || typeof git.branch !== 'function') {
    return { delivered: false, reason: 'no_git' };
  }

  let branch;
  try {
    branch = (await git.branch()).branch;
  } catch (error) {
    return { delivered: false, reason: 'branch_unavailable', error: errorMessage(error) };
  }
  if (!branch) return { delivered: false, reason: 'detached_head' };
  if (typeof git.isDefaultBranch === 'function' && git.isDefaultBranch(branch)) {
    return { delivered: false, reason: 'protected_branch', branch };
  }

  let changed = [];
  try {
    if (typeof git.changedEntries === 'function') {
      changed = (await git.changedEntries()).entries;
    } else {
      const status = await git.status();
      changed = (status?.entries ?? []).filter((entry) => !String(entry).startsWith('##'));
    }
  } catch {
    changed = [];
  }

  let diff = { available: false };
  try {
    diff = boundedDiff(await git.diff(), maxDiffBytes);
  } catch (error) {
    diff = { available: false, reason: errorMessage(error) };
  }

  if (changed.length === 0) {
    return { delivered: false, reason: 'nothing_to_deliver', branch, changed: [], diff };
  }

  const message = deliveryMessage(goal);
  let checkpoint;
  try {
    checkpoint = await git.checkpoint(message);
  } catch (error) {
    return { delivered: false, reason: 'checkpoint_failed', branch, changed, diff, error: errorMessage(error) };
  }
  if (!checkpoint?.created) {
    return { delivered: false, reason: checkpoint?.reason || 'nothing_to_deliver', branch, changed, diff };
  }

  return {
    delivered: true,
    branch,
    revision: checkpoint.revision ?? null,
    message,
    changed,
    diff,
  };
}
