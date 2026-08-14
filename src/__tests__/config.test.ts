import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';

describe('loadConfig', () => {
    it('applies documented defaults when only the token is set', () => {
        const config = loadConfig({ TODOIST_API_TOKEN: 'abc123' });
        expect(config).toEqual({
            todoistApiToken: 'abc123',
            pollIntervalMinutes: 20,
            starterLabel: 'track-recurrence',
            metricsPort: 9090,
            logLevel: 'INFO',
            dbPath: '/app/data/tracked_tasks.db',
        });
    });

    it('reads overrides from the environment', () => {
        const config = loadConfig({
            TODOIST_API_TOKEN: 'abc123',
            POLL_INTERVAL_MINUTES: '5',
            STARTER_LABEL: 'my-starter',
            METRICS_PORT: '9999',
            LOG_LEVEL: 'DEBUG',
            DB_PATH: '/tmp/tasks.db',
        });
        expect(config).toEqual({
            todoistApiToken: 'abc123',
            pollIntervalMinutes: 5,
            starterLabel: 'my-starter',
            metricsPort: 9999,
            logLevel: 'DEBUG',
            dbPath: '/tmp/tasks.db',
        });
    });

    it('throws when the token is missing', () => {
        expect(() => loadConfig({})).toThrow(/TODOIST_API_TOKEN/);
    });

    it('throws on an invalid log level', () => {
        expect(() => loadConfig({ TODOIST_API_TOKEN: 'abc123', LOG_LEVEL: 'TRACE' })).toThrow();
    });

    it('throws on a non-numeric poll interval', () => {
        expect(() => loadConfig({ TODOIST_API_TOKEN: 'abc123', POLL_INTERVAL_MINUTES: 'soon' })).toThrow();
    });
});
