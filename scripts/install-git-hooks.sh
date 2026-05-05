#!/usr/bin/env bash
# Install repo-local git hooks. Run once after clone.
#
# WHY a script (not a dep like husky/lefthook): one team member, one repo,
# zero need for cross-platform hook orchestration. A short bash installer
# is simpler and adds zero npm dependencies.
#
# Idempotent — safe to re-run.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

HOOK="$(git rev-parse --git-dir)/hooks/pre-push"

cat > "$HOOK" <<'HOOK_EOF'
#!/usr/bin/env bash
# pre-push hook — block accidentally-tracked secrets / planning docs.
#
# WHY this exists: styrby-app is a PUBLIC repo. The CLAUDE.md "Public Repo
# Safety Rules" already forbid committing planning docs, .env files, security
# reports, etc. — but rules without enforcement get bypassed under deadline
# pressure. This hook is the enforcement: if any forbidden pattern is in the
# commits about to be pushed, abort with a clear message.
#
# To bypass once (operator-confirmed safe): git push --no-verify
# To uninstall: rm .git/hooks/pre-push
#
# Maintained by /scripts/install-git-hooks.sh

set -euo pipefail

# Patterns to block. Anchored to file path start or '/' to avoid false
# positives on test files that happen to contain a substring (the lesson
# from 2026-05-04 when "smoketest" matched legitimate agentSmokeTests.test.ts).
FORBIDDEN_PATTERNS=(
  '(^|/)\.env($|\.[^.]+$)'
  '(^|/)styrby-backlog\.md$'
  '(^|/)styrby-task-tracker\.md$'
  '(^|/)docs/'
  '(^|/)\.security-(audit|reports?)/'
  '(^|/)\.mdmp/'
  '\.security-audit\.json$'
  '(^|/)credentials\.json$'
  '(^|/)\.gh-ship-history\.json$'
)

violations=()
while read local_ref local_sha remote_ref remote_sha; do
  if [ "$local_sha" = "0000000000000000000000000000000000000000" ]; then
    continue
  fi
  if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
    range=$(git rev-list "$local_sha" --not --remotes)
  else
    range=$(git rev-list "$remote_sha..$local_sha")
  fi
  if [ -z "$range" ]; then continue; fi

  for sha in $range; do
    files=$(git show --pretty="" --name-only "$sha")
    for file in $files; do
      [ -z "$file" ] && continue
      for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
        if echo "$file" | grep -qE "$pattern"; then
          violations+=("$sha:$file (matched: $pattern)")
        fi
      done
    done
  done
done

if [ ${#violations[@]} -gt 0 ]; then
  echo "" >&2
  echo "🚨 PRE-PUSH BLOCKED — forbidden file paths in commit set:" >&2
  echo "" >&2
  for v in "${violations[@]}"; do
    echo "  $v" >&2
  done
  echo "" >&2
  echo "These paths are forbidden by CLAUDE.md 'Public Repo Safety Rules'." >&2
  echo "" >&2
  echo "Resolve by:" >&2
  echo "  1. Confirm the file is intentionally local-only" >&2
  echo "  2. Remove from the commit:  git rm --cached <path>  +  git commit --amend" >&2
  echo "  3. Re-push" >&2
  echo "" >&2
  echo "If this IS legitimate (rare), bypass once:  git push --no-verify" >&2
  echo "" >&2
  exit 1
fi

exit 0
HOOK_EOF

chmod +x "$HOOK"
echo "✅ pre-push hook installed at $HOOK"
echo "   To uninstall: rm $HOOK"
