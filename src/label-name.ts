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
