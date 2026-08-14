import type { DatabaseSync } from 'node:sqlite';
import { countTrackedRows, dbFileSizeBytes } from '../db';
import type { Logger } from '../logger';
import type { Metrics } from '../metrics';
import type { TodoistClient } from '../todoist';
import { runOnboardPhase } from './onboard';
import { runUpdatePhase } from './update';

/**
 * Runs one full poll cycle (Phase A + Phase B) and records its outcome.
 *
 * Design doc section 9: an unhandled exception here ends the cycle early -
 * it's abandoned rather than partially applied, and the next scheduled
 * cycle just tries again. Success updates last_successful_poll_timestamp_seconds
 * (the key alerting metric) and logs one INFO summary line as a heartbeat.
 */
export async function runPollCycle(
    db: DatabaseSync,
    todoist: TodoistClient,
    logger: Logger,
    metrics: Metrics,
    starterLabel: string,
    dbPath: string,
): Promise<void> {
    const stopTimer = metrics.pollDurationSeconds.startTimer();
    const start = Date.now();
    try {
        const now = new Date();
        const { onboarded } = await runOnboardPhase(db, todoist, logger, metrics, starterLabel, now);
        const { completionsRecorded, pruned } = await runUpdatePhase(db, todoist, logger, metrics, now);

        const tracked = countTrackedRows(db);
        metrics.trackedTasks.set(tracked);
        metrics.stateDbSizeBytes.set(dbFileSizeBytes(dbPath));
        metrics.lastSuccessfulPollTimestampSeconds.set(Date.now() / 1000);
        metrics.pollCyclesTotal.inc({ result: 'success' });

        const durationSeconds = (Date.now() - start) / 1000;
        logger.info(
            `poll cycle complete in ${durationSeconds.toFixed(1)}s: ${tracked} tracked, ${onboarded} onboarded, ${completionsRecorded} completions recorded, ${pruned} pruned`,
        );
    } catch (err) {
        metrics.pollCyclesTotal.inc({ result: 'error' });
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`poll cycle failed: ${message}`);
    } finally {
        stopTimer();
    }
}
