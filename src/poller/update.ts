import type { DatabaseSync } from 'node:sqlite';
import { deleteRowByTaskId, getTrackedRows, updateCount } from '../db';
import { counterLabelName, counterLabelPattern, shortIdTag } from '../label-name';
import type { Logger } from '../logger';
import type { Metrics } from '../metrics';
import type { CompletionEvent, TodoistClient } from '../todoist';
import type { CompletionScanCursor } from './completion-scan-cursor';

export type UpdateResult = {
    completionsRecorded: number;
    pruned: number;
};

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// Generous margin subtracted from the last successful scan time to bound the
// completion-events fetch window (see scanCursor below). Covers any
// transient per-row failure (a task's tracking check erroring for a while)
// without needing the fetch to reach back to that row's own stale cursor -
// see the design doc's discussion of why a naive global cursor without this
// margin would risk silently missing a completion.
const COMPLETION_SCAN_FUDGE_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

/**
 * Phase B (design doc section 3): for every tracked row, check whether the
 * task is still tracked, then either prune it or record new completions.
 *
 * Each row is handled independently and a Todoist-call failure here is
 * logged at WARN and skipped for this cycle rather than propagated - a bad
 * or failed lookup should only ever cost the one task it's checking
 * (section 6), never abort the whole cycle.
 *
 * Completion events are fetched ONCE for the whole cycle rather than
 * per-task (see getCompletionEventsSince's doc comment in todoist.ts for
 * why: the real API doesn't support filtering that call to one task). A
 * failure fetching that shared list is logged once and treated as "no new
 * completions this cycle" for every row, rather than aborting the cycle -
 * tracking checks and pruning below are unaffected either way.
 *
 * The fetch window is bounded by `scanCursor` (the last successful fetch
 * time, minus COMPLETION_SCAN_FUDGE_MS) rather than by the oldest tracked
 * row's `last_completion_at`. That's safe even for a task that only
 * recurs yearly: the fetch only needs to include events since we last
 * looked, not since that row's own history, because per-row matching
 * (`event.completedAt > row.lastCompletionAt` below) independently decides
 * whether an event is new to that row regardless of how wide the fetch
 * was. Before the first successful fetch (cursor is null - always true
 * right after a restart, since the cursor is deliberately in-memory only),
 * fall back to today's min-per-row-cursor bootstrap so a restart can never
 * cause a gap.
 */
export async function runUpdatePhase(
    db: DatabaseSync,
    todoist: TodoistClient,
    logger: Logger,
    metrics: Metrics,
    now: Date,
    scanCursor: CompletionScanCursor,
): Promise<UpdateResult> {
    const rows = getTrackedRows(db);
    let completionsRecorded = 0;
    let pruned = 0;

    let completionEvents: CompletionEvent[] = [];
    if (rows.length > 0) {
        const lastScan = scanCursor.get();
        const sinceIso = lastScan
            ? new Date(lastScan.getTime() - COMPLETION_SCAN_FUDGE_MS).toISOString()
            : rows.reduce((min, r) => (r.lastCompletionAt < min ? r.lastCompletionAt : min), rows[0].lastCompletionAt);
        try {
            completionEvents = await todoist.getCompletionEventsSince(sinceIso);
            scanCursor.recordSuccess(now);
        } catch (err) {
            logger.warn(`completion events fetch failed: ${errMessage(err)}, skipping completion counting this cycle`);
        }
    }

    for (const row of rows) {
        const labelId = row.labelId;
        if (!labelId) continue; // getTrackedRows already excludes these; narrows the type

        let task;
        try {
            task = await todoist.getTask(row.taskId);
        } catch (err) {
            logger.warn(`tracking check failed for ${shortIdTag(row.shortId)} (task ${row.taskId}): ${errMessage(err)}, skipping cleanup this cycle`);
            continue;
        }

        const pattern = counterLabelPattern(row.shortId);
        const actualLabelName = task?.labels.find((label) => pattern.test(label));

        if (!task || !actualLabelName) {
            // 404, or a 200 whose labels no longer include the counter label:
            // task deleted, completed with no recurrence left, or the user
            // manually stripped the label - all collapse to the same cleanup.
            try {
                await todoist.deleteLabel(labelId);
            } catch (err) {
                logger.warn(`prune failed for ${shortIdTag(row.shortId)} (task ${row.taskId}): ${errMessage(err)}, will retry next cycle`);
                continue;
            }
            deleteRowByTaskId(db, row.taskId);
            pruned += 1;
            metrics.tasksPrunedTotal.inc();
            logger.info(`pruned ${shortIdTag(row.shortId)} (task ${row.taskId}): no longer tracked, final count ${row.recurrenceCount}`);
            continue;
        }

        const rowCursor = new Date(row.lastCompletionAt);
        const newCompletions = completionEvents.filter((event) => event.taskId === row.taskId && event.completedAt > rowCursor);

        let newCount = row.recurrenceCount;
        if (newCompletions.length > 0) {
            const maxCompletedAt = newCompletions.reduce((max, e) => (e.completedAt > max ? e.completedAt : max), newCompletions[0].completedAt);
            newCount = row.recurrenceCount + newCompletions.length;
            // Commit to SQLite first (the durable source of truth), then
            // resync the label - never the reverse (section 6 idempotency).
            updateCount(db, row.taskId, newCount, maxCompletedAt, now);
            completionsRecorded += newCompletions.length;
            metrics.completionsRecordedTotal.inc(newCompletions.length);
            logger.info(
                `${shortIdTag(row.shortId)}: +${newCompletions.length} completion${newCompletions.length === 1 ? '' : 's'} (task ${row.taskId}), count ${row.recurrenceCount} -> ${newCount}`,
            );
        } else {
            logger.debug(`tracking check: ${shortIdTag(row.shortId)} (task ${row.taskId}) still tracked, no new completions`);
        }

        // Unconditional every cycle, even with no new completions - this is
        // what makes a crash between the SQLite commit above and this call
        // self-healing on the very next cycle instead of needing a retry path.
        const newName = counterLabelName(row.shortId, newCount);
        try {
            await todoist.renameLabel(labelId, newName);
        } catch (err) {
            logger.warn(`label rename failed for ${shortIdTag(row.shortId)} (task ${row.taskId}): ${errMessage(err)}, will retry next cycle`);
        }
    }

    return { completionsRecorded, pruned };
}
