# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Implementation is complete and has been live-tested end-to-end against a real Todoist instance (see "End-to-end testing" below). Source lives in `src/` (config, logger, SQLite state store, Todoist client wrapper, Prometheus metrics, the two poll phases, the poll-cycle orchestrator, `index.ts` entrypoint), with tests in `src/__tests__/` (vitest). Commands: `npm run build` (compiles `src/` to `dist/`, excluding tests — see `tsconfig.build.json`), `npm run typecheck` (`tsc --noEmit`, includes tests), `npm test` (`vitest run`), `npm start` (`node dist/index.js`). A two-stage `Dockerfile` and `README.md` also exist. The design doc remains the source of truth for *why*; follow the language/library choices and structure below when touching implementation, and see "End-to-end testing" for how live testing against a real instance has already changed the completion-detection mechanism from what section 5 originally specified.

## What this project is

A single-container, self-hosted service that lets a Todoist user track how many times a recurring task has been completed, by opting a task in with a label and then rendering the running count directly in a per-task counter label (e.g. `🔁 x4 #42`) — no separate dashboard or database UI. It polls the Todoist API on a fixed interval (default 20 min) rather than using webhooks.

Full rationale for every design decision lives in `docs/design/todoist-recurrence-tracker-design.md`. Read it before implementing — it is the source of truth for *why*, not just *what*. Key points future instances need without re-reading the whole doc:

### Core mechanism: the label *is* the counter

Todoist label names are unique account-wide and label creation is idempotent (creating a duplicate name returns the existing label). Because two different tasks can't both be at count 0, each tracked task gets a locally-assigned, never-reused `short_id` (SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`) baked into its counter label name instead of the full Todoist task ID. The label is renamed in place every time the count changes; `task_id` (Todoist's permanent ID, stable across recurrence instances) is what every API call actually keys on.

### Two-phase poll cycle (one process, one interval)

- **Phase A — onboard:** find tasks carrying the starter label (`STARTER_LABEL`, default `track-recurrence`), insert a state-store row first (this is what assigns `short_id`), create/attach the `🔁 x0 #<short_id>` label, then remove the starter label last. Row-before-Todoist-writes is deliberate — it's what makes onboarding resumable after a crash (see "Ordering matters" below).
- **Phase B — update/prune:** for every existing row, `GET /tasks/{task_id}`. A 404, or a 200 whose `labels` no longer contains the counter label, means tracking is over (task deleted, completed with no recurrence left, or label manually removed) → delete the label, then delete the row. Otherwise, fetch completions since `last_completion_at`; on new ones, commit count + cursor to SQLite *first*, then rename the label to match — unconditionally, every cycle, even with no new completions, so a crash mid-rename self-heals on the next cycle instead of needing a retry path.

### Data model (SQLite, single table)

`tracked_tasks(short_id, task_id, label_id, recurrence_count, last_completion_at, created_at, updated_at)`. No separate completion-event ledger and no `status` column — a row's existence is the tracking signal, and correctness against double-counting/crashes comes from the commit-before-rename ordering above, not from event-level dedup. `last_completion_at` is seeded at onboarding time (never null, never backfilled from history) because Todoist's completion-history sources are retention-limited (3 months documented for the old completed-tasks endpoint; the Activity Log actually used, see "End-to-end testing" below, has its own unconfirmed window) — this is why counting is incremental rather than recomputed from scratch each poll.

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
| Tests | `vitest` — implemented, see `src/__tests__/` |

Docker build should be two-stage: a build stage running `tsc` with devDependencies, and a slim final stage copying only compiled `dist/` + production `node_modules`. The SQLite file belongs in a named Docker volume (not a bind mount); startup logic must check whether the DB file already exists in that volume and only run schema init on a genuinely fresh volume.

### Operational constraint

Exactly one instance of this service may run against a given Todoist token at a time — the state store assumes a single writer. This is a hard constraint on any deployment tooling, restart scripts, or Docker Compose setup written for this project: never scale it to multiple replicas.

## End-to-end testing against a real Todoist instance

Unit tests mock the Todoist SDK; they can't catch real API behavior that diverges from its documented types. Two rounds of live testing already have — see "What live testing has already found" below — so re-run this checklist after any change to `src/todoist.ts`, `src/poller/`, or the `@doist/todoist-sdk` version, not just after a design change.

**Safety, every time:**
- Only use a dedicated Todoist *test* account/instance token — never a real/production account. The user supplies it via a `TODOIST_API_TOKEN=...` line in a local `.env.local` at the repo root (gitignored via `.env*`). Never ask for it to be pasted into chat, and never echo it in a command's output.
- Source it fresh in every bash call that needs it — shell state doesn't persist between tool calls: `set -a && source .env.local && set +a`.
- Drive test setup/verification directly through `@doist/todoist-sdk` (ad hoc `node -e "..."` scripts against that token) — not the Todoist MCP connector tool, which is likely bound to the user's real account, not the test instance.
- Prefix every test task's content so it's identifiable (e.g. `[recur-tracker test] ...`), and delete every test task/label created before finishing, even if a run fails partway. Verify at the end: `api.getLabels()` shows no `🔁`-named labels, and the local state-store DB has zero rows.

**Running the app for a test cycle:** `npm run build`, then run with a fast interval and full logging, pointed at a scratch DB and a free metrics port:
```bash
POLL_INTERVAL_MINUTES=1 METRICS_PORT=<free-port> LOG_LEVEL=DEBUG DB_PATH=<scratch-dir>/tracked_tasks.db node dist/index.js
```
Run it as a background/disowned process, redirect stdout+stderr to a log file, and wait for cycle boundaries by grepping that log for `"poll cycle complete"` (via the `Monitor` tool or a backgrounded `until` loop) — never a blind `sleep`, since cycle timing isn't exact.

**The checklist** (all passing as of the current implementation):

1. **Onboarding.** Create a task with the starter label — a daily-recurring one (`dueString: 'every day'`) for the counting checks below, plus a second, plain task for the deletion-prune case. Start the app; confirm the first cycle logs `onboarded task <id> -> 🔁 x0 #<n>` for each, and confirm via `api.getTask(id)` directly that the starter label is gone and the counter label is attached.
2. **Counting, two cycles.** `api.closeTask(recurTaskId)`; wait for the next cycle; confirm `count 0 -> 1` in the log and `🔁 x1 #<n>` on the live task. Repeat once more to confirm `1 -> 2`, and that a cycle with no new completions logs nothing at INFO (only a DEBUG "still tracked, no new completions" line).
3. **Prune via deletion.** `api.deleteTask(id)` on a tracked task; confirm the next cycle logs `pruned ... final count <n>`, the label is gone from `api.getLabels()`, and the row is gone from SQLite.
4. **Prune via manual label removal.** `api.updateTask(id, { labels: [] })` (strip just the counter label) on a still-existing tracked task; confirm the same prune outcome.
5. **Restart-safety / scan-cursor bootstrap.** Stop the process (`SIGTERM`), complete the tracked task *while it's down*, restart pointed at the same DB file, and confirm the completion is still caught — allow up to two cycles. Todoist's Activity Log has a short (tens-of-seconds) indexing delay, so the very first post-restart cycle can legitimately come back empty even though the fetch itself succeeded; the very next cycle should catch it, because the completion-scan cursor's 2-day fudge factor (`src/poller/completion-scan-cursor.ts`) keeps that next window wide enough. Treat one empty cycle here as expected, not a failure — two in a row would be a real regression.
6. **Metrics.** `curl localhost:<port>/metrics`; confirm `recurrence_tracker_*` counters/gauges match what actually happened this run (tracked/onboarded/pruned/completions counts; every `todoist_requests_total` outcome is `success`).
7. **Graceful shutdown.** `kill -TERM <pid>`; confirm it exits in well under a second, after logging `received SIGTERM...` then `shutdown complete`.

**What live testing has already found** (full rationale in the design doc, sections 3/6/7 — re-check these specifically if the SDK or Todoist's API ever changes):
- Recurring-task completions never appear in `GET /tasks/completed/by_completion_date` or `/by_due_date` — only genuine one-time completions do. Completion detection goes through the Activity Log (`GET /activities`) instead.
- The Activity Log's documented `objectId` filter is silently ignored server-side (confirmed with a raw request bypassing the SDK) — completion events are fetched account-wide and matched to tracked tasks by `task_id` client-side.
- The Activity Log has a short indexing delay between a completion happening and it becoming queryable (seen directly in testing — checklist item 5 above). This is exactly why the completion-fetch window uses a scan cursor with a 2-day fudge factor rather than a tight "since last successful poll" bound with no margin.
