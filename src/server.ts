import * as http from 'node:http';
import type { Metrics } from './metrics';

/**
 * Always-on HTTP server exposing /metrics (design doc section 1) - kept
 * separate from the poll loop so a scrape can land at any point between
 * cycles and still see fresh values from the last completed one.
 */
export function createMetricsServer(metrics: Metrics): http.Server {
    return http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/metrics') {
            metrics.register
                .metrics()
                .then((body) => {
                    res.writeHead(200, { 'Content-Type': metrics.register.contentType });
                    res.end(body);
                })
                .catch((err: unknown) => {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end(`failed to collect metrics: ${err instanceof Error ? err.message : String(err)}`);
                });
            return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
    });
}
