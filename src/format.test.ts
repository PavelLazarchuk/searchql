import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { defineSchema, format, formatValue, parse, type QueryNode } from './index';
import { issues } from './test-utils/fixtures';

function shape(node: QueryNode | null): unknown {
    return JSON.parse(JSON.stringify(node, (key, value) => (key === 'span' ? undefined : value)));
}

const canonical = (input: string) => format(parse(input, issues));

describe('format', () => {
    it('writes canonical names, minimal quotes and single spaces', () => {
        expect(canonical('  BY:alice   Status:OPEN  ')).toBe('author:alice status:open');
        expect(canonical('label:"bug" title:"memory leak" "phrase"')).toBe(
            'label:bug title:"memory leak" "phrase"'
        );
        expect(canonical('')).toBe('');
        expect(format(null)).toBe('');
    });

    it('keeps grouping and precedence', () => {
        expect(canonical('a b OR c')).toBe('a b OR c');
        expect(canonical('(a OR b) c')).toBe('(a OR b) c');
        expect(canonical('(a OR b) OR c')).toBe('(a OR b) OR c');
        expect(canonical('a (b c)')).toBe('a (b c)');
        expect(canonical('-(a b) NOT c --d')).toBe('-(a b) -c --d');
    });

    it('writes every kind of value', () => {
        expect(
            canonical(
                'comments:>=5 score:-1.5 draft:yes created:2026-03..* created:<-7d author:@me'
            )
        ).toBe('comments:>=5 score:-1.5 draft:true created:2026-03..* created:<-7d author:@me');
        expect(canonical('priority:*..high is:open,draft has:label no:closed')).toBe(
            'priority:*..high is:open,draft has:label -has:closed'
        );
        expect(
            canonical(
                'author:al* author:*"a b"* author:"a*b" author:"@x" author:"<x" author:"a..b"'
            )
        ).toBe('author:al* author:*"a b"* author:"a*b" author:"@x" author:"<x" author:"a..b"');
    });

    it('quotes free text that would otherwise mean something else', () => {
        expect(
            format({ type: 'text', value: 'a:b', quoted: false, span: { start: 0, end: 0 } })
        ).toBe('"a:b"');
        expect(
            format({ type: 'text', value: '-x', quoted: false, span: { start: 0, end: 0 } })
        ).toBe('"-x"');
        expect(
            format({ type: 'text', value: 'OR', quoted: false, span: { start: 0, end: 0 } })
        ).toBe('"OR"');
        expect(
            format({ type: 'text', value: 'plain', quoted: false, span: { start: 0, end: 0 } })
        ).toBe('plain');
    });

    it('writes instants in UTC', () => {
        expect(formatValue({ kind: 'date', value: { type: 'instant', epochMs: 0 } })).toBe(
            '1970-01-01T00:00:00.000Z'
        );
    });

    it('round-trips: parsing the canonical form gives the same tree', () => {
        const piece = fc.constantFrom(
            'status:open',
            'status:open,closed',
            'priority:>=high',
            'priority:low..*',
            'by:alice',
            'author:"a b"',
            'author:@me',
            'label:b*',
            'label:*x*',
            'title:"100%"',
            'comments:<=3',
            'comments:1..5',
            'score:-2.5',
            'created:2026-03-14',
            'created:>-7d',
            'created:today..tomorrow',
            'draft:no',
            'is:open',
            'is:draft,closed',
            'has:label',
            'no:assignee',
            'leak',
            '"memory leak"',
            '"a:b"',
            'key:"a,b"',
            'author:"\\"q\\""'
        );
        const query: fc.Arbitrary<string> = fc.letrec<{ q: string }>(tie => ({
            q: fc.oneof(
                { depthSize: 'small' },
                piece,
                tie('q').map(q => `-(${q})`),
                piece.map(q => `-${q}`),
                fc.array(tie('q'), { minLength: 2, maxLength: 3 }).map(qs => qs.join(' ')),
                fc.array(tie('q'), { minLength: 2, maxLength: 3 }).map(qs => `(${qs.join(' OR ')})`)
            ),
        })).q;
        fc.assert(
            fc.property(query, input => {
                const first = parse(input, issues);
                expect(first.ok).toBe(true);
                const text = format(first);
                const second = parse(text, issues);
                expect(second.diagnostics).toEqual([]);
                expect(shape(second.ast)).toEqual(shape(first.ast));
                expect(format(second)).toBe(text);
            }),
            { numRuns: 400 }
        );
    });

    it('keeps literal asterisks when wildcards are off', () => {
        const schema = defineSchema({ fields: { sku: { type: 'string', wildcards: false } } });
        expect(format(parse('sku:AB*', schema))).toBe('sku:"AB*"');
        expect(shape(parse(format(parse('sku:AB*', schema)), schema).ast)).toEqual(
            shape(parse('sku:AB*', schema).ast)
        );
    });
});
