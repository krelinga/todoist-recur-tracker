import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger';

function fakeStreams() {
    return {
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        stderr: { write: vi.fn() } as unknown as NodeJS.WritableStream,
    };
}

describe('createLogger', () => {
    it('routes debug and info to stdout, warn and error to stderr', () => {
        const streams = fakeStreams();
        const logger = createLogger('DEBUG', streams);

        logger.debug('debug message');
        logger.info('info message');
        logger.warn('warn message');
        logger.error('error message');

        expect(streams.stdout.write).toHaveBeenCalledTimes(2);
        expect(streams.stderr.write).toHaveBeenCalledTimes(2);
    });

    it('formats each line as "<timestamp> <LEVEL> <message>"', () => {
        const streams = fakeStreams();
        const logger = createLogger('DEBUG', streams);

        logger.info('onboarded task 6839201422 -> 🔁 x0 #42');

        const line = (streams.stdout.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z INFO {2}onboarded task 6839201422 -> 🔁 x0 #42\n$/);
    });

    it('filters out levels below the configured floor', () => {
        const streams = fakeStreams();
        const logger = createLogger('WARN', streams);

        logger.debug('quiet');
        logger.info('quiet');
        logger.warn('loud');
        logger.error('loud');

        expect(streams.stdout.write).not.toHaveBeenCalled();
        expect(streams.stderr.write).toHaveBeenCalledTimes(2);
    });

    it('defaults to showing nothing below INFO', () => {
        const streams = fakeStreams();
        const logger = createLogger('INFO', streams);

        logger.debug('the firehose');
        logger.info('a real event');

        expect(streams.stdout.write).toHaveBeenCalledTimes(1);
        expect((streams.stdout.write as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('a real event');
    });
});
