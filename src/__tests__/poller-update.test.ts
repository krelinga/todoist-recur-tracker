import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRowByTaskId, insertTrackedTask, openDb, setLabelId, updateCount } from '../db';
import { createMetrics } from '../metrics';
import { runUpdatePhase } from '../poller/update';
import type { TodoistClient } from '../todoist';

function fakeTodoist(overrides: Partial<TodoistClient> = {}): TodoistClient {
    return {
        findTasksByLabel: vi.fn(),
        createLabel: vi.fn(),
        replaceTaskLabels: vi.fn(),
        getTask: vi.fn(),
        getNewCompletions: vi.fn().mockResolvedValue([]),
        renameLabel: vi.fn().mockResolvedValue(undefined),
        deleteLabel: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    } as unknown as TodoistClient;
}

function fakeLogger() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fakeTask(labels: string[]) {
    return { id: 'task-1', labels } as unknown as import('@doist/todoist-sdk').Task;
}

const NOW = new Date('2026-08-14T05:00:00.000Z');

describe('runUpdatePhase', () => {
    let db: DatabaseSync;

    beforeEach(() => {
        db = openDb(':memory:');
        const row = insertTrackedTask(db, 'task-1', new Date('2026-08-01T00:00:00.000Z'));
        setLabelId(db, 'task-1', 'lbl-1', new Date('2026-08-01T00:00:00.000Z'));
        updateCount(db, 'task-1', 3, new Date('2026-08-01T00:00:00.000Z'), new Date('2026-08-01T00:00:00.000Z'));
        expect(row.shortId).toBe(1);
    });

    afterEach(() => {
        db.close();
    });

    it('still tracked, no new completions: renames unconditionally (self-heal) and logs nothing at INFO', async () => {
        const todoist = fakeTodoist({
            getTask: vi.fn().mockResolvedValue(fakeTask(['🔁 x3 #1'])),
            getNewCompletions: vi.fn().mockResolvedValue([]),
        });
        const metrics = createMetrics();
        const logger = fakeLogger();

        const result = await runUpdatePhase(db, todoist, logger, metrics, NOW);

        expect(result).toEqual({ completionsRecorded: 0, pruned: 0 });
        expect(todoist.renameLabel).toHaveBeenCalledWith('lbl-1', '🔁 x3 #1');
        expect(logger.info).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('still tracked, no new completions'));
    });

    it('records new completions: commits count+cursor to SQLite before renaming the label', async () => {
        const c1 = new Date('2026-08-14T01:00:00.000Z');
        const c2 = new Date('2026-08-14T02:00:00.000Z');
        const todoist = fakeTodoist({
            getTask: vi.fn().mockResolvedValue(fakeTask(['🔁 x3 #1'])),
            getNewCompletions: vi.fn().mockResolvedValue([c1, c2]),
            renameLabel: vi.fn(async () => {
                // By the time rename is called, the SQLite commit must already be visible.
                expect(getRowByTaskId(db, 'task-1')?.recurrenceCount).toBe(5);
            }),
        });
        const metrics = createMetrics();
        const logger = fakeLogger();

        const result = await runUpdatePhase(db, todoist, logger, metrics, NOW);

        expect(result).toEqual({ completionsRecorded: 2, pruned: 0 });
        expect(todoist.renameLabel).toHaveBeenCalledWith('lbl-1', '🔁 x5 #1');
        const row = getRowByTaskId(db, 'task-1');
        expect(row?.recurrenceCount).toBe(5);
        expect(row?.lastCompletionAt).toBe(c2.toISOString());
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('+2 completions (task task-1), count 3 -> 5'));

        const metricsText = await metrics.register.metrics();
        expect(metricsText).toContain('recurrence_tracker_completions_recorded_total 2');
    });

    it('prunes when the task is gone (404): deletes the label first, then the row', async () => {
        const todoist = fakeTodoist({
            getTask: vi.fn().mockResolvedValue(null),
            deleteLabel: vi.fn(async () => {
                // By the time the label delete is called, the row must still exist.
                expect(getRowByTaskId(db, 'task-1')).toBeDefined();
            }),
        });
        const metrics = createMetrics();
        const logger = fakeLogger();

        const result = await runUpdatePhase(db, todoist, logger, metrics, NOW);

        expect(result).toEqual({ completionsRecorded: 0, pruned: 1 });
        expect(todoist.deleteLabel).toHaveBeenCalledWith('lbl-1');
        expect(getRowByTaskId(db, 'task-1')).toBeUndefined();
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('pruned 🔁 #1 (task task-1): no longer tracked, final count 3'));

        const metricsText = await metrics.register.metrics();
        expect(metricsText).toContain('recurrence_tracker_tasks_pruned_total 1');
    });

    it('prunes when the task exists but no longer carries the counter label (manually removed)', async () => {
        const todoist = fakeTodoist({
            getTask: vi.fn().mockResolvedValue(fakeTask(['some-other-label'])),
        });
        const metrics = createMetrics();
        const logger = fakeLogger();

        const result = await runUpdatePhase(db, todoist, logger, metrics, NOW);

        expect(result.pruned).toBe(1);
        expect(todoist.deleteLabel).toHaveBeenCalledWith('lbl-1');
        expect(getRowByTaskId(db, 'task-1')).toBeUndefined();
    });

    it('does NOT false-prune when the live label still shows a stale count (rename crashed last cycle)', async () => {
        // SQLite says count 3, but the label on Todoist is still showing the
        // pre-crash count 2 - matching must be by shortId pattern, not exact name.
        const todoist = fakeTodoist({
            getTask: vi.fn().mockResolvedValue(fakeTask(['🔁 x2 #1'])),
            getNewCompletions: vi.fn().mockResolvedValue([]),
        });
        const metrics = createMetrics();
        const logger = fakeLogger();

        const result = await runUpdatePhase(db, todoist, logger, metrics, NOW);

        expect(result.pruned).toBe(0);
        expect(getRowByTaskId(db, 'task-1')).toBeDefined();
        // Self-heals: resyncs the label to the current (correct) count.
        expect(todoist.renameLabel).toHaveBeenCalledWith('lbl-1', '🔁 x3 #1');
        expect(todoist.getNewCompletions).toHaveBeenCalledWith('🔁 x2 #1', expect.any(String));
    });

    it('treats a failed tracking-check lookup as retry-next-cycle, not evidence the task is gone', async () => {
        const todoist = fakeTodoist({
            getTask: vi.fn().mockRejectedValue(new Error('503 from Todoist')),
        });
        const metrics = createMetrics();
        const logger = fakeLogger();

        const result = await runUpdatePhase(db, todoist, logger, metrics, NOW);

        expect(result).toEqual({ completionsRecorded: 0, pruned: 0 });
        expect(todoist.deleteLabel).not.toHaveBeenCalled();
        expect(getRowByTaskId(db, 'task-1')).toBeDefined();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('tracking check failed'));
    });

    it('keeps the row when the label delete fails, so the delete is retried next cycle', async () => {
        const todoist = fakeTodoist({
            getTask: vi.fn().mockResolvedValue(null),
            deleteLabel: vi.fn().mockRejectedValue(new Error('network error')),
        });
        const metrics = createMetrics();
        const logger = fakeLogger();

        const result = await runUpdatePhase(db, todoist, logger, metrics, NOW);

        expect(result.pruned).toBe(0);
        expect(getRowByTaskId(db, 'task-1')).toBeDefined();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('prune failed'));
    });

    it('logs a warning and moves on when the completion fetch fails', async () => {
        const todoist = fakeTodoist({
            getTask: vi.fn().mockResolvedValue(fakeTask(['🔁 x3 #1'])),
            getNewCompletions: vi.fn().mockRejectedValue(new Error('network error')),
        });
        const metrics = createMetrics();
        const logger = fakeLogger();

        const result = await runUpdatePhase(db, todoist, logger, metrics, NOW);

        expect(result).toEqual({ completionsRecorded: 0, pruned: 0 });
        expect(todoist.renameLabel).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('completion check failed'));
        expect(getRowByTaskId(db, 'task-1')?.recurrenceCount).toBe(3);
    });

    it('logs a warning when the rename fails, but the count commit already happened', async () => {
        const todoist = fakeTodoist({
            getTask: vi.fn().mockResolvedValue(fakeTask(['🔁 x3 #1'])),
            getNewCompletions: vi.fn().mockResolvedValue([new Date('2026-08-14T01:00:00.000Z')]),
            renameLabel: vi.fn().mockRejectedValue(new Error('network error')),
        });
        const metrics = createMetrics();
        const logger = fakeLogger();

        const result = await runUpdatePhase(db, todoist, logger, metrics, NOW);

        expect(result.completionsRecorded).toBe(1);
        expect(getRowByTaskId(db, 'task-1')?.recurrenceCount).toBe(4);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('label rename failed'));
    });
});
