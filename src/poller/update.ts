import type { DatabaseSync } from 'node:sqlite';
import { deleteRowByTaskId, getTrackedRows, updateCount } from '../db';
import { counterLabelName, counterLabelPattern, shortIdTag } from '../label-name';
import type { Logger } from '../logger';
import type { Metrics } from '../metrics';
import type { TodoistClient } from '../todoist';

export type UpdateResult = {
    completionsRecorded: number;
    pruned: number;
};

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Phase B (design doc section 3): for every tracked row, check whether the
 * task is still tracked, then either prune it or record new completions.
 *
 * Each row is handled independently and a Todoist-call failure here is
 * logged at WARN and skipped for this cycle rather than propagated - a bad
 * or failed lookup should only ever cost the one task it's checking
 * (section 6), never abort the whole cycle.
 */
export async function runUpdatePhase(db: DatabaseSync, todoist: TodoistClient, logger: Logger, metrics: Metrics, now: Date): Promise<UpdateResult> {
    const rows = getTrackedRows(db);
    let completionsRecorded = 0;
    let pruned = 0;

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

        let newCompletions: Date[];
        try {
            newCompletions = await todoist.getNewCompletions(actualLabelName, row.lastCompletionAt);
        } catch (err) {
            logger.warn(`completion check failed for ${shortIdTag(row.shortId)} (task ${row.taskId}): ${errMessage(err)}, skipping this cycle`);
            continue;
        }

        let newCount = row.recurrenceCount;
        if (newCompletions.length > 0) {
            const maxCompletedAt = newCompletions.reduce((max, d) => (d > max ? d : max), newCompletions[0]);
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
