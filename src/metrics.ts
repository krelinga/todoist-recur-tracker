import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Fixed set of Todoist endpoint labels used on the todoist_requests_total /
 * todoist_request_duration_seconds metrics. Deliberately never task_id or
 * short_id - see design doc section 8 on cardinality.
 */
export type TodoistEndpoint =
    | 'tasks_get'
    | 'tasks_filter'
    | 'tasks_update'
    | 'activity_logs'
    | 'labels_create'
    | 'labels_update'
    | 'labels_delete';

export function createMetrics() {
    const register = new Registry();
    collectDefaultMetrics({ register });

    const lastSuccessfulPollTimestampSeconds = new Gauge({
        name: 'recurrence_tracker_last_successful_poll_timestamp_seconds',
        help: 'Unix timestamp of the last poll cycle that completed without error.',
        registers: [register],
    });
    const pollCyclesTotal = new Counter({
        name: 'recurrence_tracker_poll_cycles_total',
        help: 'Count of poll cycles, by outcome.',
        labelNames: ['result'] as const,
        registers: [register],
    });
    const pollDurationSeconds = new Histogram({
        name: 'recurrence_tracker_poll_duration_seconds',
        help: 'Duration of a full poll cycle (Phase A + Phase B).',
        registers: [register],
    });
    const trackedTasks = new Gauge({
        name: 'recurrence_tracker_tracked_tasks',
        help: 'Current number of rows in the state store.',
        registers: [register],
    });
    const tasksOnboardedTotal = new Counter({
        name: 'recurrence_tracker_tasks_onboarded_total',
        help: 'Cumulative count of tasks that have entered tracking.',
        registers: [register],
    });
    const tasksPrunedTotal = new Counter({
        name: 'recurrence_tracker_tasks_pruned_total',
        help: 'Cumulative count of tasks removed from tracking.',
        registers: [register],
    });
    const completionsRecordedTotal = new Counter({
        name: 'recurrence_tracker_completions_recorded_total',
        help: 'Cumulative individual completion events counted across every tracked task.',
        registers: [register],
    });
    const todoistRequestsTotal = new Counter({
        name: 'recurrence_tracker_todoist_requests_total',
        help: 'Todoist API request volume and error rate, by endpoint.',
        labelNames: ['endpoint', 'outcome'] as const,
        registers: [register],
    });
    const todoistRequestDurationSeconds = new Histogram({
        name: 'recurrence_tracker_todoist_request_duration_seconds',
        help: 'Todoist API request latency, by endpoint.',
        labelNames: ['endpoint'] as const,
        registers: [register],
    });
    const stateDbSizeBytes = new Gauge({
        name: 'recurrence_tracker_state_db_size_bytes',
        help: 'Size in bytes of the SQLite state file.',
        registers: [register],
    });

    return {
        register,
        lastSuccessfulPollTimestampSeconds,
        pollCyclesTotal,
        pollDurationSeconds,
        trackedTasks,
        tasksOnboardedTotal,
        tasksPrunedTotal,
        completionsRecordedTotal,
        todoistRequestsTotal,
        todoistRequestDurationSeconds,
        stateDbSizeBytes,
    };
}

export type Metrics = ReturnType<typeof createMetrics>;

/** Wraps a Todoist SDK call with request-count and latency instrumentation. */
export async function instrumentTodoistCall<T>(metrics: Metrics, endpoint: TodoistEndpoint, fn: () => Promise<T>): Promise<T> {
    const stopTimer = metrics.todoistRequestDurationSeconds.startTimer({ endpoint });
    try {
        const result = await fn();
        stopTimer();
        metrics.todoistRequestsTotal.inc({ endpoint, outcome: 'success' });
        return result;
    } catch (err) {
        stopTimer();
        metrics.todoistRequestsTotal.inc({ endpoint, outcome: 'error' });
        throw err;
    }
}
