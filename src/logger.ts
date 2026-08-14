import type { LogLevel } from './config';

const LEVEL_ORDER: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

export type Logger = {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
};

export type LogStreams = {
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
};

function timestamp(): string {
    // Design doc's example lines omit milliseconds: "2026-08-13T14:32:01Z INFO  ...".
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function createLogger(minLevel: LogLevel, streams: LogStreams = { stdout: process.stdout, stderr: process.stderr }): Logger {
    const threshold = LEVEL_ORDER[minLevel];
    const write = (level: LogLevel, stream: NodeJS.WritableStream, message: string) => {
        if (LEVEL_ORDER[level] < threshold) return;
        stream.write(`${timestamp()} ${level.padEnd(5)} ${message}\n`);
    };
    return {
        debug: (message) => write('DEBUG', streams.stdout, message),
        info: (message) => write('INFO', streams.stdout, message),
        warn: (message) => write('WARN', streams.stderr, message),
        error: (message) => write('ERROR', streams.stderr, message),
    };
}
