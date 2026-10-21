import { describe, expect, it } from 'vitest';
import { closest, editDistance } from './similarity';

describe('editDistance', () => {
    it.each([
        ['', '', 0],
        ['', 'abc', 3],
        ['abc', '', 3],
        ['status', 'status', 0],
        ['stauts', 'status', 1],
        ['satus', 'status', 1],
        ['kitten', 'sitting', 3],
        ['ab', 'ba', 1],
    ])('%s → %s is %i', (a, b, distance) => {
        expect(editDistance(a, b)).toBe(distance);
    });
});

describe('closest', () => {
    it('keeps candidates within a typo of the input, closest first', () => {
        expect(closest('stauts', ['status', 'state', 'stats', 'author'])).toEqual([
            'stats',
            'status',
            'state',
        ]);
        expect(closest('opn', ['open', 'closed'])).toEqual(['open']);
        expect(closest('x', ['author'])).toEqual([]);
    });

    it('accepts an unfinished word as a typo of what it starts', () => {
        expect(closest('assig', ['assignee', 'author'])).toEqual(['assignee']);
        expect(closest('as', ['assignee'])).toEqual([]);
    });

    it('ignores case and duplicates, and respects the limit', () => {
        expect(closest('OPEN', ['open', 'Open', 'opens'], 1)).toEqual(['open']);
        expect(closest('ab', ['ab', 'aB', 'ac', 'ad', 'ae'], 2)).toEqual(['ab', 'ac']);
    });
});
