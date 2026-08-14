import { describe, expect, it } from 'vitest';
import { createMetrics, instrumentTodoistCall } from '../metrics';

describe('createMetrics', () => {
    it('exposes every metric named in design doc section 8, all prefixed recurrence_tracker_', async () => {
        const metrics = createMetrics();
        metrics.lastSuccessfulPollTimestampSeconds.set(123);
        metrics.pollCyclesTotal.inc({ result: 'success' });
        metrics.pollDurationSeconds.observe(1.2);
        metrics.trackedTasks.set(3);
        metrics.tasksOnboardedTotal.inc();
        metrics.tasksPrunedTotal.inc();
        metrics.completionsRecordedTotal.inc(2);
        metrics.todoistRequestsTotal.inc({ endpoint: 'tasks_get', outcome: 'success' });
        metrics.todoistRequestDurationSeconds.observe({ endpoint: 'tasks_get' }, 0.05);
        metrics.stateDbSizeBytes.set(4096);

        const text = await metrics.register.metrics();
        for (const name of [
            'recurrence_tracker_last_successful_poll_timestamp_seconds',
            'recurrence_tracker_poll_cycles_total',
            'recurrence_tracker_poll_duration_seconds',
            'recurrence_tracker_tracked_tasks',
            'recurrence_tracker_tasks_onboarded_total',
            'recurrence_tracker_tasks_pruned_total',
            'recurrence_tracker_completions_recorded_total',
            'recurrence_tracker_todoist_requests_total',
            'recurrence_tracker_todoist_request_duration_seconds',
            'recurrence_tracker_state_db_size_bytes',
        ]) {
            expect(text).toContain(name);
        }
        expect(text).not.toMatch(/task_id|short_id/);
    });

    it('separate createMetrics() calls use independent registries', async () => {
        const a = createMetrics();
        const b = createMetrics();
        a.trackedTasks.set(5);
        b.trackedTasks.set(9);
        expect(await a.register.metrics()).toContain('recurrence_tracker_tracked_tasks 5');
        expect(await b.register.metrics()).toContain('recurrence_tracker_tracked_tasks 9');
    });
});

describe('instrumentTodoistCall', () => {
    it('records a success outcome and observes latency on resolution', async () => {
        const metrics = createMetrics();
        const result = await instrumentTodoistCall(metrics, 'tasks_get', async () => 'ok');
        expect(result).toBe('ok');

        const text = await metrics.register.metrics();
        expect(text).toContain('recurrence_tracker_todoist_requests_total{endpoint="tasks_get",outcome="success"} 1');
    });

    it('records an error outcome and rethrows on rejection', async () => {
        const metrics = createMetrics();
        await expect(
            instrumentTodoistCall(metrics, 'tasks_get', async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');

        const text = await metrics.register.metrics();
        expect(text).toContain('recurrence_tracker_todoist_requests_total{endpoint="tasks_get",outcome="error"} 1');
    });
});
