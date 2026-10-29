import { describe, expect, it } from 'vitest';
import { addFilter, getFilters, hasFilter, removeFilter, setFilter, toggleFilter } from './index';
import { issues } from './test-utils/fixtures';

describe('getFilters', () => {
    it('lists top-level filters as typed', () => {
        expect(
            getFilters(
                '-label:bug by:Alice status:open,closed is:open no:assignee comments:1..* leak (a OR b)',
                issues
            )
        ).toEqual([
            {
                kind: 'filter',
                field: 'label',
                negated: true,
                op: 'eq',
                values: ['bug'],
                text: '-label:bug',
                span: { start: 0, end: 10 },
            },
            {
                kind: 'filter',
                field: 'author',
                negated: false,
                op: 'eq',
                values: ['Alice'],
                text: 'by:Alice',
                span: { start: 11, end: 19 },
            },
            {
                kind: 'filter',
                field: 'status',
                negated: false,
                op: 'in',
                values: ['open', 'closed'],
                text: 'status:open,closed',
                span: { start: 20, end: 38 },
            },
            {
                kind: 'shortcut',
                field: 'is',
                negated: false,
                op: 'eq',
                values: ['open'],
                text: 'is:open',
                span: { start: 39, end: 46 },
            },
            {
                kind: 'exists',
                field: 'assignee',
                negated: true,
                op: 'eq',
                values: [],
                text: 'no:assignee',
                span: { start: 47, end: 58 },
            },
            {
                kind: 'filter',
                field: 'comments',
                negated: false,
                op: 'range',
                values: ['1', ''],
                text: 'comments:1..*',
                span: { start: 59, end: 72 },
            },
        ]);
    });

    it('lists nothing when the top level is an OR', () => {
        expect(getFilters('status:open OR status:closed', issues)).toEqual([]);
        expect(getFilters('', issues)).toEqual([]);
        expect(getFilters('is:open,draft', issues)[0]!.op).toBe('in');
    });
});

describe('setFilter', () => {
    it('replaces the field in place and keeps the rest of the text', () => {
        expect(setFilter('leak status:open  -label:x', issues, 'status', 'closed')).toBe(
            'leak status:closed  -label:x'
        );
        expect(
            setFilter('a status:open b status:merged c', issues, 'status', ['closed', 'merged'])
        ).toBe('a status:closed,merged b c');
    });

    it('appends when the field is not there', () => {
        expect(setFilter('', issues, 'status', 'open')).toBe('status:open');
        expect(setFilter('leak  ', issues, 'label', 'good first issue')).toBe(
            'leak label:"good first issue"'
        );
        expect(setFilter('a OR b', issues, 'status', 'open')).toBe('(a OR b) status:open');
    });

    it('removes the field for null or an empty list', () => {
        expect(setFilter('a status:open b', issues, 'status', null)).toBe('a b');
        expect(setFilter('status:open b', issues, 'status', [])).toBe('b');
        expect(setFilter('b status:open', issues, 'status', null)).toBe('b');
        expect(setFilter('b', issues, 'status', null)).toBe('b');
    });

    it('treats operators and negation as separate filters', () => {
        const q = 'created:>2026-01-01 created:<2026-02-01';
        expect(setFilter(q, issues, 'created', '2026-01-15', { op: '>' })).toBe(
            'created:>2026-01-15 created:<2026-02-01'
        );
        expect(setFilter(q, issues, 'created', 'today')).toBe(`${q} created:today`);
        expect(setFilter('-label:bug label:ui', issues, 'label', 'x', { negate: true })).toBe(
            '-label:x label:ui'
        );
        expect(setFilter('-label:bug label:ui', issues, 'label', 'x')).toBe('-label:bug label:x');
    });

    it('accepts aliases and shortcut names, and rejects unknown fields', () => {
        expect(setFilter('author:a', issues, 'by', 'b')).toBe('author:b');
        expect(setFilter('is:open', issues, 'is', 'draft')).toBe('is:draft');
        expect(() => setFilter('', issues, 'nope', 'x')).toThrow('Unknown field "nope"');
    });
});

describe('addFilter', () => {
    it('appends even when the field is already there', () => {
        expect(addFilter('label:bug', issues, 'label', 'ui')).toBe('label:bug label:ui');
        expect(addFilter('x', issues, 'comments', '5', { op: '>=', negate: true })).toBe(
            'x -comments:>=5'
        );
        expect(addFilter('x', issues, 'label', [])).toBe('x');
    });
});

describe('removeFilter', () => {
    it('removes all top-level filters on a field', () => {
        expect(removeFilter('a label:bug b -label:ui', issues, 'label')).toBe('a b');
        expect(
            removeFilter('a label:bug b -label:ui', issues, 'label', undefined, { negated: true })
        ).toBe('a label:bug b');
        expect(removeFilter('(label:bug OR x)', issues, 'label')).toBe('(label:bug OR x)');
    });

    it('removes a single value from a list, matching by meaning', () => {
        expect(removeFilter('label:bug,UI,docs x', issues, 'label', 'ui')).toBe('label:bug,docs x');
        expect(removeFilter('-by:Alice,bob', issues, 'author', 'alice')).toBe('-by:bob');
        expect(removeFilter('status:OPEN', issues, 'status', 'open')).toBe('');
        expect(
            removeFilter('label:"good first issue",bug', issues, 'label', 'good first issue')
        ).toBe('label:bug');
        expect(removeFilter('is:open,draft', issues, 'is', 'OPEN')).toBe('is:draft');
        expect(removeFilter('-is:open,draft', issues, 'is', 'draft')).toBe('-is:open');
        expect(removeFilter('key:A,a', issues, 'key', 'a')).toBe('key:A');
        expect(removeFilter('comments:5 comments:05', issues, 'comments', '5')).toBe('');
        expect(removeFilter('created:2026-01 created:today', issues, 'created', '2026-01')).toBe(
            'created:today'
        );
        expect(removeFilter('author:@me', issues, 'author', '@me')).toBe('');
        expect(removeFilter('label:bug', issues, 'label', 'nope')).toBe('label:bug');
        expect(removeFilter('comments:>1', issues, 'comments', '1')).toBe('comments:>1');
        expect(removeFilter('label:a* label:a', issues, 'label', 'a*')).toBe('label:a');
    });

    it('keeps list items it could not parse', () => {
        expect(removeFilter('status:open,bogus,closed x', issues, 'status', 'closed')).toBe(
            'status:open,bogus x'
        );
        expect(removeFilter('is:open,nope', issues, 'is', 'open')).toBe('is:nope');
        expect(removeFilter('label:a,,b', issues, 'label', 'b')).toBe('label:a');
    });
});

describe('toggleFilter', () => {
    it('adds to an existing list or starts one', () => {
        expect(toggleFilter('x label:bug', issues, 'label', 'ui')).toBe('x label:bug,ui');
        expect(toggleFilter('x', issues, 'label', 'good first issue')).toBe(
            'x label:"good first issue"'
        );
        expect(toggleFilter('-label:bug', issues, 'label', 'ui', { negate: true })).toBe(
            '-label:bug,ui'
        );
        expect(toggleFilter('-label:bug', issues, 'label', 'ui')).toBe('-label:bug label:ui');
        expect(toggleFilter('label:bug,ui x', issues, 'label', 'docs')).toBe('label:bug,ui,docs x');
        expect(toggleFilter('label:bug, x', issues, 'label', 'ui')).toBe('label:bug,ui x');
    });

    it('removes a value that is already selected', () => {
        expect(toggleFilter('x label:bug,ui', issues, 'label', 'BUG')).toBe('x label:ui');
        expect(toggleFilter('status:open', issues, 'status', 'open')).toBe('');
        expect(toggleFilter('is:open', issues, 'is', 'open')).toBe('');
    });
});

describe('hasFilter', () => {
    it('checks for a field or a value', () => {
        expect(hasFilter('label:bug,ui', issues, 'label')).toBe(true);
        expect(hasFilter('label:bug,ui', issues, 'label', 'UI')).toBe(true);
        expect(hasFilter('label:bug,ui', issues, 'label', 'docs')).toBe(false);
        expect(hasFilter('-label:bug', issues, 'label', 'bug', { negated: false })).toBe(false);
        expect(hasFilter('-label:bug', issues, 'label', 'bug', { negated: true })).toBe(true);
        expect(hasFilter('status:open', issues, 'status', 'nope')).toBe(false);
        expect(hasFilter('x', issues, 'status')).toBe(false);
    });
});
