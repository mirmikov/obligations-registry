#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_dir"

fail() {
  echo "ОШИБКА: $*" >&2
  exit 1
}

[[ -f .env ]] || fail "нет файла .env; production-секреты нельзя создавать автоматически"
[[ -z "$(git status --porcelain)" ]] || fail "репозиторий содержит локальные изменения. Сначала сохраните production-исправления в отдельной ветке GitHub"
env_mode="$(stat -c '%a' .env 2>/dev/null || true)"
[[ -z "$env_mode" || "$env_mode" == "600" || "$env_mode" == "400" ]] || fail "права .env должны быть 600 или 400"
migration_setting="$(awk -F= '/^RUN_DATABASE_MIGRATIONS=/ {value=tolower($2)} END {gsub(/[[:space:]]/, "", value); print value}' .env)"
[[ "$migration_setting" == "false" || "$migration_setting" == "0" || "$migration_setting" == "no" || "$migration_setting" == "off" ]] || fail "в .env должно быть RUN_DATABASE_MIGRATIONS=false"
unset RUN_DATABASE_MIGRATIONS

# The backend sees only a public status file, never the protected dump directory.
backup_status_dir="$(dirname "$project_dir")/backup-status/obligations-registry"
mkdir -p "$backup_status_dir"
chmod 755 "$backup_status_dir"

db_container_before="$(docker compose ps -q db)"
[[ -n "$db_container_before" ]] || fail "контейнер PostgreSQL не запущен"
docker compose exec -T db pg_isready -U registry -d registry >/dev/null || fail "PostgreSQL не готов"

missing_schema="$(docker compose exec -T db psql -U registry -d registry -At -c "SELECT name FROM unnest(ARRAY['undo_operations','chat_conversations','chat_members','chat_messages']) AS name WHERE to_regclass('public.'||name) IS NULL ORDER BY name")"
[[ -z "$missing_schema" ]] || fail "отсутствуют обязательные таблицы: $missing_schema. После отдельного подтверждения выполните CONFIRM_ADDITIVE_SCHEMA_MIGRATION=YES ./ops/production/migrate-additive-schema.sh"

db_mount_before="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}|{{.Source}}{{end}}{{end}}' "$db_container_before")"
[[ -n "$db_mount_before" ]] || fail "не найден постоянный том PostgreSQL"

echo "Создаю и проверяю резервную копию production-базы..."
backup_path="$(./ops/production/backup.sh)"
echo "Резервная копия: $backup_path"

echo "Собираю новые образы без остановки работающего сервиса..."
docker compose build backend frontend

db_fingerprint_before="$(docker compose exec -T db psql -U registry -d registry -At -F '|' -c "SELECT (SELECT count(*) FROM obligations),(SELECT COALESCE(sum(amount),0) FROM obligations),(SELECT count(*) FROM users),(SELECT count(*) FROM reference_values),(SELECT count(*) FROM chat_messages)")"

echo "Перезапускаю только frontend и backend. PostgreSQL не пересоздаётся..."
docker compose up -d --no-deps backend frontend

app_port="$(awk -F= '/^APP_PORT=[0-9]+$/ {print $2}' .env | tail -1)"
app_port="${app_port:-8088}"
ready=false
for _ in {1..60}; do
  if curl --fail --silent --show-error "http://127.0.0.1:${app_port}/api/health" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || fail "сервис не прошёл health-check; база и резервная копия не удалялись"

db_container_after="$(docker compose ps -q db)"
db_mount_after="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}|{{.Source}}{{end}}{{end}}' "$db_container_after")"
[[ "$db_container_after" == "$db_container_before" ]] || fail "контейнер PostgreSQL неожиданно изменился"
[[ "$db_mount_after" == "$db_mount_before" ]] || fail "том PostgreSQL неожиданно изменился"

db_fingerprint_after="$(docker compose exec -T db psql -U registry -d registry -At -F '|' -c "SELECT (SELECT count(*) FROM obligations),(SELECT COALESCE(sum(amount),0) FROM obligations),(SELECT count(*) FROM users),(SELECT count(*) FROM reference_values),(SELECT count(*) FROM chat_messages)")"
[[ "$db_fingerprint_after" == "$db_fingerprint_before" ]] || fail "контрольные показатели базы изменились во время обновления"

docker compose ps
echo "Готово: платформа обновлена до $(git rev-parse --short HEAD), PostgreSQL и его том не пересоздавались."
