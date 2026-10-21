import { describe, expect, it } from 'vitest';
import {
    SearchqlError,
    defineSchema,
    lower,
    parse,
    type LoweredNode,
    type QueryNode,
} from './index';
import { NOW } from './test-utils/dataset';
import { issues } from './test-utils/fixtures';

const options = { now: NOW, variables: { me: 'alice' } };
const lowered = (input: string, extra = {}) =>
    lower(parse(input, issues), issues, { ...options, ...extra });

function show(node: LoweredNode): string {
    const value = (v: unknown) => (v instanceof Date ? v.toISOString() : JSON.stringify(v));
    switch (node.type) {
        case 'const':
            return String(node.value);
        case 'and':
        case 'or':
            return `${node.type}(${node.children.map(show).join(', ')})`;
        case 'not':
            return `not(${show(node.child)})`;
        case 'compare':
            return `${node.field} ${node.op} ${value(node.value)}`;
        case 'in':
            return `${node.field} in ${node.values.map(value).join('|')}`;
        case 'match':
            return `${node.field} ${node.mode}${node.caseSensitive ? '' : '/i'} ${value(node.value)}`;
        case 'exists':
            return `has ${node.field}`;
        case 'text':
            return `text ${value(node.value)}`;
    }
}

const view = (input: string, extra = {}) => show(lowered(input, extra));

describe('lower', () => {
    it('matches everything for an empty query', () => {
        expect(lower(null, issues)).toEqual({ type: 'const', value: true });
        expect(lower(parse('', issues), issues)).toEqual({ type: 'const', value: true });
    });

    it('accepts a parse result or a bare tree', () => {
        const result = parse('status:open', issues);
        expect(lower(result.ast, issues)).toEqual(lower(result, issues));
    });

    it('compares strings with the field match mode and case rule', () => {
        expect(view('author:Alice title:leak key:APP-1 author:al*')).toBe(
            'and(author exact/i "Alice", title contains/i "leak", key exact "APP-1", author prefix/i "al")'
        );
    });

    it('searches the schema text fields for free text', () => {
        expect(view('leak')).toBe('title contains/i "leak"');
        const schema = defineSchema({
            fields: { a: { type: 'string' }, b: { type: 'enum', values: ['x'] } },
            text: ['a', 'b'],
        });
        expect(show(lower(parse('foo', schema), schema))).toBe(
            'or(a contains/i "foo", b contains/i "foo")'
        );
        const passThrough = defineSchema({ fields: { a: { type: 'string' } }, text: true });
        expect(show(lower(parse('foo', passThrough), passThrough))).toBe('text "foo"');
    });

    it('stores enum values as mapped', () => {
        const schema = defineSchema({
            fields: { level: { type: 'enum', values: { low: 1, mid: 2, high: 3 }, ordered: true } },
        });
        const run = (q: string) => show(lower(parse(q, schema), schema));
        expect(run('level:mid')).toBe('level eq 2');
        expect(run('level:>=mid')).toBe('level in 2|3');
        expect(run('level:>high')).toBe('false');
        expect(run('level:<mid')).toBe('level in 1');
        expect(run('level:<=low')).toBe('level in 1');
        expect(run('level:low..mid')).toBe('level in 1|2');
        expect(run('level:mid..*')).toBe('level in 2|3');
        expect(run('level:high..low')).toBe('false');
        expect(run('level:low,high')).toBe('or(level eq 1, level eq 3)');
    });

    it('turns dates into half-open periods', () => {
        expect(view('created:2026-10-13')).toBe(
            'and(created gte 2026-10-13T00:00:00.000Z, created lt 2026-10-14T00:00:00.000Z)'
        );
        expect(view('created:>2026-10-13')).toBe('created gte 2026-10-14T00:00:00.000Z');
        expect(view('created:>=2026-10-13')).toBe('created gte 2026-10-13T00:00:00.000Z');
        expect(view('created:<2026-10-13')).toBe('created lt 2026-10-13T00:00:00.000Z');
        expect(view('created:<=2026-10-13')).toBe('created lt 2026-10-14T00:00:00.000Z');
        expect(view('created:2026-01..2026-03')).toBe(
            'and(created gte 2026-01-01T00:00:00.000Z, created lt 2026-04-01T00:00:00.000Z)'
        );
        expect(view('created:today', { timeZone: 'Europe/Kyiv' })).toBe(
            'and(created gte 2026-10-12T21:00:00.000Z, created lt 2026-10-13T21:00:00.000Z)'
        );
    });

    it('reads a relative date on its own as "between then and now"', () => {
        expect(view('created:-7d')).toBe(
            'and(created gte 2026-10-06T12:00:00.000Z, created lte 2026-10-13T12:00:00.000Z)'
        );
        expect(view('created:+1d')).toBe(
            'and(created gte 2026-10-13T12:00:00.000Z, created lte 2026-10-14T12:00:00.000Z)'
        );
        expect(view('created:<-30d')).toBe('created lt 2026-09-13T12:00:00.000Z');
    });

    it('uses the current time by default', () => {
        const before = Date.now();
        const node = lower(parse('created:>now', issues), issues) as { value: Date };
        expect(node.value.getTime()).toBeGreaterThan(before);
    });

    it('resolves variables, including lists', () => {
        expect(view('author:@me')).toBe('author eq "alice"');
        expect(view('author:@me', { variables: { me: ['a', 'b'] } })).toBe('author in "a"|"b"');
        expect(view('author:@me x', { variables: { me: [] } })).toBe('false');
        expect(() => lowered('author:@me', { variables: {} })).toThrow(SearchqlError);
        expect(() => lowered('author:@me', { variables: {} })).toThrow(/options\.variables\.me/);
    });

    it('pushes negation down to the leaves', () => {
        expect(view('-(status:open OR draft:true)')).toBe(
            'and(not(status eq "open"), not(draft eq true))'
        );
        expect(view('-(status:open draft:true)')).toBe(
            'or(not(status eq "open"), not(draft eq true))'
        );
        expect(view('--status:open')).toBe('status eq "open"');
        expect(view('-label:bug,ui')).toBe(
            'and(not(label exact/i "bug"), not(label exact/i "ui"))'
        );
        expect(view('-is:unassigned')).toBe('has assignee');
        expect(view('-priority:>urgent')).toBe('true');
        expect(view('-(priority:>urgent OR status:open)')).toBe('not(status eq "open")');
    });

    it('simplifies constants in junctions', () => {
        expect(view('priority:>urgent OR status:open')).toBe('status eq "open"');
        expect(view('priority:>urgent status:open')).toBe('false');
        expect(view('(priority:>urgent OR priority:>urgent) status:open')).toBe('false');
    });

    it('rejects options it cannot use', () => {
        expect(() => lowered('a', { now: new Date('nope') })).toThrow('`now` is not a valid date');
        expect(() => lowered('a', { timeZone: 'Nowhere/Land' })).toThrow(RangeError);
        expect(() => lower(parse('a', issues), {} as never)).toThrow(TypeError);
    });

    it('rejects hand-built trees that name unknown fields', () => {
        const node: QueryNode = { type: 'exists', field: 'nope', span: { start: 0, end: 0 } };
        expect(() => lower(node, issues)).toThrow('Unknown field "nope"');
        const inherited: QueryNode = { ...node, field: 'constructor' };
        expect(() => lower(inherited, issues)).toThrow('Unknown field "constructor"');
    });
});
