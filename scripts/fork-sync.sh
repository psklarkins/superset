#!/usr/bin/env bash
set -euo pipefail

BASE_BRANCH="main"
WITH_CURRENT=0
NO_PUSH=0

usage() {
	echo "Usage: scripts/fork-sync.sh [--base <branch>] [--with-current] [--no-push]"
	echo ""
	echo "  --base <branch>   Base branch to sync from upstream (default: main)"
	echo "  --with-current    Rebase current branch on refreshed base branch"
	echo "  --no-push         Do not push any branches to origin"
}

while [ $# -gt 0 ]; do
	case "$1" in
		--base)
			BASE_BRANCH="${2:-}"
			if [ -z "$BASE_BRANCH" ]; then
				echo "Error: --base requires a branch name" >&2
				exit 1
			fi
			shift 2
			;;
		--with-current)
			WITH_CURRENT=1
			shift
			;;
		--no-push)
			NO_PUSH=1
			shift
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			echo "Unknown argument: $1" >&2
			usage >&2
			exit 1
			;;
	esac
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	echo "Error: run this script inside a git repository" >&2
	exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
	echo "Error: remote 'origin' is not configured" >&2
	exit 1
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
	echo "Error: remote 'upstream' is not configured" >&2
	exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

echo "Fetching origin + upstream..."
git fetch origin --prune --no-tags
git fetch upstream --prune --no-tags

if ! git show-ref --verify --quiet "refs/remotes/upstream/$BASE_BRANCH"; then
	echo "Error: upstream/$BASE_BRANCH does not exist" >&2
	exit 1
fi

echo "Syncing $BASE_BRANCH with upstream/$BASE_BRANCH..."
git switch "$BASE_BRANCH"
git rebase "upstream/$BASE_BRANCH"

if [ "$NO_PUSH" -eq 0 ]; then
	git push origin "$BASE_BRANCH"
fi

if [ "$WITH_CURRENT" -eq 1 ] && [ "$CURRENT_BRANCH" != "$BASE_BRANCH" ]; then
	echo "Rebasing $CURRENT_BRANCH onto $BASE_BRANCH..."
	git switch "$CURRENT_BRANCH"
	git rebase "$BASE_BRANCH"
	if [ "$NO_PUSH" -eq 0 ]; then
		git push -u origin "$CURRENT_BRANCH"
	fi
fi

echo "Done."
echo -n "$BASE_BRANCH...upstream/$BASE_BRANCH: "
git rev-list --left-right --count "$BASE_BRANCH...upstream/$BASE_BRANCH"
echo -n "$BASE_BRANCH...origin/$BASE_BRANCH: "
git rev-list --left-right --count "$BASE_BRANCH...origin/$BASE_BRANCH"
