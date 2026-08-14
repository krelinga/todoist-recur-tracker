import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMetrics } from '../metrics';
import { createMetricsServer } from '../server';

function get(port: number, path: string): Promise<{ status: number; body: string; contentType: string | undefined }> {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path }, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () =>
                resolve({ status: res.statusCode ?? 0, body, contentType: res.headers['content-type'] }),
            );
        }).on('error', reject);
    });
}

describe('createMetricsServer', () => {
    let server: http.Server;
    let port: number;

    beforeEach(async () => {
        const metrics = createMetrics();
        metrics.trackedTasks.set(7);
        server = createMetricsServer(metrics);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = (server.address() as AddressInfo).port;
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('serves Prometheus-format metrics on GET /metrics', async () => {
        const res = await get(port, '/metrics');
        expect(res.status).toBe(200);
        expect(res.body).toContain('recurrence_tracker_tracked_tasks 7');
    });

    it('returns 404 for any other path', async () => {
        const res = await get(port, '/not-metrics');
        expect(res.status).toBe(404);
    });
});
