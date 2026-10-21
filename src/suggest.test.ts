import { describe, expect, it } from 'vitest';
import { defineSchema, suggest } from './index';
import { issues } from './test-utils/fixtures';

const at = (template: string, options = {}) => {
    const cursor = template.indexOf('|');
    const input = template.replace('|', '');
    const result = suggest(input, cursor, issues, options);
    return { ...result, labels: result.items.map(item => item.label), input };
};

const apply = (template: string, label: string, options = {}) => {
    const result = at(template, options);
    const item = result.items.find(i => i.label === label)!;
    return result.input.slice(0, result.from) + item.insert + result.input.slice(result.to);
};

describe('suggest fields', () => {
    it('lists every field, shortcut and keyword in an empty box', () => {
        const result = at('|');
        expect(result.context).toEqual({ kind: 'field', prefix: '' });
        expect(result.labels).toEqual([
            'status',
            'priority',
            'author',
            'assignee',
            'label',
            'title',
            'comments',
            'score',
            'created',
            'closed',
            'draft',
            'key',
            'is',
            'has',
            'no',
        ]);
        expect(result.items[0]).toEqual({
            label: 'status',
            insert: 'status:',
            kind: 'field',
            detail: 'Issue state',
        });
        expect(result.items.find(i => i.label === 'priority')!.detail).toBe(
            'low, medium, high, urgent'
        );
        expect(result.items.find(i => i.label === 'label')!.detail).toBe('string list');
        expect(result.items.find(i => i.label === 'is')).toEqual({
            label: 'is',
            insert: 'is:',
            kind: 'shortcut',
            detail: 'open, closed, draft, unassigned',
        });
    });

    it('starts a new term between terms', () => {
        expect(at('status:open |').from).toBe(12);
        expect(at('status:open |').context.kind).toBe('field');
        expect(at('status:open| x').context.kind).toBe('value');
    });

    it('ranks prefix matches, then aliases, then substrings, then subsequences', () => {
        expect(at('a|').labels).toEqual([
            'author',
            'assignee',
            'status',
            'label',
            'created',
            'draft',
            'has',
        ]);
        expect(at('b|').labels).toEqual(['author', 'label']);
        expect(at('crtd|').labels).toEqual(['created']);
        expect(at('zzz|').labels).toEqual([]);
    });

    it('replaces the whole field name, including the colon', () => {
        expect(apply('sta|', 'status')).toBe('status:');
        expect(apply('-sta|tus:open', 'status')).toBe('-status:open');
        expect(apply('stat|us:open', 'status')).toBe('status:open');
    });

    it('limits the number of items', () => {
        expect(at('|', { limit: 2 }).labels).toEqual(['status', 'priority']);
    });

    it('stays quiet inside phrases, keywords and odd words', () => {
        expect(at('"memo|').context).toEqual({ kind: 'none' });
        expect(at('a OR| b').context).toEqual({ kind: 'none' });
        expect(at('10:3|0').context).toEqual({ kind: 'none' });
        expect(at('x!|').items).toEqual([]);
        expect(at('nope:|').context).toEqual({ kind: 'none' });
    });

    it('omits has/no when no field can be empty', () => {
        const schema = defineSchema({ fields: { a: { type: 'string' } } });
        expect(suggest('', 0, schema).items.map(i => i.label)).toEqual(['a']);
    });
});

describe('suggest values', () => {
    it('offers enum values', () => {
        const result = at('status:|');
        expect(result).toMatchObject({
            from: 7,
            to: 7,
            context: { kind: 'value', field: 'status', prefix: '' },
        });
        expect(result.labels).toEqual(['open', 'closed', 'merged']);
        expect(at('Status:cl|').labels).toEqual(['closed']);
        expect(apply('status:op|en', 'open')).toBe('status:open');
    });

    it('skips values already in the list and replaces only the current item', () => {
        expect(at('status:open,|').labels).toEqual(['closed', 'merged']);
        expect(apply('status:open,m|,closed', 'merged')).toBe('status:open,merged,closed');
    });

    it('offers known values, variables and quotes when needed', () => {
        const options = { values: { label: ['bug', 'good first issue'], assignee: ['bob'] } };
        expect(at('label:|', options).labels).toEqual(['bug', 'good first issue']);
        expect(apply('label:goo|', 'good first issue', options)).toBe('label:"good first issue"');
        expect(apply('label:"goo|', 'good first issue', options)).toBe('label:"good first issue"');
        expect(at('assignee:|', options).items).toEqual([
            { label: '@me', insert: '@me', kind: 'variable' },
            { label: 'bob', insert: 'bob', kind: 'value' },
        ]);
        expect(at('author:|').labels).toEqual(['@me']);
        expect(at('title:|').labels).toEqual([]);
    });

    it('offers booleans and date presets', () => {
        expect(at('draft:|').labels).toEqual(['true', 'false']);
        expect(at('created:|').labels).toEqual(['today', 'yesterday', '-7d', '-30d', '-1y']);
        expect(at('created:-3|').labels).toEqual(['-30d']);
    });

    it('works after an operator and after a range', () => {
        expect(at('priority:>=h|')).toMatchObject({ from: 11, context: { prefix: 'h' } });
        expect(at('priority:>=h|').labels).toEqual(['high']);
        const range = at('priority:low..u|');
        expect(range).toMatchObject({ from: 14, to: 15, context: { prefix: 'u' } });
        expect(range.labels).toEqual(['urgent', 'medium']);
        expect(at('created:2026-01..|').labels).toContain('today');
        expect(at('author:a..|', { values: { author: ['a..b'] } }).labels).toEqual(['a..b']);
    });

    it('offers shortcut values and the fields has:/no: accept', () => {
        expect(at('is:|')).toMatchObject({ context: { kind: 'shortcut', name: 'is', prefix: '' } });
        expect(at('is:|').items[0]).toEqual({
            label: 'open',
            insert: 'open',
            kind: 'value',
            detail: 'status:open',
        });
        expect(at('is:open,|').labels).toEqual(['closed', 'draft', 'unassigned']);
        expect(at('has:|')).toMatchObject({ context: { kind: 'exists', prefix: '' } });
        expect(at('no:|').labels).toEqual(['assignee', 'label', 'closed']);
    });

    it('clamps the cursor', () => {
        expect(suggest('sta', 99, issues).context).toEqual({ kind: 'field', prefix: 'sta' });
        expect(suggest('sta', -5, issues).from).toBe(0);
        expect(suggest('sta', Number.NaN, issues).context).toEqual({
            kind: 'field',
            prefix: 'sta',
        });
    });
});
