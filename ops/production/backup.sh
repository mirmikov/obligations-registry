#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_dir"

db_container="$(docker compose ps -q db)"
if [[ -z "$db_container" ]] || ! docker inspect "$db_container" >/dev/null 2>&1; then
  echo "ОШИБКА: контейнер PostgreSQL не запущен." >&2
  exit 1
fi

if ! docker compose exec -T db pg_isready -U registry -d registry >/dev/null; then
  echo "ОШИБКА: PostgreSQL не готов к резервному копированию." >&2
  exit 1
fi

project_parent="$(dirname "$project_dir")"
backup_dir="${REGISTRY_BACKUP_DIR:-$project_parent/backups/obligations-registry}"
timestamp="$(date '+%Y-%m-%d_%H-%M-%S')"
commit="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
backup_path="$backup_dir/registry_${timestamp}_${commit}.dump"

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
docker compose exec -T db pg_dump -U registry -d registry --format=custom --no-owner --no-privileges > "$backup_path"
chmod 600 "$backup_path"

if [[ ! -s "$backup_path" ]]; then
  echo "ОШИБКА: создан пустой файл резервной копии." >&2
  exit 1
fi

if ! docker compose exec -T db pg_restore --list < "$backup_path" >/dev/null; then
  echo "ОШИБКА: резервная копия не прошла проверку." >&2
  exit 1
fi

echo "$backup_path"
