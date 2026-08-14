import { TodoistRequestError, type Label, type Task, type TodoistApi } from '@doist/todoist-sdk';
import { instrumentTodoistCall, type Metrics } from './metrics';

/**
 * Structural subset of TodoistApi this module actually calls - lets tests
 * pass a fake object instead of a real SDK client.
 */
export type TodoistApiLike = Pick<
    TodoistApi,
    'getTasksByFilter' | 'addLabel' | 'updateTask' | 'getTask' | 'getCompletedTasksByCompletionDate' | 'updateLabel' | 'deleteLabel'
>;

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
     * Completions of the task carrying `counterLabelName` since `sinceIso`.
     * Filters GET /tasks/completed/by_completion_date by that label - since
     * counter labels are unique per task (design doc section 2), this scopes
     * the query to exactly one task's completions.
     */
    getNewCompletions(counterLabelName: string, sinceIso: string): Promise<Date[]>;
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

    async function getNewCompletions(counterLabelName: string, sinceIso: string): Promise<Date[]> {
        const untilIso = new Date().toISOString();
        const completedAts: Date[] = [];
        let cursor: string | null | undefined;
        do {
            const page = await instrumentTodoistCall(metrics, 'tasks_completed_by_completion_date', () =>
                api.getCompletedTasksByCompletionDate({
                    since: sinceIso,
                    until: untilIso,
                    filterQuery: `@${counterLabelName}`,
                    cursor,
                }),
            );
            for (const item of page.items) {
                if (item.completedAt) completedAts.push(item.completedAt);
            }
            cursor = page.nextCursor;
        } while (cursor);
        return completedAts;
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

    return { findTasksByLabel, createLabel, replaceTaskLabels, getTask, getNewCompletions, renameLabel, deleteLabel };
}
