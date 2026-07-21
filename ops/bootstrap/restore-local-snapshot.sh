#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_dir"

snapshot_path="$project_dir/ops/bootstrap/registry-state-2026-07-22.tar.gz.enc"
expected_sha256="96f1b8fe785bc551604783e0dfe0e2e196bf8aab84ef6d7a2fa2fd9a93928dc8"
expected_fingerprint="1753|536297957.52|6|261|28"

fail() {
  echo "ОШИБКА: $*" >&2
  exit 1
}

[[ "${CONFIRM_REPLACE_DATABASE:-}" == "YES" ]] || fail "для полной замены базы задайте CONFIRM_REPLACE_DATABASE=YES"
[[ -f .env ]] || fail "нет файла .env; скопируйте .env.example в .env и задайте собственные секреты"
[[ -f "$snapshot_path" ]] || fail "не найден зашифрованный снимок $snapshot_path"
command -v openssl >/dev/null 2>&1 || fail "не найден openssl"
command -v docker >/dev/null 2>&1 || fail "не найден docker"

migration_setting="$(awk -F= '/^RUN_DATABASE_MIGRATIONS=/ {value=tolower($2)} END {gsub(/[[:space:]]/, "", value); print value}' .env)"
[[ "$migration_setting" == "false" || "$migration_setting" == "0" || "$migration_setting" == "no" || "$migration_setting" == "off" ]] || fail "перед восстановлением установите RUN_DATABASE_MIGRATIONS=false в .env"
unset RUN_DATABASE_MIGRATIONS

if [[ -z "${REGISTRY_SNAPSHOT_PASSWORD:-}" ]]; then
  if [[ -t 0 ]]; then
    read -r -s -p "Ключ снимка базы: " REGISTRY_SNAPSHOT_PASSWORD
    echo
    export REGISTRY_SNAPSHOT_PASSWORD
  else
    fail "задайте REGISTRY_SNAPSHOT_PASSWORD или запустите скрипт из интерактивного терминала"
  fi
fi

actual_sha256="$(openssl dgst -sha256 "$snapshot_path" | awk '{print $NF}')"
[[ "$actual_sha256" == "$expected_sha256" ]] || fail "контрольная сумма зашифрованного снимка не совпала"

temp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$temp_dir"
  unset REGISTRY_SNAPSHOT_PASSWORD
}
trap cleanup EXIT

echo "Расшифровываю и проверяю снимок..."
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in "$snapshot_path" \
  -out "$temp_dir/registry-state.tar.gz" \
  -pass env:REGISTRY_SNAPSHOT_PASSWORD
tar -xzf "$temp_dir/registry-state.tar.gz" -C "$temp_dir"
[[ -s "$temp_dir/registry.dump" ]] || fail "в снимке нет дампа PostgreSQL"
[[ -f "$temp_dir/chat_uploads.tar" ]] || fail "в снимке нет файлов чата"

echo "Запускаю только PostgreSQL..."
docker compose up -d db
ready=false
for _ in {1..60}; do
  if docker compose exec -T db pg_isready -U registry -d registry >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || fail "PostgreSQL не стал доступен"
docker compose exec -T db pg_restore --list < "$temp_dir/registry.dump" >/dev/null || fail "дамп PostgreSQL повреждён"

echo "Создаю страховочную копию текущей серверной базы..."
backup_path="$(./ops/production/backup.sh)"
echo "Страховочная копия: $backup_path"

echo "Останавливаю приложение и полностью заменяю базу локальным снимком..."
docker compose stop backend frontend >/dev/null 2>&1 || true
docker compose exec -T db psql -U registry -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='registry' AND pid <> pg_backend_pid()" >/dev/null
docker compose exec -T db dropdb -U registry --if-exists --force registry
docker compose exec -T db createdb -U registry registry
docker compose exec -T db pg_restore -U registry -d registry \
  --exit-on-error --no-owner --no-privileges < "$temp_dir/registry.dump"

fingerprint="$(docker compose exec -T db psql -U registry -d registry -At -F '|' -c "SELECT (SELECT count(*) FROM obligations),(SELECT COALESCE(sum(amount),0) FROM obligations),(SELECT count(*) FROM users),(SELECT count(*) FROM reference_values),(SELECT count(*) FROM chat_messages)")"
[[ "$fingerprint" == "$expected_fingerprint" ]] || fail "контрольные показатели восстановленной базы не совпали: $fingerprint"

echo "Собираю приложение и восстанавливаю файлы чата..."
docker compose build backend frontend
project_parent="$(dirname "$project_dir")"
uploads_backup_dir="$project_parent/backups/obligations-registry"
mkdir -p "$uploads_backup_dir"
chmod 700 "$uploads_backup_dir"
uploads_backup="$uploads_backup_dir/chat_uploads_pre_restore_$(date '+%Y-%m-%d_%H-%M-%S').tar"
docker compose run --rm --no-deps -T --entrypoint sh backend -c 'tar -C /data/chat_uploads -cf - .' > "$uploads_backup"
chmod 600 "$uploads_backup"
docker compose run --rm --no-deps -T --entrypoint sh backend -c 'find /data/chat_uploads -mindepth 1 -delete; tar -C /data/chat_uploads -xf -' < "$temp_dir/chat_uploads.tar"

echo "Запускаю backend и frontend..."
docker compose up -d --no-deps backend frontend
app_port="$(awk -F= '/^APP_PORT=[0-9]+$/ {print $2}' .env | tail -1)"
app_port="${app_port:-8088}"
healthy=false
for _ in {1..60}; do
  if curl --fail --silent --show-error "http://127.0.0.1:${app_port}/api/health" >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 1
done
[[ "$healthy" == true ]] || fail "приложение не прошло health-check; страховочная копия базы: $backup_path"

docker compose ps
echo "Готово: восстановлена локальная база ($fingerprint)."
echo "Страховочная копия прежней базы: $backup_path"
echo "Страховочная копия прежних файлов чата: $uploads_backup"
