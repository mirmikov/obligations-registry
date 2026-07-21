# Production safety

When working with the deployed service or `/home/mirmikov/obligations-registry`:

- Treat the PostgreSQL volume and `.env` as production data. Never overwrite, recreate, copy from the repository, or commit them.
- Never run `docker compose down -v`, `docker volume rm`, `docker system prune --volumes`, database re-seeding, Excel re-import, `DROP`, `TRUNCATE`, or destructive restore unless the user explicitly requests a database operation and confirms a verified backup.
- Before any production update, inspect `git status --short`. If it is not clean, stop: preserve the server-only fixes in a separate Git branch and merge them through GitHub first.
- Deploy code only with `./ops/production/update-from-github.sh main` or, after an already completed pull, `./ops/production/deploy-platform.sh`.
- Production `.env` must contain `RUN_DATABASE_MIGRATIONS=false`. Schema changes require a separate reviewed migration plan and explicit user approval.
- The deployment must back up and validate PostgreSQL, rebuild only `backend` and `frontend`, use `docker compose up -d --no-deps backend frontend`, and verify that the database container, volume, row counts, total amount, user count, reference count, and chat-message count did not change.
- Never solve a deployment problem by deleting or recreating the database container or volume.
