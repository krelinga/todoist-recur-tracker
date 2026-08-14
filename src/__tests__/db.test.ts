import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    countTrackedRows,
    dbFileSizeBytes,
    deleteRowByTaskId,
    getRowByTaskId,
    getTrackedRows,
    insertTrackedTask,
    openDb,
    setLabelId,
    updateCount,
} from '../db';

describe('db', () => {
    let db: ReturnType<typeof openDb>;

    beforeEach(() => {
        db = openDb(':memory:');
    });

    afterEach(() => {
        db.close();
    });

    it('assigns incrementing, never-reused short_ids', () => {
        const now = new Date('2026-08-14T00:00:00.000Z');
        const first = insertTrackedTask(db, 'task-1', now);
        const second = insertTrackedTask(db, 'task-2', now);
        expect(first.shortId).toBe(1);
        expect(second.shortId).toBe(2);

        deleteRowByTaskId(db, 'task-2');
        const third = insertTrackedTask(db, 'task-3', now);
        expect(third.shortId).toBe(3);
    });

    it('seeds last_completion_at to onboarding time, count 0, label_id null', () => {
        const now = new Date('2026-08-14T00:00:00.000Z');
        const row = insertTrackedTask(db, 'task-1', now);
        expect(row.labelId).toBeNull();
        expect(row.recurrenceCount).toBe(0);
        expect(row.lastCompletionAt).toBe(now.toISOString());
    });

    it('excludes rows without a label_id (incomplete onboarding) from getTrackedRows', () => {
        const now = new Date('2026-08-14T00:00:00.000Z');
        insertTrackedTask(db, 'task-1', now);
        const tracked = insertTrackedTask(db, 'task-2', now);
        setLabelId(db, tracked.taskId, 'label-abc', now);

        const rows = getTrackedRows(db);
        expect(rows).toHaveLength(1);
        expect(rows[0].taskId).toBe('task-2');
        expect(rows[0].labelId).toBe('label-abc');
        expect(countTrackedRows(db)).toBe(1);
    });

    it('commits count + cursor together via updateCount', () => {
        const now = new Date('2026-08-14T00:00:00.000Z');
        insertTrackedTask(db, 'task-1', now);
        const completedAt = new Date('2026-08-14T01:00:00.000Z');
        const later = new Date('2026-08-14T01:00:01.000Z');
        updateCount(db, 'task-1', 4, completedAt, later);

        const row = getRowByTaskId(db, 'task-1');
        expect(row?.recurrenceCount).toBe(4);
        expect(row?.lastCompletionAt).toBe(completedAt.toISOString());
        expect(row?.updatedAt).toBe(later.toISOString());
    });

    it('deletes rows by task_id', () => {
        const now = new Date('2026-08-14T00:00:00.000Z');
        insertTrackedTask(db, 'task-1', now);
        deleteRowByTaskId(db, 'task-1');
        expect(getRowByTaskId(db, 'task-1')).toBeUndefined();
    });

    it('rejects a duplicate task_id (re-adding the starter label is caught upstream via this constraint)', () => {
        const now = new Date('2026-08-14T00:00:00.000Z');
        insertTrackedTask(db, 'task-1', now);
        expect(() => insertTrackedTask(db, 'task-1', now)).toThrow();
    });
});

describe('openDb schema init', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recur-tracker-db-test-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('initializes schema only on a genuinely fresh file, and reopening an existing one preserves data', () => {
        const dbPath = path.join(dir, 'nested', 'tracked_tasks.db');
        const db1 = openDb(dbPath);
        insertTrackedTask(db1, 'task-1', new Date('2026-08-14T00:00:00.000Z'));
        db1.close();

        const db2 = openDb(dbPath);
        const row = getRowByTaskId(db2, 'task-1');
        expect(row?.taskId).toBe('task-1');
        db2.close();
    });

    it('reports the on-disk file size', () => {
        const dbPath = path.join(dir, 'tracked_tasks.db');
        expect(dbFileSizeBytes(dbPath)).toBe(0);
        const db1 = openDb(dbPath);
        db1.close();
        expect(dbFileSizeBytes(dbPath)).toBeGreaterThan(0);
    });
});
