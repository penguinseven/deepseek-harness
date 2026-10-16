#!/usr/bin/env bash
#
# Sync the fork mirrors to upstream and carry upstream into the integration line:
#
#   master -> exact copy of origin/master on cnb and github
#   main   -> merged with master, then pushed to cnb
#
# Usage: sync-mirrors.sh [--dry-run] [--force-mirrors]
#
#   --dry-run        print the command sequence without running it
#   --force-mirrors  push the mirrors with --force-with-lease, only for the case
#                    where upstream rewrote history; main is never force-pushed
#
set -euo pipefail

upstream=origin
mirrors=(cnb github)
mirror_branch=master
integration_branch=main
integration_remote=cnb

dry_run=0
force_mirrors=0

for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run=1 ;;
    --force-mirrors) force_mirrors=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$argument" >&2; exit 2 ;;
  esac
done

run() {
  printf '+ %s\n' "$*"
  if [ "$dry_run" -eq 0 ]; then
    "$@"
  fi
}

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  printf 'tracked files are modified; commit or stash before syncing\n' >&2
  exit 1
fi

if ! git show-ref --verify --quiet "refs/heads/$integration_branch"; then
  printf 'no local %s branch; create it from %s before syncing\n' "$integration_branch" "$mirror_branch" >&2
  exit 1
fi

start_branch="$(git branch --show-current)"

run git fetch "$upstream" --prune

run git switch "$mirror_branch"
run git merge --ff-only "$upstream/$mirror_branch"

for mirror in "${mirrors[@]}"; do
  if [ "$force_mirrors" -eq 1 ]; then
    run git push --force-with-lease "$mirror" "$mirror_branch"
  else
    run git push "$mirror" "$mirror_branch"
  fi
done

run git switch "$integration_branch"
run git merge "$mirror_branch"
run git push "$integration_remote" "$integration_branch"

if [ -n "$start_branch" ]; then
  run git switch "$start_branch"
fi

printf '\n%s  %s\n%s  %s\n' \
  "$mirror_branch" "$(git rev-parse --short "$mirror_branch")" \
  "$integration_branch" "$(git rev-parse --short "$integration_branch")"
