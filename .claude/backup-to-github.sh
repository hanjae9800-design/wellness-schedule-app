#!/usr/bin/env bash
# wellness-schedule-app -> claude-session-backup(private repo) 자동 백업
set -uo pipefail

PROJECT_DIR="/c/Users/hanja/dev/wellness-schedule-app"
BACKUP_REPO="$HOME/.claude/backups/claude-session-backup"
BACKUP_DEST="$BACKUP_REPO/wellness-schedule-app"
REASON="${1:-update}"

mkdir -p "$BACKUP_DEST"

# 프로젝트 내 md 파일들을 백업 저장소로 동기화 (node_modules/.git/.wrangler 제외)
find "$PROJECT_DIR" -maxdepth 4 -iname "*.md" \
  -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.wrangler/*" \
  2>/dev/null | while IFS= read -r f; do
    rel="${f#$PROJECT_DIR/}"
    mkdir -p "$BACKUP_DEST/$(dirname "$rel")"
    cp "$f" "$BACKUP_DEST/$rel"
done

# 최근 커밋 로그도 함께 기록 (배포/커밋 트리거일 때 참고용)
{
  echo "## $(date '+%Y-%m-%d %H:%M:%S') - $REASON"
  git -C "$PROJECT_DIR" log -3 --oneline 2>/dev/null
  echo
} >> "$BACKUP_DEST/activity-log.md"

cd "$BACKUP_REPO" || exit 0
git add -A
if ! git diff --cached --quiet; then
  git commit -q -m "wellness-schedule-app 자동 백업 ($REASON)"
  git push -q origin main
fi
