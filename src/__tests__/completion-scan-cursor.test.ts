import { describe, expect, it } from 'vitest';
import { createCompletionScanCursor } from '../poller/completion-scan-cursor';

describe('createCompletionScanCursor', () => {
    it('starts null before any successful fetch', () => {
        const cursor = createCompletionScanCursor();
        expect(cursor.get()).toBeNull();
    });

    it('records and returns the last successful fetch time', () => {
        const cursor = createCompletionScanCursor();
        const t = new Date('2026-08-14T12:00:00.000Z');
        cursor.recordSuccess(t);
        expect(cursor.get()).toBe(t);
    });

    it('a later recordSuccess overwrites the previous value', () => {
        const cursor = createCompletionScanCursor();
        cursor.recordSuccess(new Date('2026-08-14T12:00:00.000Z'));
        const t2 = new Date('2026-08-14T13:00:00.000Z');
        cursor.recordSuccess(t2);
        expect(cursor.get()).toBe(t2);
    });

    it('two independent cursors do not share state', () => {
        const a = createCompletionScanCursor();
        const b = createCompletionScanCursor();
        a.recordSuccess(new Date('2026-08-14T12:00:00.000Z'));
        expect(b.get()).toBeNull();
    });
});
