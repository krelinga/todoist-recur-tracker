import { TodoistApi } from '@doist/todoist-sdk';
import { loadConfig } from './config';
import { openDb } from './db';
import { createLogger } from './logger';
import { createMetrics } from './metrics';
import { createCompletionScanCursor } from './poller/completion-scan-cursor';
import { runPollCycle } from './poller/cycle';
import { createMetricsServer } from './server';
import { createTodoistClient } from './todoist';

function main(): void {
    let config;
    try {
        config = loadConfig();
    } catch (err) {
        // No logger yet (LOG_LEVEL itself may be what's invalid) - write directly to stderr.
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
        return;
    }

    const logger = createLogger(config.logLevel);
    // One INFO line at startup echoing resolved config (design doc section 9) -
    // token presence only, never its value.
    logger.info(
        `starting: POLL_INTERVAL_MINUTES=${config.pollIntervalMinutes} STARTER_LABEL=${config.starterLabel} ` +
            `METRICS_PORT=${config.metricsPort} LOG_LEVEL=${config.logLevel} TODOIST_API_TOKEN=${config.todoistApiToken ? 'set' : 'missing'}`,
    );

    const db = openDb(config.dbPath);
    const metrics = createMetrics();
    const api = new TodoistApi(config.todoistApiToken);
    const todoist = createTodoistClient(api, metrics);
    const scanCursor = createCompletionScanCursor();

    const metricsServer = createMetricsServer(metrics);
    metricsServer.listen(config.metricsPort, () => {
        logger.info(`metrics server listening on :${config.metricsPort}/metrics`);
    });

    let cycleInFlight: Promise<void> | null = null;
    const tick = (): void => {
        if (cycleInFlight) {
            logger.warn('previous poll cycle still running, skipping this tick');
            return;
        }
        cycleInFlight = runPollCycle(db, todoist, logger, metrics, config.starterLabel, config.dbPath, scanCursor).finally(() => {
            cycleInFlight = null;
        });
    };

    const intervalMs = config.pollIntervalMinutes * 60_000;
    const interval = setInterval(tick, intervalMs);
    tick(); // run immediately on startup rather than waiting a full interval

    let shuttingDown = false;
    const shutdown = (signal: string): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info(`received ${signal}, finishing the in-flight poll cycle before exiting`);
        clearInterval(interval);
        Promise.resolve(cycleInFlight ?? undefined)
            .catch(() => {
                // The cycle already logs its own error; nothing more to do here.
            })
            .then(() => {
                metricsServer.close();
                db.close();
                logger.info('shutdown complete');
                process.exit(0);
            });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
