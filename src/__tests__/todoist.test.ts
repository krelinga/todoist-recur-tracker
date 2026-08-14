import { TodoistRequestError } from '@doist/todoist-sdk';
import { describe, expect, it, vi } from 'vitest';
import { createMetrics } from '../metrics';
import { createTodoistClient, type TodoistApiLike } from '../todoist';

function fakeTask(overrides: Partial<{ id: string; labels: string[]; completedAt: Date | null }> = {}) {
    return {
        id: overrides.id ?? 'task-1',
        labels: overrides.labels ?? [],
        completedAt: overrides.completedAt ?? null,
    } as unknown as import('@doist/todoist-sdk').Task;
}

describe('createTodoistClient', () => {
    it('findTasksByLabel builds an @label filter and paginates until nextCursor is null', async () => {
        const getTasksByFilter = vi
            .fn()
            .mockResolvedValueOnce({ results: [fakeTask({ id: 'a' })], nextCursor: 'page2' })
            .mockResolvedValueOnce({ results: [fakeTask({ id: 'b' })], nextCursor: null });
        const api = { getTasksByFilter } as unknown as TodoistApiLike;
        const client = createTodoistClient(api, createMetrics());

        const tasks = await client.findTasksByLabel('track-recurrence');

        expect(tasks.map((t) => t.id)).toEqual(['a', 'b']);
        expect(getTasksByFilter).toHaveBeenNthCalledWith(1, { query: '@track-recurrence', cursor: undefined });
        expect(getTasksByFilter).toHaveBeenNthCalledWith(2, { query: '@track-recurrence', cursor: 'page2' });
    });

    it('createLabel calls addLabel with the given name', async () => {
        const addLabel = vi.fn().mockResolvedValue({ id: 'lbl-1', name: '🔁 x0 #1' });
        const api = { addLabel } as unknown as TodoistApiLike;
        const client = createTodoistClient(api, createMetrics());

        const label = await client.createLabel('🔁 x0 #1');

        expect(label).toEqual({ id: 'lbl-1', name: '🔁 x0 #1' });
        expect(addLabel).toHaveBeenCalledWith({ name: '🔁 x0 #1' });
    });

    it('replaceTaskLabels sends a full replacement labels array', async () => {
        const updateTask = vi.fn().mockResolvedValue(fakeTask());
        const api = { updateTask } as unknown as TodoistApiLike;
        const client = createTodoistClient(api, createMetrics());

        await client.replaceTaskLabels('task-1', ['🔁 x0 #1']);

        expect(updateTask).toHaveBeenCalledWith('task-1', { labels: ['🔁 x0 #1'] });
    });

    it('getTask resolves to null on a 404 instead of throwing', async () => {
        const getTask = vi.fn().mockRejectedValue(new TodoistRequestError('not found', 404));
        const api = { getTask } as unknown as TodoistApiLike;
        const client = createTodoistClient(api, createMetrics());

        await expect(client.getTask('gone')).resolves.toBeNull();
    });

    it('getTask rethrows non-404 errors', async () => {
        const getTask = vi.fn().mockRejectedValue(new TodoistRequestError('server error', 503));
        const api = { getTask } as unknown as TodoistApiLike;
        const client = createTodoistClient(api, createMetrics());

        await expect(client.getTask('task-1')).rejects.toThrow('server error');
    });

    it('getTask resolves to the task on success', async () => {
        const task = fakeTask({ id: 'task-1', labels: ['🔁 x2 #1'] });
        const getTask = vi.fn().mockResolvedValue(task);
        const api = { getTask } as unknown as TodoistApiLike;
        const client = createTodoistClient(api, createMetrics());

        await expect(client.getTask('task-1')).resolves.toBe(task);
    });

    it('getCompletionEventsSince fetches task:completed activity events from the date of sinceIso, paginating', async () => {
        const t1 = new Date('2026-08-14T01:00:00.000Z');
        const t2 = new Date('2026-08-14T02:00:00.000Z');
        const getActivityLogs = vi
            .fn()
            .mockResolvedValueOnce({ results: [{ objectId: 'task-a', eventDate: t1 }], nextCursor: 'p2' })
            .mockResolvedValueOnce({ results: [{ objectId: 'task-b', eventDate: t2 }], nextCursor: null });
        const api = { getActivityLogs } as unknown as TodoistApiLike;
        const client = createTodoistClient(api, createMetrics());

        const events = await client.getCompletionEventsSince('2026-08-14T00:30:00.000Z');

        expect(events).toEqual([
            { taskId: 'task-a', completedAt: t1 },
            { taskId: 'task-b', completedAt: t2 },
        ]);
        const firstCallArgs = getActivityLogs.mock.calls[0][0];
        expect(firstCallArgs).toMatchObject({
            objectEventTypes: 'task:completed',
            dateFrom: '2026-08-14',
            cursor: undefined,
        });
        expect(getActivityLogs.mock.calls[1][0].cursor).toBe('p2');
    });

    it('renameLabel updates the label name in place', async () => {
        const updateLabel = vi.fn().mockResolvedValue({ id: 'lbl-1', name: '🔁 x3 #1' });
        const api = { updateLabel } as unknown as TodoistApiLike;
        const client = createTodoistClient(api, createMetrics());

        await client.renameLabel('lbl-1', '🔁 x3 #1');

        expect(updateLabel).toHaveBeenCalledWith('lbl-1', { name: '🔁 x3 #1' });
    });

    it('deleteLabel succeeds silently on a 404 (already gone)', async () => {
        const deleteLabel = vi.fn().mockRejectedValue(new TodoistRequestError('not found', 404));
        const api = { deleteLabel } as unknown as TodoistApiLike;
        const client = createTodoistClient(api, createMetrics());

        await expect(client.deleteLabel('lbl-1')).resolves.toBeUndefined();
    });

    it('deleteLabel rethrows non-404 errors', async () => {
        const deleteLabel = vi.fn().mockRejectedValue(new TodoistRequestError('server error', 500));
        const api = { deleteLabel } as unknown as TodoistApiLike;
        const client = createTodoistClient(api, createMetrics());

        await expect(client.deleteLabel('lbl-1')).rejects.toThrow('server error');
    });

    it('records todoist_requests_total with outcome=success for an expected 404 (not an API health error)', async () => {
        const metrics = createMetrics();
        const getTask = vi.fn().mockRejectedValue(new TodoistRequestError('not found', 404));
        const api = { getTask } as unknown as TodoistApiLike;
        const client = createTodoistClient(api, metrics);

        await client.getTask('gone');

        const text = await metrics.register.metrics();
        expect(text).toContain('recurrence_tracker_todoist_requests_total{endpoint="tasks_get",outcome="success"} 1');
    });
});
