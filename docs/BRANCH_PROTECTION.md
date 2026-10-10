# Branch protection for `master`

`master` is the single protected branch that ships to production. Every change
reaches it through a pull request that must pass the CI/Quality gates **and** be
reviewed by a code owner. Branch protection is a repository *setting* (not a
committed file), so this document plus `scripts/protect-master-branch.sh` are the
source of truth for it.

## Required status checks

These are the exact check names GitHub reports for the workflows in
`.github/workflows/`. They must be green before a merge is allowed:

| Check | Workflow | What it proves |
| --- | --- | --- |
| `validate (22.5)` | `ci.yml` | The whole suite passes on the declared Node floor (`>=22.5.0`, first release with `node:sqlite`). |
| `validate (22.11.0)` | `ci.yml` | The whole suite passes on the exact deployed runtime (`render.yaml` / `backend/Dockerfile`). |
| `verify` | `quality.yml` | Secret/SAST scan, dependency-audit gate, backend import resolution, typecheck, lint, full test suite, Expo doctor, web export, browser smoke, browser E2E, agent E2E benchmark, backend boot smoke, and the self-improvement production trial. |

Both workflows also run on every `push` to `master`, so a direct push (which the
rules below forbid) would still be validated.

## Required settings

| Setting | Value | Why |
| --- | --- | --- |
| Require a pull request before merging | on | No direct pushes to `master`. |
| Required approvals | 1 | At least one human review. |
| Dismiss stale approvals | on | A new commit invalidates prior approvals. |
| Require review from Code Owners | on | `.github/CODEOWNERS` gates security-sensitive paths. |
| Require status checks to pass | on | The three checks above. |
| Require branches to be up to date | on (`strict`) | Green checks must be against the merge target. |
| Require conversation resolution | on | No merging with unresolved review threads. |
| Require linear history | on | Keeps `master` bisectable. |
| Allow force pushes | off | History is append-only. |
| Allow deletions | off | `master` can never be deleted. |
| Include administrators | on (`enforce_admins`) | The rules apply to everyone. |

## Applying the rules

With an authenticated `gh` CLI that has admin rights on the repository:

```bash
# owner/repo and branch are inferred from the git remote; both are optional args.
scripts/protect-master-branch.sh
```

The script issues an idempotent `PUT /repos/{owner}/{repo}/branches/master/protection`
and then prints the resulting configuration so you can confirm it took effect.
It can be re-run at any time to re-assert the settings.

To apply the same rules by hand, open **Settings → Branches → Add branch
protection rule**, target `master`, and mirror the table above.

## Keeping this in sync

If a job in `ci.yml` or `quality.yml` is renamed, update the `contexts` array in
`scripts/protect-master-branch.sh` **and** the table above in the same pull
request — otherwise the required check would silently stop being enforced.
