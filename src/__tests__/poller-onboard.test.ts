import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRowByTaskId, openDb } from '../db';
import { createMetrics } from '../metrics';
import { runOnboardPhase } from '../poller/onboard';
import type { TodoistClient } from '../todoist';

type FakeTask = { id: string; labels: string[] };

function fakeTodoist(overrides: Partial<TodoistClient> = {}): TodoistClient {
    let labelCounter = 0;
    return {
        findTasksByLabel: vi.fn(),
        createLabel: vi.fn(async (name: string) => ({ id: `lbl-${++labelCounter}`, name, order: null, color: 'charcoal', isFavorite: false })),
        replaceTaskLabels: vi.fn(async () => {}),
        getTask: vi.fn(),
        getNewCompletions: vi.fn(),
        renameLabel: vi.fn(),
        deleteLabel: vi.fn(),
        ...overrides,
    } as unknown as TodoistClient;
}

function fakeLogger() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const STARTER_LABEL = 'track-recurrence';
const NOW = new Date('2026-08-14T00:00:00.000Z');

describe('runOnboardPhase', () => {
    let db: DatabaseSync;

    beforeEach(() => {
        db = openDb(':memory:');
    });

    afterEach(() => {
        db.close();
    });

    it('onboards a fresh task: row inserted, counter label created+attached, starter label removed', async () => {
        const task: FakeTask = { id: 'task-1', labels: [STARTER_LABEL, 'other-label'] };
        const todoist = fakeTodoist({ findTasksByLabel: vi.fn().mockResolvedValue([task]) });
        const metrics = createMetrics();
        const logger = fakeLogger();

        const result = await runOnboardPhase(db, todoist, logger, metrics, STARTER_LABEL, NOW);

        expect(result.onboarded).toBe(1);
        const row = getRowByTaskId(db, 'task-1');
        expect(row?.labelId).toBe('lbl-1');
        expect(row?.recurrenceCount).toBe(0);
        expect(todoist.createLabel).toHaveBeenCalledWith('🔁 x0 #1');
        expect(todoist.replaceTaskLabels).toHaveBeenCalledWith('task-1', ['other-label', '🔁 x0 #1']);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('onboarded task task-1 -> 🔁 x0 #1'));

        const metricsText = await metrics.register.metrics();
        expect(metricsText).toContain('recurrence_tracker_tasks_onboarded_total 1');
    });

    it('treats a redundant starter label on an already-tracked task as a no-op: strips it, does not re-create or recount', async () => {
        const task: FakeTask = { id: 'task-1', labels: [STARTER_LABEL, '🔁 x3 #1'] };
        const todoist = fakeTodoist({ findTasksByLabel: vi.fn().mockResolvedValue([task]) });
        const metrics = createMetrics();
        const logger = fakeLogger();

        // Simulate a task that's already fully tracked at count 3.
        const { insertTrackedTask, setLabelId, updateCount } = await import('../db');
        insertTrackedTask(db, 'task-1', NOW);
        setLabelId(db, 'task-1', 'lbl-existing', NOW);
        updateCount(db, 'task-1', 3, NOW, NOW);

        const result = await runOnboardPhase(db, todoist, logger, metrics, STARTER_LABEL, NOW);

        expect(result.onboarded).toBe(0);
        expect(todoist.createLabel).not.toHaveBeenCalled();
        expect(todoist.replaceTaskLabels).toHaveBeenCalledWith('task-1', ['🔁 x3 #1']);
        expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('redundant starter label'));

        const row = getRowByTaskId(db, 'task-1');
        expect(row?.recurrenceCount).toBe(3);
        expect(row?.labelId).toBe('lbl-existing');
    });

    it('resumes an interrupted onboarding: row exists with label_id null', async () => {
        const task: FakeTask = { id: 'task-1', labels: [STARTER_LABEL] };
        const todoist = fakeTodoist({ findTasksByLabel: vi.fn().mockResolvedValue([task]) });
        const metrics = createMetrics();
        const logger = fakeLogger();

        const { insertTrackedTask } = await import('../db');
        const preExisting = insertTrackedTask(db, 'task-1', NOW);
        expect(preExisting.labelId).toBeNull();

        const result = await runOnboardPhase(db, todoist, logger, metrics, STARTER_LABEL, NOW);

        expect(result.onboarded).toBe(1);
        expect(todoist.createLabel).toHaveBeenCalledWith('🔁 x0 #1');
        const row = getRowByTaskId(db, 'task-1');
        expect(row?.labelId).toBe('lbl-1');
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('resumed interrupted onboarding'));
    });

    it('onboards multiple tasks independently, assigning increasing short_ids', async () => {
        const tasks: FakeTask[] = [
            { id: 'task-1', labels: [STARTER_LABEL] },
            { id: 'task-2', labels: [STARTER_LABEL] },
        ];
        const todoist = fakeTodoist({ findTasksByLabel: vi.fn().mockResolvedValue(tasks) });
        const metrics = createMetrics();
        const logger = fakeLogger();

        const result = await runOnboardPhase(db, todoist, logger, metrics, STARTER_LABEL, NOW);

        expect(result.onboarded).toBe(2);
        expect(getRowByTaskId(db, 'task-1')?.shortId).toBe(1);
        expect(getRowByTaskId(db, 'task-2')?.shortId).toBe(2);
        expect(todoist.createLabel).toHaveBeenCalledWith('🔁 x0 #1');
        expect(todoist.createLabel).toHaveBeenCalledWith('🔁 x0 #2');
    });
});
