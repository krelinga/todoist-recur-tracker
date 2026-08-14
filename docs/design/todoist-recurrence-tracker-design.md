# Todoist recurrence tracker — label-based design

## 1. Requirements

**Functional**

- A user opts a task into tracking by adding a starter label (e.g. `track-recurrence`).
- The system discovers newly-starred tasks and gives each one its own dedicated counter label, then removes the starter label.
- The system detects each time a tracked task is completed and increments that task's counter label.
- The counter is human-visible directly on the task, with no separate dashboard.

**Non-functional**

- Personal scale: likely well under 100 tracked tasks at once.
- Freshness: a completion should be reflected within one polling cycle (15–30 min).
- No double-counting, and no silent data loss if the script restarts or a run is missed.
- Runs unattended as a self-hosted standalone service.

**Constraints**

- Single user, single Todoist account, personal API token.
- **Exactly one instance runs at a time.** The state store assumes a single writer, and two containers sharing a token would each independently advance cursors and rename labels — double-counting and fighting over the same label names. Don't scale this to multiple replicas; if the container is restarted, let the old one exit before the new one starts.
- Ships as a single Docker container, self-hostable on any operator-controlled machine (a home server, a NAS, a small VPS) — no dependency on a specific cloud provider.
  - The container bundles the poller script and its own in-process scheduler — a plain `setInterval`-based sleep loop is enough for a fixed 15–30 min cadence, no cron-expression library needed — so `docker run` is enough to get both phases polling on schedule, with no separate host-level cron entry to maintain.
  - Configuration comes in via environment variables, so the image itself stays generic and redeployable:

    | Variable | Default | Purpose |
    |---|---|---|
    | `TODOIST_API_TOKEN` | *(required)* | Personal API token. |
    | `POLL_INTERVAL_MINUTES` | `20` | Cadence of the poll loop. |
    | `STARTER_LABEL` | `track-recurrence` | Label a user adds to opt a task into tracking. |
    | `METRICS_PORT` | `9090` | Port for the `/metrics` endpoint (see Monitoring). |
    | `LOG_LEVEL` | `INFO` | Minimum log level (see Logging). |
  - The process handles `SIGTERM` gracefully: finish (or cleanly abandon) the in-flight poll cycle, close the SQLite handle, then exit — so `docker stop` during a cycle can't interrupt a write mid-transaction or leave a rename half-applied.
  - Alongside the poll loop, the container runs a small always-on HTTP server exposing `/metrics` on `METRICS_PORT` (default `9090`) for Prometheus to scrape between poll cycles — publish that port (`-p 9090:9090`) to reach it from outside the container.
  - The SQLite state file lives in a named Docker volume (e.g. `-v recurrence-tracker-data:/app/data`), not a bind mount — Docker owns and persists it independent of any particular host path. That pushes a small requirement onto the container's startup logic: on boot, before starting the poll loop, it needs to check whether `tracked_tasks.db` already exists at that path inside the volume and run schema init/migrations only if it doesn't, so a fresh named volume (first run, or a volume that was never populated) bootstraps cleanly while an existing one is left untouched.
  - Logs go to stdout/stderr so they show up in `docker logs` without extra plumbing.
- Chosen counting strategy is incremental (store a cursor per task, only add newly-seen completions) rather than recomputing the full count from history every poll — this isn't just an efficiency choice: Todoist's completed-tasks endpoint only returns the last 3 months of history, so recomputing from scratch would silently undercount any task tracked longer than that. Keeping our own running tally is the only way to preserve completions that have aged out of Todoist's window.

## 2. The catch in the naive approach — and the fix

Todoist label names must be **unique across the whole account**, and creation is idempotent: creating a label that already exists returns the existing one rather than erroring. That rules out the obvious approach of naming each counter label after its count alone — if two different tracked tasks are both sitting at zero recurrences, "recurrences: 0" can't exist twice. The second task would silently get attached to the *first* task's label, and both tasks would then share (and stomp on) one counter.

**Fix:** rather than embedding the full Todoist task ID (long, and not exactly pretty in a label — `🔁 x0 #6839201422`), keep our own task_id → short_id mapping in the SQLite state store, assigned once when a task is first onboarded. The label name uses that short ID instead:

```
🔁 x0 #42
```

The short ID is a locally-assigned `INTEGER PRIMARY KEY AUTOINCREMENT`, so SQLite guarantees it's unique and — critically — never reused, even if a row is ever deleted. The full Todoist task ID still lives in the same row and is what every API call (completion lookups, label attach/detach) actually keys on; the short ID exists purely to keep the label name compact. Task titles still aren't a safe uniqueness key (duplicates, renames), but the Todoist task ID is permanent — and Todoist keeps the same task ID across every occurrence of a recurring task, it just advances the due date. That's also what makes "poll for completions of this task ID" a coherent query in the first place.

The leading `🔁` is a fixed, decorative tag, chosen so the count reads as the one number that matters at a glance. Keep it to a single simple codepoint — no skin-tone or ZWJ modifiers — so label length stays predictable against Todoist's limit. Uniqueness rests entirely on the plain-digit `short_id`.

## 3. High-level design

```
                 ┌─────────────────────────┐
  setInterval ──▶│   Poller process (run    │
  every 15-30m   │   every cycle, 2 phases) │
                 └───────────┬──────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                                ▼
   Phase A: Onboard new tasks        Phase B: Update counts
   1. GET tasks with starter label   1. For each row in state store:
   2. Insert row (assigns short_id,     GET /tasks/{task_id}
      cursor = now) -- FIRST, so
      short_id exists to name       2. 404, or 200 but the counter
      the label with                    label is no longer in the
   3. Create "🔁 x0 #<short_id>"          task's labels array: task is
      label, record label_id            done (deleted, completed with
   4. Attach counter label,              no recurrence left, or label
      remove starter label               manually removed) → delete
                                         the label, delete the row
                                      3. Otherwise: GET completions
                                         for that task_id since
                                         last_completion_at; if new
                                         ones found, commit the
                                         updated count + cursor to
                                         the state store, then sync
                                         the label name to match
              │                                │
              └───────────────┬────────────────┘
                              ▼
                     Local state store
                  (task_id, short_id, label_id,
                   count, cursor)
```

Two phases, one process, one Todoist token. No queue, no external services needed at this scale — the state store is the only piece of durable infrastructure.

**Cleanup policy — one check per tracked task.** Every tracked task's counter label stays attached to it for as long as tracking is active, so "is this task still being tracked" reduces to two questions answered by a single `GET /tasks/{task_id}`: does the task still exist, and does it still carry its counter label? Either a 404 or a 200 whose `labels` array no longer contains the counter label means tracking is over, for any of three equivalent reasons: the task was deleted, it was completed with no recurrence left to regenerate it, or the user manually stripped the label off the task (a handy built-in way to opt a task out early). All three collapse to the same cleanup action — delete the label, delete the row — acted on as soon as the check comes back.

Keying this check on `task_id` rather than on a label-name filter is deliberate. The label's name changes every time the count does, so a name-based filter would be matching on mutable data — and if a rename ever failed partway (see Idempotency in section 6), the next cycle's lookup would find nothing and wrongly conclude the task was gone, pruning a perfectly healthy task and discarding its count. `task_id` never changes, so the check can't be fooled that way, and inspecting the returned `labels` array locally still catches manual label removal. Checking per-task rather than batching also means one bad or failed lookup only ever affects the single task it's checking, not the whole tracked set. A task that goes quiet and later starts recurring again just gets re-onboarded from scratch (starter label re-added, counter restarts at 0) — acceptable in exchange for not needing a second detection path at all.

## 4. Data model

State store (SQLite is a good fit: durable, transactional, zero ops overhead for a single-writer personal script):

```
tracked_tasks
  short_id             integer primary key autoincrement  -- compact, permanent, never reused
  task_id              text unique not null                -- Todoist task ID (stable across recurrences)
  label_id             text               -- Todoist label ID for this task's counter
  recurrence_count     integer default 0
  last_completion_at   timestamp not null -- cursor: completed_at of the most recent completion counted so far;
                                          -- initialized to onboarding time, never null
  created_at            timestamp
  updated_at            timestamp
```

`short_id` is assigned once, at onboarding, and is what gets embedded in the label name (`🔁 x<count> #<short_id>`) — `task_id` remains the key every Todoist API call actually uses. `last_completion_at` is what makes incremental counting safe across restarts: each poll asks "anything newer than this?" instead of re-deriving state from scratch.

**Counting starts at zero, not from history.** `last_completion_at` is seeded with the onboarding timestamp rather than left null, so the first poll only sees completions that happen *after* the task was opted in. That's a deliberate choice: Todoist only exposes 3 months of completion history, so backfilling would produce a count that's accurate for recently-created tasks and silently truncated for long-lived ones — worse than a count that's honestly "since tracking began." A null cursor would also make "everything since the beginning of time" the natural reading, which would contradict the counter starting at `x0`.

**Always take the cursor value from Todoist's returned `completed_at`, never from the local clock.** Advancing it to `Date.now()` after a successful poll would introduce clock-skew risk in the one direction that loses data: if the local clock runs even slightly ahead of Todoist's, a completion timestamped in that gap would fall before the cursor on the next poll and never be counted.

**Why a timestamp and not a completion-event ID.** Todoist's `by_completion_date` endpoint filters by date range in the first place, and the current API's item IDs are opaque alphanumeric strings with no documented ordering guarantee, so an ID-based cursor wouldn't be safe even if the endpoint accepted one. There's deliberately no separate table tracking individual completion-event IDs for dedup either — see the Idempotency note in section 6 for how double-counting is avoided without one. There's also no `status` column: a row's existence *is* the "still tracking" signal, and the per-task check in section 3 is what decides whether it should keep existing.

## 5. API calls (Todoist REST API v1)

| Step | Call |
|---|---|
| Find starter-labeled tasks | `GET /tasks?filter=@<STARTER_LABEL>` |
| Create counter label | `POST /labels` `{name: "🔁 x0 #<short_id>"}` |
| Attach + remove labels | `POST /tasks/{id}` with full replacement `labels` array |
| Check for new completions | `GET /tasks/completed/by_completion_date` filtered to the task, `since=<last_completion_at>` |
| Bump the counter | `POST /labels/{label_id}` `{name: "🔁 x<n> #<short_id>"}` |
| Check if a tracked task is still tracked | `GET /tasks/{task_id}` — 404, or a 200 whose `labels` array no longer contains the counter label, both mean "stop tracking" |
| Prune a task that's no longer tracked | `DELETE /labels/{label_id}` |

Rename-in-place is cheap and is the whole trick: the label *is* the storage for the human-visible count, while the local state store is the storage for the operational cursor that makes incrementing safe. Note that only the starter-label lookup uses Todoist's `@label` filter syntax — the per-task tracking check deliberately goes through `GET /tasks/{task_id}` instead, since a filter on the counter label would be matching a name that changes with every count bump (see the cleanup policy in section 3 for why that's unsafe).

## 6. Reliability

- **Onboarding ordering:** Phase A must insert the state-store row *first*, before touching Todoist. Two reasons. Mechanically, `short_id` is assigned by SQLite on insert, so the row has to exist before there's an ID to name the label with. More importantly, it's what makes onboarding crash-safe: the starter label is the only thing that makes an un-onboarded task discoverable, so if the process died after removing it but before the row was written, the task would be invisible to both phases forever — no starter label for Phase A to find, no row for Phase B to check. Writing the row first inverts that failure mode into a recoverable one. Remove the starter label last, only after the counter label is created and attached, and treat a row whose `label_id` is still empty as "resume onboarding" on the next cycle rather than as a tracked task.
- **Re-adding the starter label to an already-tracked task** is a no-op, not an error: `task_id` is `unique`, so the insert would fail. Detect the existing row first, log at `DEBUG`, strip the redundant starter label off the task, and move on — the task is already tracked and its count should not restart.
- **Idempotency without a completion-event ledger:** deliberately no second table tracking individual completion-event IDs — that would add real schema complexity for a personal-scale tool, and a single task can't be completed twice within the same instant anyway, so timestamp-level precision is enough. Instead, correctness comes from ordering: when new completions are found, commit the updated `recurrence_count` and `last_completion_at` to SQLite *first* — that's the durable source of truth — and only then call Todoist to rename the label to match. Do that rename unconditionally every cycle, even when no new completions were found, rather than only right after a count change. That makes the label self-healing: if the process crashes after the SQLite commit but before the rename call goes through, the very next cycle just re-issues the same rename with the already-correct count — no re-fetching or re-counting involved, and no risk of double-counting the same completions twice.
- **Missed runs are self-healing:** because the cursor is "everything since X," a skipped cycle just gets caught up on the next one — no special backfill logic needed.
- **Cleanup ordering:** when a task's tracking check says it's done, delete the Todoist label first, then delete its row from the state store — never the reverse. If the process crashes in between, the row survives and the next run just re-attempts the (now-already-gone) label delete; treat a 404 there as success and proceed to remove the row. Deleting the row first would risk a crash leaving an orphaned label in Todoist with no local record of it. Also worth distinguishing a definitive answer from a failed request: only a 404, or a 200 that genuinely lacks the counter label, means "prune this one." A rate-limited or network-failed lookup should be retried next cycle rather than treated as evidence the task is gone. Because the check is per-task, a mistake here only ever risks that single task's label, not the whole tracked set.
- **State durability:** since the container's SQLite file lives in a named Docker volume rather than the container's own writable layer, it survives image updates, restarts, and `docker compose down`/`up` cycles without extra plumbing. Moving hosts is the one case that needs a deliberate step, though — a named volume isn't a plain directory that can simply be copied, so migrating it means an explicit `docker volume` backup/restore (e.g. tar it out via a throwaway container) rather than dragging a folder along. Worth including that as a one-line note in the container's README so the counters don't get lost during a reprovision.

## 7. Trade-offs made explicit

| Decision | Upside | Cost |
|---|---|---|
| Self-hosted Docker container vs. a managed/hosted automation platform | Full control, no third-party service in the loop, deployable on any existing Docker host | Hosting, secrets, monitoring, and restart logic all become the operator's responsibility |
| Incremental counting vs. recompute-from-history each poll | Correctness beyond 3 months, not just efficiency — Todoist's completed-tasks endpoint only returns a 3-month window, so recompute-from-history would silently undercount any long-lived tracked task | Needs durable state; a corrupted or lost state file makes the running count permanently wrong, with no way to recompute it from Todoist for anything older than 3 months — an accepted risk here in exchange for a simpler system |
| Count stored in the label text itself | Zero-dashboard visibility, count is right there on the task | Fragile to manual edits — a hand-edited counter label gets overwritten on the next cycle from local state, not read back from Todoist |
| Locally-assigned short-ID label names (vs. embedding the raw Todoist task ID) | Guaranteed uniqueness, survives task renames, and stays compact (`#42` vs `#6839201422`) | One more thing living in the state store — the short_id ↔ task_id mapping is now load-bearing, so losing it means the label can no longer be traced back to its task automatically |
| Per-task tracking and completion queries (vs. batching across all tracked labels) | Small blast radius — a bad or failed response only ever affects the one task it's checking, not the whole tracked set; and keying on immutable `task_id` avoids the false-prune risk a mutable-label-name filter would carry | More API calls per cycle (two per tracked task). Not a real concern at the personal scale this is built for, and not the fix if it ever did become one — spacing the per-task queries out over the poll interval rather than batching them would be the preferred way to handle a much larger tracked-task count |
| Timestamp cursor (vs. a completion-event-ID ledger table) | One column instead of a second table; no join or cleanup logic for a growing event log | Relies on commit-then-sync ordering (see Idempotency in section 6) rather than a durable per-event dedup record — an accepted trade given how unlikely same-instant duplicate completions are for a single task |
| `node:sqlite` (vs. `better-sqlite3`) for the state store (see section 10) | No native-module dependency, no compiler toolchain in the Docker build, one less thing in `package.json` | Newer and less battle-tested than `better-sqlite3`; ties the image to a Node version where it's stable (24+) rather than working unchanged all the way back to Node 20 |
| Hand-rolled logger (vs. `pino`/`winston`) for the leveled stdout logging in section 9 | No dependency for something this small — four levels, a handful of call sites, no structured-log shipping target to satisfy | Loses what a real logging library provides for free (JSON output mode, child loggers, transport plugins) if requirements ever grow past what this design calls for |

## 8. Monitoring

An always-on `/metrics` HTTP endpoint (see the Docker bullet in section 1) exposes Prometheus-format metrics continuously, independent of the poll cycle — a scrape can happen at any point between polls and still see fresh values from the last completed cycle. All metric names below are prefixed `recurrence_tracker_`; none carry a `task_id` or `short_id` label, since that would create an unbounded, ever-growing set of time series as tasks come and go — anything task-specific stays in logs, not metrics.

**Poll cycle health** — the most important category, since a missed or failing poll is otherwise invisible (a skipped cycle is self-healing for counting, but silent):

| Metric | Type | Purpose |
|---|---|---|
| `recurrence_tracker_last_successful_poll_timestamp_seconds` | Gauge | Unix timestamp of the last poll cycle that completed without error. The key alerting metric — page if `time() - this > (poll interval × 3)` or similar, catching a wedged or crashed process well before a human would otherwise notice. |
| `recurrence_tracker_poll_cycles_total{result="success\|error"}` | Counter | Cycle outcomes over time, for an error-rate panel. |
| `recurrence_tracker_poll_duration_seconds` | Histogram | How long a full cycle (Phase A + B) takes — creeping duration is the leading indicator that the batching trade-off in section 7 is becoming relevant. |

**Tracking state** — the business-level view of what the system is actually doing:

| Metric | Type | Purpose |
|---|---|---|
| `recurrence_tracker_tracked_tasks` | Gauge | Current number of rows in the state store — a sanity-check number, should roughly match the number of tasks opted into tracking. |
| `recurrence_tracker_tasks_onboarded_total` | Counter | Cumulative count of tasks that have entered tracking (Phase A). |
| `recurrence_tracker_tasks_pruned_total` | Counter | Cumulative count of tasks removed from tracking (task gone, or counter label no longer attached). A sudden spike is worth a look — could mean a batch of tasks got deleted, or something upstream is misbehaving. |
| `recurrence_tracker_completions_recorded_total` | Counter | Cumulative individual completion events counted across every tracked task combined — the aggregate "total recurrences tracked" number. |

**Todoist API health** — the one external dependency this whole system leans on:

| Metric | Type | Purpose |
|---|---|---|
| `recurrence_tracker_todoist_requests_total{endpoint, outcome="success\|error"}` | Counter | Request volume and error rate, broken down by endpoint (labels, tasks, completed-tasks) — labels here are a small fixed set of endpoint names, not per-task values, so cardinality stays bounded. |
| `recurrence_tracker_todoist_request_duration_seconds{endpoint}` | Histogram | Latency per endpoint — useful for spotting Todoist-side slowness vs. a problem in the container itself. |

**State store:**

| Metric | Type | Purpose |
|---|---|---|
| `recurrence_tracker_state_db_size_bytes` | Gauge | Size of the SQLite file in the named volume — a slow-moving capacity/sanity metric, not worth a tight alert threshold at this scale. |

## 9. Logging

Metrics answer "did something happen" (a graph, a counter, an alert); logs answer "what, specifically, and why" — the two are complementary, not redundant, and the design leans on that split to keep logs quiet. Every per-task check that finds nothing worth doing (task still tracked, no new completions, nothing to prune) produces zero log output by default — that's the steady-state majority case every cycle, and logging it would drown out everything worth reading. Only state changes and problems get a line.

Plain leveled text to stdout/stderr (not JSON) is the right default here — this is a single-operator personal tool meant to be skimmed with `docker logs -f`, not shipped to a log aggregator. Each line is timestamped and self-contained: `2026-08-13T14:32:01Z INFO  onboarded task 6839201422 -> 🔁 x0 #42`. `LOG_LEVEL` (env var, default `INFO`) controls the floor; `DEBUG` unlocks the full per-task firehose for active troubleshooting, everything above stays quiet by default. Log lines reference a task with the short `🔁 #<short_id>` tag rather than repeating the full label text each time — the count already appears explicitly wherever it's relevant (e.g. a before/after transition), so restating it in the tag would just be noise.

| Level | What it covers | Example |
|---|---|---|
| `DEBUG` | Every per-task tracking and completion check, including ones that find nothing new; the unconditional label-resync call each cycle (see Idempotency in section 6) even when it's a no-op; a redundant starter label being stripped off an already-tracked task. Off by default — this is the firehose. | `tracking check: 🔁 #42 (task 6839201422) still tracked, no new completions` |
| `INFO` | State changes only: a task onboarded, a completion counted (with before/after count), a task pruned, an interrupted onboarding resumed, and one summary line per poll cycle as a liveness heartbeat. | `🔁 #42: +1 completion (task 6839201422), count 3 -> 4`, `pruned 🔁 #58 (task 6839200011): no longer tracked, final count 12`, `poll cycle complete in 1.8s: 14 tracked, 1 onboarded, 2 completions recorded, 1 pruned` |
| `WARN` | Recoverable anomalies that don't fail the whole cycle: a per-task lookup that errored and is being treated as "skip cleanup this cycle" rather than "task is gone" (see Reliability), a rate-limited or retried Todoist request. | `tracking check failed for 🔁 #77 (task 6839204410): 503 from Todoist, skipping cleanup this cycle` |
| `ERROR` | Anything that ends the poll cycle early: an unhandled exception, a Todoist auth failure, a state-store write failure. The cycle is abandoned rather than partially applied, and the next scheduled cycle just tries again — this is also what drives `poll_cycles_total{result="error"}` and the staleness of `last_successful_poll_timestamp_seconds` in section 8. | `poll cycle failed: 401 Unauthorized from Todoist -- check TODOIST_API_TOKEN` |

One INFO-level line also fires once at container startup, echoing the resolved configuration from the table in section 1 — `POLL_INTERVAL_MINUTES`, `STARTER_LABEL`, `METRICS_PORT`, `LOG_LEVEL`, and whether `TODOIST_API_TOKEN` was found (never the token itself) — cheap insurance against a misconfiguration going unnoticed, without needing to shell into the container.

## 10. Language and libraries

TypeScript on Node.js. Todoist's library support there is strong: Doist maintains an official SDK rather than leaving it to the community. Recently renamed from `@doist/todoist-api-typescript` to `@doist/todoist-sdk`, it targets the same v1 API this design is built against and ships typed methods with built-in retry logic, error handling, and snake_case↔camelCase transforms — no hand-rolled `fetch` calls or response mapping needed for anything in section 5's API table (task/label CRUD, filtered task queries, paginated completed-task queries). It requires Node 20.18.1+.

| Concern | Pick | Why |
|---|---|---|
| Todoist API client | `@doist/todoist-sdk` | Official, Doist-maintained, typed, already targets v1 — the alternative is hand-rolling HTTP calls against the same endpoints in section 5 for no real benefit. |
| Runtime / Docker base image | Node 24 (`node:24-alpine`), currently Active LTS | Comfortable headroom over the SDK's Node 20.18.1+ floor, and current enough for `node:sqlite` (below) to be in good shape. |
| State store driver | `node:sqlite` (built in, no install) | No native-module dependency and no compiler toolchain in the Docker build — fits a single-container personal tool better than pulling in a native driver. It reached Stability 1.2 (release candidate, API considered unlikely to change) on Node 24; see the trade-off row in section 7 for when `better-sqlite3` would be the better call. |
| Prometheus metrics | `prom-client` | The de facto standard for Node — Counter, Gauge, and Histogram map directly onto every metric type proposed in section 8, plus free default process metrics (CPU, memory, event-loop lag) at no extra cost. |
| `/metrics` HTTP endpoint | Node's built-in `http` module | One route, no routing logic to speak of — a full framework (Express/Fastify) would be a dependency for nothing it's actually using. |
| Scheduling | None — a plain `setInterval` loop | A fixed 15–30 min cadence doesn't need cron-expression parsing; see the updated Docker bullet in section 1. |
| Logging | Hand-rolled (~a few dozen lines) | Section 9's spec — four levels, plain leveled text to stdout, no JSON, no shipping target — is simple enough not to justify `pino` or `winston`; see the trade-off row in section 7. |
| Config parsing | `zod` (optional) | Validates and types the environment variable table from section 1 at startup — catching a missing `TODOIST_API_TOKEN` or a non-numeric `POLL_INTERVAL_MINUTES` immediately rather than mid-cycle — and feeds the "echo resolved config" startup log line from section 9. Skippable in favor of plain `process.env` reads to avoid the dependency. |
| Tests (if/when added) | `vitest` | Native TypeScript support without a separate `ts-jest` config; not a requirement of this design, just the natural pick if testing gets added later. |

Build-wise, this needs a two-stage Dockerfile rather than a single `COPY` step: a build stage that installs devDependencies and runs `tsc`, and a slim final stage that copies only the compiled `dist/` output plus production `node_modules` — otherwise every deploy would be shipping TypeScript source and a full devDependency tree into what's supposed to be a lean, single-purpose container.
