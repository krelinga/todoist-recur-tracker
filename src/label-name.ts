// Fixed, decorative tag - a single simple codepoint (no skin-tone/ZWJ
// modifiers) so label length stays predictable against Todoist's limit.
// Uniqueness rests entirely on the plain-digit short_id (design doc section 2).
const COUNTER_EMOJI = '🔁';

export function counterLabelName(shortId: number, recurrenceCount: number): string {
    return `${COUNTER_EMOJI} x${recurrenceCount} #${shortId}`;
}

export function shortIdTag(shortId: number): string {
    return `${COUNTER_EMOJI} #${shortId}`;
}

/**
 * Matches this task's counter label regardless of its current count.
 *
 * Used for the Phase B tracking check instead of comparing against a
 * locally-recomputed exact name: if a rename committed to SQLite but never
 * reached Todoist (crash between the two - design doc section 6), the live
 * label still shows the old count. Matching on the shortId portion alone
 * (unique per task) finds it regardless, avoiding a false prune.
 */
export function counterLabelPattern(shortId: number): RegExp {
    return new RegExp(`^${COUNTER_EMOJI} x\\d+ #${shortId}$`, 'u');
}
