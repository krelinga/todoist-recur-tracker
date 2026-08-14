import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertTrackedTask, openDb, setLabelId } from '../db';
import { createMetrics } from '../metrics';
import { runPollCycle } from '../poller/cycle';
import type { TodoistClient } from '../todoist';

function fakeTodoist(overrides: Partial<TodoistClient> = {}): TodoistClient {
    return {
        findTasksByLabel: vi.fn().mockResolvedValue([]),
        createLabel: vi.fn(),
        replaceTaskLabels: vi.fn(),
        getTask: vi.fn(),
        getNewCompletions: vi.fn().mockResolvedValue([]),
        renameLabel: vi.fn().mockResolvedValue(undefined),
        deleteLabel: vi.fn(),
        ...overrides,
    } as unknown as TodoistClient;
}

function fakeLogger() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const STARTER_LABEL = 'track-recurrence';

describe('runPollCycle', () => {
    let db: DatabaseSync;

    beforeEach(() => {
        db = openDb(':memory:');
    });

    afterEach(() => {
        db.close();
    });

    it('on success: records last_successful_poll timestamp, sets gauges, logs one INFO heartbeat', async () => {
        const row = insertTrackedTask(db, 'task-1', new Date('2026-08-01T00:00:00.000Z'));
        setLabelId(db, 'task-1', 'lbl-1', new Date('2026-08-01T00:00:00.000Z'));
        const todoist = fakeTodoist({
            getTask: vi.fn().mockResolvedValue({ id: 'task-1', labels: [`🔁 x0 #${row.shortId}`] }),
        });
        const metrics = createMetrics();
        const logger = fakeLogger();

        await runPollCycle(db, todoist, logger, metrics, STARTER_LABEL, ':memory:');

        expect(logger.error).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('poll cycle complete in'));
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('1 tracked, 0 onboarded, 0 completions recorded, 0 pruned'));

        const text = await metrics.register.metrics();
        expect(text).toContain('recurrence_tracker_poll_cycles_total{result="success"} 1');
        expect(text).toContain('recurrence_tracker_tracked_tasks 1');
        expect(text).toMatch(/recurrence_tracker_last_successful_poll_timestamp_seconds \d/);
    });

    it('on an unhandled failure: abandons the cycle, logs ERROR, does not set the success timestamp', async () => {
        const todoist = fakeTodoist({
            findTasksByLabel: vi.fn().mockRejectedValue(new Error('401 Unauthorized from Todoist')),
        });
        const metrics = createMetrics();
        const logger = fakeLogger();

        await runPollCycle(db, todoist, logger, metrics, STARTER_LABEL, ':memory:');

        expect(logger.error).toHaveBeenCalledWith('poll cycle failed: 401 Unauthorized from Todoist');
        expect(logger.info).not.toHaveBeenCalled();

        const text = await metrics.register.metrics();
        expect(text).toContain('recurrence_tracker_poll_cycles_total{result="error"} 1');
        expect(text).toMatch(/recurrence_tracker_last_successful_poll_timestamp_seconds 0/);
    });
});
