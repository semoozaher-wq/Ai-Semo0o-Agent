#!/usr/bin/env bash
# =============================================================================
# scripts/protect-master-branch.sh
# -----------------------------------------------------------------------------
# Applies (or refreshes) the branch-protection rules for `master` through the
# GitHub REST API, so the CI/Quality gates are actually REQUIRED before a merge.
#
# Branch protection is a repository *setting*, not a file, so it cannot be
# committed — this script is the source of truth for it and is safe to re-run
# (idempotent PUT). See docs/BRANCH_PROTECTION.md for the full rationale and the
# exact list of required status checks.
#
# Requirements:
#   * an authenticated `gh` CLI (`gh auth login`) with admin rights on the repo,
#     OR a token with `repo` scope exported as GH_TOKEN/GITHUB_TOKEN.
#
# Usage:
#   scripts/protect-master-branch.sh [owner/repo] [branch]
#   # defaults: owner/repo inferred from the current git remote, branch=master
# =============================================================================
set -euo pipefail

REPO="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
BRANCH="${2:-master}"

echo "==> Protecting '${BRANCH}' on ${REPO}"

# The required checks mirror the job names produced by .github/workflows:
#   * ci.yml      -> job `validate`, matrix over Node ['22.13.0', '22.23.2']
#                    => "validate (22.13.0)" and "validate (22.23.2)"
#   * quality.yml -> job `verify` => "verify"
# Keep this list in sync with the workflows if a job is renamed.
gh api -X PUT "repos/${REPO}/branches/${BRANCH}/protection" \
  -H "Accept: application/vnd.github+json" \
  --input - <<JSON
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "validate (22.13.0)",
      "validate (22.23.2)",
      "verify"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON

echo "==> Done. Verifying:"
gh api "repos/${REPO}/branches/${BRANCH}/protection" \
  -H "Accept: application/vnd.github+json" \
  -q '{checks: .required_status_checks.contexts, strict: .required_status_checks.strict, pr_reviews: .required_pull_request_reviews.required_approving_review_count, code_owners: .required_pull_request_reviews.require_code_owner_reviews, admins: .enforce_admins.enabled, force_push: .allow_force_pushes.enabled, deletions: .allow_deletions.enabled}'
