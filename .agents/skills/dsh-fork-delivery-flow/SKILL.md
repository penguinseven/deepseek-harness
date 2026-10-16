---
name: dsh-fork-delivery-flow
description: Use when planning, branching, delegating, reviewing, or releasing a feature in the penguinseven fork of deepseek-harness, where origin is the upstream mirror, cnb hosts issues and integration, and github hosts releases. Defines branch roles, the mirrored-master sync script, the issue-based plan, the @CodeBuddy delegation contract, and the release gate.
---

# Fork delivery flow

This checkout is the `penguinseven` fork of upstream `deepseek-harness`. Upstream [does not accept external pull requests](../../../CONTRIBUTING.md), so fork features are delivered and released from this fork, and the upstream tree stays a read-only mirror.

The rule that keeps the topology consistent: **`master` names upstream code on every remote; every fork change lives on `main`.**

This skill is stored on `main`, so every feature branch cut from `main` carries it. It is the only path in the repository that bypasses the fork's merge-request rule: the commit that creates `main` also creates this rule, so no earlier integration line exists to open a merge request against. Every later change to this skill follows the normal flow.

## Branch roles

| Ref | Remote | Role | Writes |
|---|---|---|---|
| `origin/master` | `deepseek-ai/deepseek-harness` | Upstream source of truth | Read-only |
| `cnb/master` | `cnb` | Mirror of upstream | Manual sync only |
| `github/master` | `github` | Mirror of upstream | Manual sync only |
| `cnb/main` | `cnb` | Fork integration and release line | Merge requests only |
| `github/main` | `github` | Published fork line | Fast-forward from `cnb/main`, plus release tags |
| `codex/<issue>-<slug>` | `cnb` | One feature | Its author; deleted after landing |

## Invariants

1. `cnb/master` and `github/master` equal `origin/master` outside a manual sync window and never carry a fork commit.
2. Feature branches are cut from `cnb/main` and merge into `cnb/main`.
3. `cnb/main` merges `cnb/master`; nothing merges back into a `master`.
4. `cnb/main` is never rewritten after it reaches `github`; only fast-forward or merge commits.
5. CodeBuddy writes only the feature branch it was given.
6. A release starts from a tag, never from a push to a branch.

## Per-feature sequence

### 1. Sync upstream (manual, before starting)

```sh
.agents/skills/dsh-fork-delivery-flow/scripts/sync-mirrors.sh
```

The script fetches upstream, fast-forwards `master`, pushes both mirrors, merges `master` into `main`, and pushes `main`. It refuses to start on a dirty tracked tree or when `main` is missing. `--dry-run` prints the command sequence; `--force-mirrors` adds `--force-with-lease` to the mirror pushes for the case where upstream rewrote history, and never applies to `main`. Record `git rev-parse cnb/master` as the feature baseline when the script finishes.

### 2. Open the CNB issue

One feature owns one issue. Start from [the issue template](references/cnb-issue-template.md), which carries the baseline SHA, scope, acceptance criteria, required checks, rollback, and prohibitions. Keep later plan changes in issue comments so the issue stays the single plan of record.

### 3. Cut the branch

```sh
git fetch cnb --prune
git switch -c codex/<issue>-<slug> cnb/main
```

Cut from `cnb/main`, not `cnb/master`: the branch then carries the fork's landed features and this skill, and its checks run against the tree that will be released.

### 4. Delegate to CodeBuddy

Post `@CodeBuddy` on the issue with the [delegation contract](#codebuddy-delegation-contract), and link this file so the agent reads the branch roles before it starts.

### 5. Review

Review the diff, the check output, and every acceptance item in the issue. A CodeBuddy summary is not evidence. Route the change through CI: when CNB cannot run the repository's checks for the affected surface, push the branch to `github` and let GitHub CI run before landing.

### 6. Land on `cnb/main`

Open the merge request against `cnb/main`. Squash, so one issue produces one commit on `main` citing the issue; use a merge commit only when the multi-commit history is itself the deliverable. Delete the feature branch and close the issue after the merge.

### 7. Maintain `cnb/main`

Step 1 merges `cnb/master` into `cnb/main` at each sync point, so the fork keeps carrying upstream.

### 8. Release

1. Sync upstream, then confirm `cnb/main` contains it and its checks pass.
2. Freeze the release commit on `cnb/main`.
3. Tag that commit for the sequence being released (`dsh-vX.Y.Z` for the package sequence), matching the version the release scripts read.
4. Push `cnb/main` to `github/main`, then push the tag.
5. Run the publication workflow from the tag and verify the published artifacts.

The release workflows select a tag and, for desktop packaging, require `master`; the fork must retarget them to `main` before this step works. `git push github main` alone publishes no artifact.

## CodeBuddy delegation contract

```
@CodeBuddy

Complete this issue on a new branch.

1. Branch from cnb/main; baseline SHA <sha>.
2. Change only the scope listed in this issue.
3. Never push to cnb/master, cnb/main, or github/*.
4. Open a merge request against cnb/main when the work is done.
5. Run the checks listed in this issue and paste their output in the merge request.
6. Do not edit release workflows, signing material, credentials, or branch protection.
7. If the change turns out to need a wider scope, stop and say so in this issue.
```

## Why this is not in `AGENTS.md`

`AGENTS.md` and its `CLAUDE.md` symlink are upstream-owned and edited regularly upstream, so changing them turns every upstream sync into a conflict. This skill is a new path upstream never touches, so it merges cleanly for the life of the fork. Machine-specific notes belong in `CLAUDE.local.md`, which `.gitignore` already covers, not in `AGENTS.local.md`, which is untracked but not ignored.
