#!/usr/bin/env bash
set -Eeuo pipefail

export TZ="Europe/Moscow"
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
project_parent="$(dirname "$project_dir")"
status_dir="${REGISTRY_BACKUP_STATUS_DIR:-$project_parent/backup-status/obligations-registry}"
status_file="$status_dir/latest-backup-status.json"
mkdir -p "$status_dir"
chmod 755 "$status_dir"
cd "$project_dir"

write_status() {
  local success="$1" completed_at="$2" backup_name="$3" version="$4" database_version="$5" size_bytes="$6" valid="$7" error_message="$8"
  local temporary_file="$status_file.tmp.$$"
  python3 - "$temporary_file" "$success" "$completed_at" "$backup_name" "$version" "$database_version" "$size_bytes" "$valid" "$error_message" <<'PY'
import json
import sys

path, success, completed_at, backup_name, version, database_version, size_bytes, valid, error_message = sys.argv[1:]
payload = {
    "success": success == "true",
    "completed_at": completed_at,
    "backup_name": backup_name,
    "version": version,
    "database_version": database_version,
    "size_bytes": int(size_bytes),
    "valid": valid == "true",
}
if error_message:
    payload["error"] = error_message[-2000:]
with open(path, "w", encoding="utf-8") as stream:
    json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
    stream.write("\n")
PY
  chmod 644 "$temporary_file"
  mv -f "$temporary_file" "$status_file"
}

completed_at="$(date --iso-8601=seconds)"
version="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
database_version="$(docker compose exec -T db psql -U registry -d registry -At -c 'SHOW server_version' 2>/dev/null || true)"

set +e
backup_output="$(./ops/production/backup.sh 2>&1)"
backup_code=$?
set -e

if (( backup_code != 0 )); then
  write_status false "$completed_at" "" "$version" "$database_version" 0 false "$backup_output"
  printf '%s\n' "$backup_output" >&2
  exit "$backup_code"
fi

backup_path="$(printf '%s\n' "$backup_output" | tail -n 1)"
if [[ ! -f "$backup_path" ]]; then
  message="backup script returned a missing file"
  write_status false "$completed_at" "" "$version" "$database_version" 0 false "$message"
  echo "ОШИБКА: $message" >&2
  exit 1
fi

backup_name="$(basename "$backup_path")"
size_bytes="$(stat -c '%s' "$backup_path")"
write_status true "$(date --iso-8601=seconds)" "$backup_name" "$version" "$database_version" "$size_bytes" true ""
echo "$backup_path"
