# todoist-recur-tracker

A single-container, self-hosted service that tracks how many times a
recurring Todoist task has been completed, and shows the running count
directly on the task itself via a per-task counter label (e.g. `🔁 x4 #42`) —
no separate dashboard or database UI.

Opt a task in by adding a starter label (`track-recurrence` by default). The
service polls the Todoist API on a fixed interval (20 min by default),
onboards newly-labeled tasks, and increments each tracked task's counter
label as new completions come in. Full design rationale lives in
[`docs/design/todoist-recurrence-tracker-design.md`](docs/design/todoist-recurrence-tracker-design.md).

## Running it

**Exactly one instance may run against a given Todoist token at a time.** The
state store assumes a single writer — never scale this to multiple replicas,
and let an old container exit before starting a replacement on restart.

```sh
docker build -t todoist-recur-tracker .

docker run -d \
  --name todoist-recur-tracker \
  -e TODOIST_API_TOKEN=your-todoist-api-token \
  -v recurrence-tracker-data:/app/data \
  -p 9090:9090 \
  todoist-recur-tracker
```

- `-v recurrence-tracker-data:/app/data` — the SQLite state file lives in a
  named volume so it survives image updates and container restarts. Schema
  init only runs on a genuinely fresh volume; an existing one is left alone.
- `-p 9090:9090` — exposes the Prometheus `/metrics` endpoint.
- Logs go to stdout/stderr: `docker logs -f todoist-recur-tracker`.
- Graceful shutdown: `docker stop` sends SIGTERM, which lets the in-flight
  poll cycle finish before the container exits.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TODOIST_API_TOKEN` | *(required)* | Personal API token. |
| `POLL_INTERVAL_MINUTES` | `20` | Cadence of the poll loop. |
| `STARTER_LABEL` | `track-recurrence` | Label a user adds to opt a task into tracking. |
| `METRICS_PORT` | `9090` | Port for the `/metrics` endpoint. |
| `LOG_LEVEL` | `INFO` | Minimum log level (`DEBUG`, `INFO`, `WARN`, `ERROR`). |

### Migrating to a new host

A named Docker volume isn't a plain directory you can copy directly.
Back it up and restore it via a throwaway container, e.g.:

```sh
# On the old host
docker run --rm -v recurrence-tracker-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/recurrence-tracker-data.tgz -C /data .

# On the new host
docker volume create recurrence-tracker-data
docker run --rm -v recurrence-tracker-data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/recurrence-tracker-data.tgz -C /data
```

## Releasing

Docker images are published to GitHub Container Registry via a manual-only
workflow ([`.github/workflows/docker-release.yml`](.github/workflows/docker-release.yml))
— it never runs automatically on push, PR, or a schedule. To cut a release:

1. Bump `version` in `package.json` and run `npm install` to resync
   `package-lock.json` (the pre-commit hook enforces this before you can
   even commit it).
2. Trigger the workflow from the repo's Actions tab ("Run workflow"), or:
   ```sh
   gh workflow run docker-release.yml --ref <branch-or-tag>
   ```
3. It runs typecheck + tests, then builds and publishes
   `ghcr.io/<owner>/<repo>` tagged with `major`, `major.minor`, and
   `major.minor.patch` read from `package.json` — e.g. version `1.2.3`
   produces `:1`, `:1.2`, and `:1.2.3`.

```sh
docker pull ghcr.io/krelinga/todoist-recur-tracker:1
```

## Development

Requires Node 20.18.1+ (the project targets Node 24).

```sh
npm install
npm run typecheck   # tsc --noEmit, includes tests
npm test            # vitest run
npm run build       # compiles src/ (excluding tests) to dist/
npm start           # runs the compiled dist/index.js
```

`npm install` also points git at the repo's `.githooks/` directory (via the `prepare` script), which installs a pre-commit check that blocks a commit if `package.json`'s version doesn't match `package-lock.json`'s — run `npm install` again to resync after bumping the version.
