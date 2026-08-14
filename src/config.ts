import { z } from 'zod';

const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// This mirrors the env var table in design doc section 1 exactly - these five
// variables (plus whether the token was found) are what the startup log line echoes.
const envSchema = z.object({
    TODOIST_API_TOKEN: z.string().min(1, 'TODOIST_API_TOKEN is required'),
    POLL_INTERVAL_MINUTES: z.coerce.number().int().positive().default(20),
    STARTER_LABEL: z.string().min(1).default('track-recurrence'),
    METRICS_PORT: z.coerce.number().int().positive().default(9090),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('INFO'),
});

export type Config = {
    todoistApiToken: string;
    pollIntervalMinutes: number;
    starterLabel: string;
    metricsPort: number;
    logLevel: LogLevel;
    /** Not part of the documented env var table; defaults to the named-volume path from the design. */
    dbPath: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const parsed = envSchema.safeParse(env);
    if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
        throw new Error(`Invalid configuration: ${message}`);
    }
    const data = parsed.data;
    return {
        todoistApiToken: data.TODOIST_API_TOKEN,
        pollIntervalMinutes: data.POLL_INTERVAL_MINUTES,
        starterLabel: data.STARTER_LABEL,
        metricsPort: data.METRICS_PORT,
        logLevel: data.LOG_LEVEL,
        dbPath: env.DB_PATH?.trim() || '/app/data/tracked_tasks.db',
    };
}
