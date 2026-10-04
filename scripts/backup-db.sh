#!/usr/bin/env bash
# Dump the MailForge PostgreSQL database to a compressed, timestamped file.
#
#   scripts/backup-db.sh [output-dir]        (default: ./backups)
#
# Works against the running docker compose stack. Add -f docker-compose.prod.yml via COMPOSE_FILE:
#   COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml scripts/backup-db.sh
#
# NOTE: mailboxes and messages are temporary test data. Back up mainly to keep users, API-key hashes
# and the audit log; do not rely on backups to retain test mail beyond the configured retention.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT_DIR="${1:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${OUT_DIR}/mailforge-${STAMP}.sql.gz"

mkdir -p "${OUT_DIR}"
umask 077

# Credentials come from inside the container (POSTGRES_* env), never from this shell's history.
docker compose exec -T postgres sh -c 'pg_dump --clean --if-exists --no-owner -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  | gzip -9 > "${FILE}"

# Refuse to leave an empty/failed dump behind.
if [ ! -s "${FILE}" ]; then
  rm -f "${FILE}"
  echo "backup failed: empty dump" >&2
  exit 1
fi

echo "wrote ${FILE} ($(du -h "${FILE}" | cut -f1))"

# Prune old dumps so temporary data is not kept indefinitely.
find "${OUT_DIR}" -name 'mailforge-*.sql.gz' -type f -mtime "+${RETENTION_DAYS}" -print -delete
