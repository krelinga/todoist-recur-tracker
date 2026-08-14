import type { DatabaseSync } from 'node:sqlite';
import { getRowByTaskId, insertTrackedTask, setLabelId } from '../db';
import { counterLabelName, shortIdTag } from '../label-name';
import type { Logger } from '../logger';
import type { Metrics } from '../metrics';
import type { TodoistClient } from '../todoist';

export type OnboardResult = {
    onboarded: number;
};

/**
 * Phase A (design doc section 3): find starter-labeled tasks, insert the
 * state-store row first (assigns short_id), create/attach the counter
 * label, then remove the starter label last. A row whose label_id is still
 * null is "resume onboarding, not a tracked task" (section 6) - this always
 * happens naturally here because the starter label is only ever removed as
 * the final step, so an interrupted task is still findable by this same
 * @<starterLabel> filter query on the next cycle.
 */
export async function runOnboardPhase(
    db: DatabaseSync,
    todoist: TodoistClient,
    logger: Logger,
    metrics: Metrics,
    starterLabel: string,
    now: Date,
): Promise<OnboardResult> {
    const tasks = await todoist.findTasksByLabel(starterLabel);
    let onboarded = 0;

    for (const task of tasks) {
        const existing = getRowByTaskId(db, task.id);

        if (existing && existing.labelId) {
            // Re-adding the starter label to an already-tracked task is a no-op,
            // not an error (section 6) - strip the redundant label and move on.
            logger.debug(`redundant starter label on already-tracked task ${task.id} (${shortIdTag(existing.shortId)}), stripping it`);
            await todoist.replaceTaskLabels(
                task.id,
                task.labels.filter((label) => label !== starterLabel),
            );
            continue;
        }

        const resumed = existing !== undefined;
        const row = existing ?? insertTrackedTask(db, task.id, now);

        const name = counterLabelName(row.shortId, row.recurrenceCount);
        const label = await todoist.createLabel(name);
        setLabelId(db, task.id, label.id, now);

        const newLabels = task.labels.filter((label) => label !== starterLabel && label !== name);
        newLabels.push(name);
        await todoist.replaceTaskLabels(task.id, newLabels);

        onboarded += 1;
        metrics.tasksOnboardedTotal.inc();
        if (resumed) {
            logger.info(`resumed interrupted onboarding: task ${task.id} -> ${name}`);
        } else {
            logger.info(`onboarded task ${task.id} -> ${name}`);
        }
    }

    return { onboarded };
}
