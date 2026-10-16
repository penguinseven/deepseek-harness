# CNB feature issue template

Copy this into a new CNB issue and fill every field. Edit the body or add comments as the plan changes; the issue is the plan of record for the branch, the merge request, and the release.

## Goal

What the fork gains, and for whom.

## Non-goals

What this change deliberately leaves alone.

## Baseline

- `cnb/master`: `<sha from git rev-parse cnb/master>`
- `cnb/main`: `<sha from git rev-parse cnb/main>`

## Target

- Branch: `codex/<issue>-<slug>`
- Merge request target: `cnb/main`

## Scope

The files, packages, or surfaces this change may touch.

## Out of scope

Paths and packages the branch must not modify.

## Acceptance criteria

One checkable item per line: a command and its expected result, or an observable behavior.

## Required checks

The exact commands to run, in order.

## Rollback

How to undo the change if the release is bad.

## Prohibited

- Direct pushes to `cnb/master`, `cnb/main`, or `github/*`.
- Edits to release workflows, signing material, credentials, or branch protection.
- Changes outside the scope section above.

Then delegate with the contract in [the delivery flow skill](../SKILL.md#codebuddy-delegation-contract).
