import { TodoistRequestError, type Label, type Task, type TodoistApi } from '@doist/todoist-sdk';
import { instrumentTodoistCall, type Metrics } from './metrics';

/**
 * Structural subset of TodoistApi this module actually calls - lets tests
 * pass a fake object instead of a real SDK client.
 */
export type TodoistApiLike = Pick<TodoistApi, 'getTasksByFilter' | 'addLabel' | 'updateTask' | 'getTask' | 'getActivityLogs' | 'updateLabel' | 'deleteLabel'>;

export type CompletionEvent = {
    taskId: string;
    completedAt: Date;
};

export type TodoistClient = {
    /** GET /tasks?filter=@<label>, per design doc section 5. Paginates to completion. */
    findTasksByLabel(label: string): Promise<Task[]>;
    /** POST /labels - idempotent: an existing name returns the existing label (design doc section 2). */
    createLabel(name: string): Promise<Label>;
    /** POST /tasks/{id} with a full replacement labels array (design doc section 5). */
    replaceTaskLabels(taskId: string, labels: string[]): Promise<void>;
    /** GET /tasks/{id}; resolves to null on 404 rather than throwing. */
    getTask(taskId: string): Promise<Task | null>;
    /**
     * Every task-completed event across the whole account since `sinceIso`
     * (date-granularity server-side; callers must re-filter to exact
     * timestamps per task).
     *
     * This deliberately does NOT use GET /tasks/completed/by_completion_date
     * as design doc section 5 originally specified. Live testing against a
     * real Todoist instance found that endpoint (and by_due_date) never
     * returns completions of *recurring* tasks at all - only genuine
     * one-time completions - which is exactly the case this tool exists to
     * track. The activity log's `completed` events do capture recurring
     * completions, but its documented `objectId` filter is silently ignored
     * server-side (confirmed with a raw request bypassing the SDK), so
     * filtering to one task has to happen client-side instead. Because of
     * that, this fetches once per poll cycle for every tracked row rather
     * than per-task - see runUpdatePhase in poller/update.ts.
     */
    getCompletionEventsSince(sinceIso: string): Promise<CompletionEvent[]>;
    /** POST /labels/{id} to rename in place. */
    renameLabel(labelId: string, newName: string): Promise<void>;
    /** DELETE /labels/{id}; a 404 is treated as success (already gone). */
    deleteLabel(labelId: string): Promise<void>;
};

function isNotFound(err: unknown): boolean {
    return err instanceof TodoistRequestError && err.httpStatusCode === 404;
}

export function createTodoistClient(api: TodoistApiLike, metrics: Metrics): TodoistClient {
    async function findTasksByLabel(label: string): Promise<Task[]> {
        const all: Task[] = [];
        let cursor: string | null | undefined;
        do {
            const page = await instrumentTodoistCall(metrics, 'tasks_filter', () =>
                api.getTasksByFilter({ query: `@${label}`, cursor }),
            );
            all.push(...page.results);
            cursor = page.nextCursor;
        } while (cursor);
        return all;
    }

    async function createLabel(name: string): Promise<Label> {
        return instrumentTodoistCall(metrics, 'labels_create', () => api.addLabel({ name }));
    }

    async function replaceTaskLabels(taskId: string, labels: string[]): Promise<void> {
        await instrumentTodoistCall(metrics, 'tasks_update', () => api.updateTask(taskId, { labels }));
    }

    async function getTask(taskId: string): Promise<Task | null> {
        return instrumentTodoistCall(metrics, 'tasks_get', async () => {
            try {
                return await api.getTask(taskId);
            } catch (err) {
                if (isNotFound(err)) return null;
                throw err;
            }
        });
    }

    async function getCompletionEventsSince(sinceIso: string): Promise<CompletionEvent[]> {
        const dateFrom = sinceIso.slice(0, 10); // activity log date filters are date-granularity only
        const events: CompletionEvent[] = [];
        let cursor: string | null | undefined;
        do {
            const page = await instrumentTodoistCall(metrics, 'activity_logs', () =>
                api.getActivityLogs({ objectEventTypes: 'task:completed', dateFrom, cursor }),
            );
            for (const event of page.results) {
                events.push({ taskId: event.objectId, completedAt: event.eventDate });
            }
            cursor = page.nextCursor;
        } while (cursor);
        return events;
    }

    async function renameLabel(labelId: string, newName: string): Promise<void> {
        await instrumentTodoistCall(metrics, 'labels_update', () => api.updateLabel(labelId, { name: newName }));
    }

    async function deleteLabel(labelId: string): Promise<void> {
        await instrumentTodoistCall(metrics, 'labels_delete', async () => {
            try {
                await api.deleteLabel(labelId);
            } catch (err) {
                if (isNotFound(err)) return;
                throw err;
            }
        });
    }

    return { findTasksByLabel, createLabel, replaceTaskLabels, getTask, getCompletionEventsSince, renameLabel, deleteLabel };
}
