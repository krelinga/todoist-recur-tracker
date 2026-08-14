import { describe, expect, it } from 'vitest';
import { counterLabelName, shortIdTag } from '../label-name';

describe('counterLabelName', () => {
    it('formats as the fixed emoji, count, and short_id from design doc section 2', () => {
        expect(counterLabelName(42, 0)).toBe('🔁 x0 #42');
        expect(counterLabelName(42, 4)).toBe('🔁 x4 #42');
    });
});

describe('shortIdTag', () => {
    it('formats the short log-reference tag without the count', () => {
        expect(shortIdTag(42)).toBe('🔁 #42');
    });
});
