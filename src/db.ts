import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type TrackedTaskRow = {
    shortId: number;
    taskId: string;
    labelId: string | null;
    recurrenceCount: number;
    lastCompletionAt: string;
    createdAt: string;
    updatedAt: string;
};

type SqliteRow = {
    short_id: number;
    task_id: string;
    label_id: string | null;
    recurrence_count: number;
    last_completion_at: string;
    created_at: string;
    updated_at: string;
};

function fromSqliteRow(row: SqliteRow): TrackedTaskRow {
    return {
        shortId: row.short_id,
        taskId: row.task_id,
        labelId: row.label_id,
        recurrenceCount: row.recurrence_count,
        lastCompletionAt: row.last_completion_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

const SCHEMA = `
CREATE TABLE tracked_tasks (
    short_id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id             TEXT UNIQUE NOT NULL,
    label_id            TEXT,
    recurrence_count    INTEGER NOT NULL DEFAULT 0,
    last_completion_at  TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);
`;

/**
 * Opens the state store, creating the schema only if this is a genuinely
 * fresh volume (design doc section 1) - existence is checked before the
 * DatabaseSync constructor itself creates the file.
 */
export function openDb(dbPath: string): DatabaseSync {
    const isFresh = !fs.existsSync(dbPath);
    if (isFresh) {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const db = new DatabaseSync(dbPath);
    if (isFresh) {
        db.exec(SCHEMA);
    }
    return db;
}

export function insertTrackedTask(db: DatabaseSync, taskId: string, now: Date): TrackedTaskRow {
    const nowIso = now.toISOString();
    const stmt = db.prepare(
        `INSERT INTO tracked_tasks (task_id, label_id, recurrence_count, last_completion_at, created_at, updated_at)
         VALUES (?, NULL, 0, ?, ?, ?)`,
    );
    stmt.run(taskId, nowIso, nowIso, nowIso);
    const row = getRowByTaskId(db, taskId);
    if (!row) {
        throw new Error(`insertTrackedTask: row for task ${taskId} vanished immediately after insert`);
    }
    return row;
}

export function getRowByTaskId(db: DatabaseSync, taskId: string): TrackedTaskRow | undefined {
    const row = db.prepare('SELECT * FROM tracked_tasks WHERE task_id = ?').get(taskId) as SqliteRow | undefined;
    return row ? fromSqliteRow(row) : undefined;
}

export function setLabelId(db: DatabaseSync, taskId: string, labelId: string, now: Date): void {
    db.prepare('UPDATE tracked_tasks SET label_id = ?, updated_at = ? WHERE task_id = ?').run(
        labelId,
        now.toISOString(),
        taskId,
    );
}

/** Rows that have completed onboarding - i.e. have a counter label attached. */
export function getTrackedRows(db: DatabaseSync): TrackedTaskRow[] {
    const rows = db.prepare('SELECT * FROM tracked_tasks WHERE label_id IS NOT NULL').all() as SqliteRow[];
    return rows.map(fromSqliteRow);
}

export function updateCount(db: DatabaseSync, taskId: string, recurrenceCount: number, lastCompletionAt: Date, now: Date): void {
    db.prepare(
        'UPDATE tracked_tasks SET recurrence_count = ?, last_completion_at = ?, updated_at = ? WHERE task_id = ?',
    ).run(recurrenceCount, lastCompletionAt.toISOString(), now.toISOString(), taskId);
}

export function deleteRowByTaskId(db: DatabaseSync, taskId: string): void {
    db.prepare('DELETE FROM tracked_tasks WHERE task_id = ?').run(taskId);
}

export function countTrackedRows(db: DatabaseSync): number {
    const row = db.prepare('SELECT COUNT(*) AS n FROM tracked_tasks WHERE label_id IS NOT NULL').get() as { n: number };
    return row.n;
}

export function dbFileSizeBytes(dbPath: string): number {
    try {
        return fs.statSync(dbPath).size;
    } catch {
        return 0;
    }
}
