#!/usr/bin/env bash
# wrangler pages deploy는 .gitignore를 무시하고 폴더 전체를 올리기 때문에,
# plan.md와 .claude/ 는 배포 순간에만 폴더 밖으로 뺐다가 끝나면 되돌린다.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

STAGE_DIR="$(mktemp -d)"
cleanup() {
  [ -f "$STAGE_DIR/plan.md" ] && mv "$STAGE_DIR/plan.md" "$PROJECT_DIR/plan.md"
  [ -d "$STAGE_DIR/.claude" ] && mv "$STAGE_DIR/.claude" "$PROJECT_DIR/.claude"
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

[ -f plan.md ] && mv plan.md "$STAGE_DIR/"
[ -d .claude ] && mv .claude "$STAGE_DIR/"

npx wrangler pages deploy . --commit-dirty=true
