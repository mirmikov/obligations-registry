#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_dir"

fail() {
  echo "ОШИБКА: $*" >&2
  exit 1
}

[[ "${CONFIRM_ADDITIVE_SCHEMA_MIGRATION:-}" == "YES" ]] || fail "для запуска требуется явное подтверждение CONFIRM_ADDITIVE_SCHEMA_MIGRATION=YES"
[[ -f .env ]] || fail "нет файла .env; production-секреты нельзя создавать автоматически"
[[ -z "$(git status --porcelain)" ]] || fail "репозиторий содержит локальные изменения"

env_mode="$(stat -c '%a' .env 2>/dev/null || true)"
[[ -z "$env_mode" || "$env_mode" == "600" || "$env_mode" == "400" ]] || fail "права .env должны быть 600 или 400"
migration_setting="$(awk -F= '/^RUN_DATABASE_MIGRATIONS=/ {value=tolower($2)} END {gsub(/[[:space:]]/, "", value); print value}' .env)"
[[ "$migration_setting" == "false" || "$migration_setting" == "0" || "$migration_setting" == "no" || "$migration_setting" == "off" ]] || fail "в .env должно быть RUN_DATABASE_MIGRATIONS=false"
unset RUN_DATABASE_MIGRATIONS

db_container_before="$(docker compose ps -q db)"
[[ -n "$db_container_before" ]] || fail "контейнер PostgreSQL не запущен"
docker compose exec -T db pg_isready -U registry -d registry >/dev/null || fail "PostgreSQL не готов"

db_mount_before="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}|{{.Source}}{{end}}{{end}}' "$db_container_before")"
[[ -n "$db_mount_before" ]] || fail "не найден постоянный том PostgreSQL"

core_fingerprint_before="$(docker compose exec -T db psql -U registry -d registry -At -F '|' -c "SELECT (SELECT count(*) FROM obligations),(SELECT COALESCE(sum(amount),0) FROM obligations),(SELECT count(*) FROM users),(SELECT count(*) FROM reference_values)")"

relation_count() {
  local relation="$1"
  case "$relation" in
    undo_operations|chat_conversations|chat_members|chat_messages) ;;
    *) fail "неожиданное имя таблицы: $relation" ;;
  esac
  if [[ "$(docker compose exec -T db psql -U registry -d registry -At -c "SELECT to_regclass('public.$relation') IS NOT NULL")" == "t" ]]; then
    docker compose exec -T db psql -U registry -d registry -At -c "SELECT count(*) FROM $relation"
  else
    echo missing
  fi
}

declare -A relation_counts_before
for relation in undo_operations chat_conversations chat_members chat_messages; do
  relation_counts_before["$relation"]="$(relation_count "$relation")"
done

echo "Создаю и проверяю резервную копию перед schema-only миграцией..."
backup_path="$(./ops/production/backup.sh)"
echo "Резервная копия: $backup_path"

echo "Создаю только отсутствующие таблицы чата, истории отмены и индексы..."
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U registry -d registry < ./ops/production/additive-schema.sql

missing_relations="$(docker compose exec -T db psql -U registry -d registry -At -c "SELECT name FROM unnest(ARRAY['undo_operations','chat_conversations','chat_members','chat_messages','undo_operations_user_idx','chat_members_user_idx','chat_messages_conversation_idx']) AS name WHERE to_regclass('public.'||name) IS NULL ORDER BY name")"
[[ -z "$missing_relations" ]] || fail "после миграции отсутствуют объекты: $missing_relations"

missing_columns="$(docker compose exec -T db psql -U registry -d registry -At -c "WITH expected(table_name,column_name) AS (VALUES ('undo_operations','id'),('undo_operations','user_id'),('undo_operations','action'),('undo_operations','description'),('undo_operations','payload'),('undo_operations','created_at'),('undo_operations','undone_at'),('chat_conversations','id'),('chat_conversations','kind'),('chat_conversations','name'),('chat_conversations','direct_key'),('chat_conversations','created_by'),('chat_conversations','created_at'),('chat_conversations','updated_at'),('chat_members','conversation_id'),('chat_members','user_id'),('chat_members','joined_at'),('chat_members','last_read_at'),('chat_messages','id'),('chat_messages','conversation_id'),('chat_messages','sender_id'),('chat_messages','body'),('chat_messages','created_at')) SELECT expected.table_name||'.'||expected.column_name FROM expected LEFT JOIN information_schema.columns actual USING(table_name,column_name) WHERE actual.column_name IS NULL ORDER BY 1")"
[[ -z "$missing_columns" ]] || fail "после миграции отсутствуют колонки: $missing_columns"

for relation in undo_operations chat_conversations chat_members chat_messages; do
  count_after="$(relation_count "$relation")"
  count_before="${relation_counts_before[$relation]}"
  if [[ "$count_before" == "missing" ]]; then
    [[ "$count_after" == "0" ]] || fail "новая таблица $relation должна быть пустой, найдено строк: $count_after"
  else
    [[ "$count_after" == "$count_before" ]] || fail "число строк в существующей таблице $relation изменилось"
  fi
done

core_fingerprint_after="$(docker compose exec -T db psql -U registry -d registry -At -F '|' -c "SELECT (SELECT count(*) FROM obligations),(SELECT COALESCE(sum(amount),0) FROM obligations),(SELECT count(*) FROM users),(SELECT count(*) FROM reference_values)")"
[[ "$core_fingerprint_after" == "$core_fingerprint_before" ]] || fail "данные обязательств, пользователей или справочников изменились"

db_container_after="$(docker compose ps -q db)"
db_mount_after="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}|{{.Source}}{{end}}{{end}}' "$db_container_after")"
[[ "$db_container_after" == "$db_container_before" ]] || fail "контейнер PostgreSQL неожиданно изменился"
[[ "$db_mount_after" == "$db_mount_before" ]] || fail "том PostgreSQL неожиданно изменился"

echo "Schema-only миграция завершена. Существующие данные не изменились."
echo "Контрольные показатели: $core_fingerprint_after"
echo "Проверенный backup: $backup_path"
