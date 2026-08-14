# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

This repository currently contains only a design document (`docs/design/todoist-recurrence-tracker-design.md`) — no source code, `package.json`, or tests have been written yet. There are no build/lint/test commands to run until implementation begins. When implementing, follow the language/library choices and structure below; they come directly from the accepted design, not from guesswork.

## What this project is

A single-container, self-hosted service that lets a Todoist user track how many times a recurring task has been completed, by opting a task in with a label and then rendering the running count directly in a per-task counter label (e.g. `🔁 x4 #42`) — no separate dashboard or database UI. It polls the Todoist API on a fixed interval (default 20 min) rather than using webhooks.

Full rationale for every design decision lives in `docs/design/todoist-recurrence-tracker-design.md`. Read it before implementing — it is the source of truth for *why*, not just *what*. Key points future instances need without re-reading the whole doc:

### Core mechanism: the label *is* the counter

Todoist label names are unique account-wide and label creation is idempotent (creating a duplicate name returns the existing label). Because two different tasks can't both be at count 0, each tracked task gets a locally-assigned, never-reused `short_id` (SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`) baked into its counter label name instead of the full Todoist task ID. The label is renamed in place every time the count changes; `task_id` (Todoist's permanent ID, stable across recurrence instances) is what every API call actually keys on.

### Two-phase poll cycle (one process, one interval)

- **Phase A — onboard:** find tasks carrying the starter label (`STARTER_LABEL`, default `track-recurrence`), insert a state-store row first (this is what assigns `short_id`), create/attach the `🔁 x0 #<short_id>` label, then remove the starter label last. Row-before-Todoist-writes is deliberate — it's what makes onboarding resumable after a crash (see "Ordering matters" below).
- **Phase B — update/prune:** for every existing row, `GET /tasks/{task_id}`. A 404, or a 200 whose `labels` no longer contains the counter label, means tracking is over (task deleted, completed with no recurrence left, or label manually removed) → delete the label, then delete the row. Otherwise, fetch completions since `last_completion_at`; on new ones, commit count + cursor to SQLite *first*, then rename the label to match — unconditionally, every cycle, even with no new completions, so a crash mid-rename self-heals on the next cycle instead of needing a retry path.

### Data model (SQLite, single table)

`tracked_tasks(short_id, task_id, label_id, recurrence_count, last_completion_at, created_at, updated_at)`. No separate completion-event ledger and no `status` column — a row's existence is the tracking signal, and correctness against double-counting/crashes comes from the commit-before-rename ordering above, not from event-level dedup. `last_completion_at` is seeded at onboarding time (never null, never backfilled from history) because Todoist's completed-tasks endpoint only returns 3 months of history — this is why counting is incremental rather than recomputed from scratch each poll.

### Ordering matters everywhere

Several invariants in this design exist specifically to survive a crash or `SIGTERM` mid-cycle without double-counting or losing state:
- Onboarding: state-store row → counter label created/attached → starter label removed (never reversed).
- Counting: SQLite commit (count + cursor) → label rename (never reversed); rename is idempotent/repeatable so redoing it on the next cycle after a crash is always safe.
- Cleanup: Todoist label delete → state-store row delete (never reversed); a 404 on the label delete is treated as success (already gone).
- The tracking-check in Phase B keys on the immutable `task_id`, never on a label-name filter — the label's name is mutable (it changes with the count), so filtering by it could false-prune a healthy task after a partially-failed rename.

### Configuration (env vars)

`TODOIST_API_TOKEN` (required), `POLL_INTERVAL_MINUTES` (default `20`), `STARTER_LABEL` (default `track-recurrence`), `METRICS_PORT` (default `9090`), `LOG_LEVEL` (default `INFO`). Config is echoed (token presence only, never its value) in one INFO line at startup.

### Planned language/library choices (from design §10 — apply these when scaffolding)

| Concern | Pick |
|---|---|
| Language/runtime | TypeScript on Node 24 (`node:24-alpine`), needs 20.18.1+ |
| Todoist client | `@doist/todoist-sdk` (official Doist SDK, formerly `@doist/todoist-api-typescript`; typed, retry logic, snake_case↔camelCase built in) |
| State store | `node:sqlite` (built-in, no native-module/compiler toolchain in the Docker build) |
| Metrics | `prom-client`, served via Node's built-in `http` module on `/metrics` |
| Scheduling | Plain `setInterval` loop — no cron-expression library |
| Logging | Hand-rolled leveled text to stdout/stderr (not JSON, not pino/winston) — see log-level table in design §9 |
| Config parsing | `zod` (optional) |
| Tests | `vitest`, once tests are added |

Docker build should be two-stage: a build stage running `tsc` with devDependencies, and a slim final stage copying only compiled `dist/` + production `node_modules`. The SQLite file belongs in a named Docker volume (not a bind mount); startup logic must check whether the DB file already exists in that volume and only run schema init on a genuinely fresh volume.

### Operational constraint

Exactly one instance of this service may run against a given Todoist token at a time — the state store assumes a single writer. This is a hard constraint on any deployment tooling, restart scripts, or Docker Compose setup written for this project: never scale it to multiple replicas.
