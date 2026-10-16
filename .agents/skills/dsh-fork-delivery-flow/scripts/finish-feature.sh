#!/usr/bin/env bash
#
# Wrap up a landed feature: delete its branch on cnb and on github, delete it
# locally, then close the issue that asked for it.
#
# Usage: finish-feature.sh <issue> <branch> [--dry-run]
#
#   --dry-run  print the command sequence without running it
#
# A branch whose content is not on cnb/main is never deleted, so a feature
# cannot be discarded before its merge request lands.
#
set -euo pipefail

integration_remote=cnb
integration_branch=main
mirror_remote=github

usage='usage: finish-feature.sh <issue> <branch> [--dry-run]'

dry_run=0
positional=()

for argument in "$@"; do
  case "$argument" in
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    --dry-run) dry_run=1 ;;
    -*) printf 'unknown argument: %s\n' "$argument" >&2; printf '%s\n' "$usage" >&2; exit 2 ;;
    *) positional+=("$argument") ;;
  esac
done

if [ "${#positional[@]}" -ne 2 ]; then
  printf '%s\n' "$usage" >&2
  exit 2
fi

issue="${positional[0]}"
branch="${positional[1]}"

# Print a command as `+ <command>`; only a non-dry run executes it.
run() {
  printf '+ %s\n' "$*"
  if [ "$dry_run" -eq 0 ]; then
    "$@"
  fi
}

run git fetch "$integration_remote" --prune
cnb_sha="$(git rev-parse "refs/remotes/$integration_remote/$integration_branch")"

if ! git rev-parse --verify --quiet "refs/remotes/$integration_remote/$branch" >/dev/null; then
  printf '%s is already absent from %s; nothing to delete\n' \
    "$branch" "$integration_remote" >&2
  exit 1
fi

branch_sha="$(git rev-parse "refs/remotes/$integration_remote/$branch")"

# Landed means the branch is an ancestor of cnb/main, or every path it changed
# against the merge base is byte-identical on cnb/main (the squash case). Each
# path is compared in its own git call, so a branch touching hundreds of files
# cannot overflow the Windows command line.
landed=0
if git merge-base --is-ancestor "$branch_sha" "$cnb_sha" 2>/dev/null; then
  landed=1
else
  merge_base="$(git merge-base "$branch_sha" "$cnb_sha")"
  landed=1
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    if ! git diff --quiet "$cnb_sha" "$branch_sha" -- "$path"; then
      landed=0
      break
    fi
  done < <(git diff --name-only "$merge_base" "$branch_sha")
fi

if [ "$landed" -eq 0 ]; then
  printf '%s is not on %s/%s; land the merge request first\n' \
    "$branch" "$integration_remote" "$integration_branch" >&2
  exit 1
fi

on_mirror=0
if git ls-remote --exit-code --heads "$mirror_remote" "$branch" >/dev/null 2>&1; then
  on_mirror=1
fi

if [ "$(git branch --show-current)" = "$branch" ]; then
  run git switch "$integration_branch"
fi

run git push "$integration_remote" --delete "$branch"

if [ "$on_mirror" -eq 1 ]; then
  run git push "$mirror_remote" --delete "$branch"
fi

if git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
  run git branch -D "$branch"
fi

# Build the owner/repo and the issue URL from the cnb remote: normalize the
# scp form, drop the scheme and host, then keep the last two path segments.
remote_url="$(git remote get-url "$integration_remote")"
owner_repo="${remote_url#*:*:}"
owner_repo="${owner_repo#*://}"
owner_repo="${owner_repo#*@}"
owner_repo="${owner_repo%:}"
owner_repo="${owner_repo%.git}"
owner_repo="$(printf '%s' "$owner_repo" | tr ':' '/')"
if [ "$(printf '%s' "$owner_repo" | awk -F/ '{print NF}')" -ge 3 ]; then
  owner_repo="$(printf '%s' "$owner_repo" | awk -F/ '{print $(NF-1)"/"$NF}')"
fi
issue_url="https://cnb.cool/$owner_repo/-/issues/$issue"

# The CLI resolves its own credential, so try the close and keep the URL for
# whoever runs the wrap-up when the CLI is missing or refuses the call.
if ! run cnb issues close --repo "$owner_repo" --number "$issue"; then
  printf 'close issue #%s at %s\n' "$issue" "$issue_url"
fi

printf '%s  %s\n' "$integration_branch" "$(git rev-parse --short "$cnb_sha")"
