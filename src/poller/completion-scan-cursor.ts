export type CompletionScanCursor = {
    /** The time of the last successful account-wide completion-events fetch, or null before the first one. */
    get(): Date | null;
    /** Records a successful fetch. Must only be called after the fetch actually succeeds. */
    recordSuccess(at: Date): void;
};

/**
 * In-memory (never persisted) tracker for the last successful completion-events
 * fetch. Resetting on every restart is deliberate, not an oversight: it means
 * the first fetch after any restart always falls back to the thorough
 * per-row bootstrap (see runUpdatePhase in update.ts), so a crash or
 * deliberate restart can never cause a gap - only cost one wider catch-up
 * fetch before returning to the cheap steady-state window.
 */
export function createCompletionScanCursor(): CompletionScanCursor {
    let lastSuccessfulScanAt: Date | null = null;
    return {
        get: () => lastSuccessfulScanAt,
        recordSuccess: (at) => {
            lastSuccessfulScanAt = at;
        },
    };
}
