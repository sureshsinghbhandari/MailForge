#!/usr/bin/env bash
# Restore a dump created by scripts/backup-db.sh into the running docker compose PostgreSQL.
#
#   scripts/restore-db.sh backups/mailforge-20260101T000000Z.sql.gz
#
# DESTRUCTIVE: the dump contains DROP statements; existing tables are replaced. You will be asked to
# confirm unless FORCE=1 is set. Stop the backend first for a consistent restore:
#   docker compose stop backend && scripts/restore-db.sh <file> && docker compose start backend
set -euo pipefail

cd "$(dirname "$0")/.."

if [ $# -ne 1 ] || [ ! -f "$1" ]; then
  echo "usage: $0 <dump.sql.gz>" >&2
  exit 2
fi
FILE="$1"

if [ "${FORCE:-0}" != "1" ]; then
  printf 'This will REPLACE the current database contents with %s. Type "restore" to continue: ' "${FILE}"
  read -r answer
  [ "${answer}" = "restore" ] || { echo "aborted"; exit 1; }
fi

gunzip -c "${FILE}" | docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$POSTGRES_DB"'
echo "restore complete"
