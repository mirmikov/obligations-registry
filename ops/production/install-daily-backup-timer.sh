#!/usr/bin/env bash
set -Eeuo pipefail

fail() { echo "ОШИБКА: $*" >&2; exit 1; }
[[ "${CONFIRM_INSTALL_DAILY_BACKUP_TIMER:-}" == "YES" ]] || fail "укажите CONFIRM_INSTALL_DAILY_BACKUP_TIMER=YES"
[[ "$EUID" -eq 0 ]] || fail "скрипт установки нужно запустить через sudo"

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "$project_dir" == "/home/mirmikov/obligations-registry" ]] || fail "неожиданный production-путь: $project_dir"
id mirmikov >/dev/null 2>&1 || fail "пользователь mirmikov не найден"
getent group docker >/dev/null 2>&1 || fail "группа docker не найдена"

install -d -o mirmikov -g mirmikov -m 700 /home/mirmikov/backups/obligations-registry
install -d -o mirmikov -g mirmikov -m 755 /home/mirmikov/backup-status/obligations-registry
install -o root -g root -m 644 "$project_dir/ops/production/systemd/obligations-registry-backup.service" /etc/systemd/system/obligations-registry-backup.service
install -o root -g root -m 644 "$project_dir/ops/production/systemd/obligations-registry-backup.timer" /etc/systemd/system/obligations-registry-backup.timer
systemctl daemon-reload
systemctl enable --now obligations-registry-backup.timer
systemctl is-enabled obligations-registry-backup.timer
systemctl is-active obligations-registry-backup.timer
systemctl list-timers obligations-registry-backup.timer --no-pager
