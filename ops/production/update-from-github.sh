#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_dir"

branch="${1:-main}"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "ОШИБКА: на сервере есть локальные изменения. Обновление остановлено, чтобы их не потерять." >&2
  echo "Создайте отдельную ветку, закоммитьте изменения, отправьте её в GitHub и объедините с $branch." >&2
  exit 1
fi

git fetch origin "$branch"
git switch "$branch"
git pull --ff-only origin "$branch"
exec ./ops/production/deploy-platform.sh
