import { describe, expect, it } from 'vitest';
import { defineSchema, parse, type QueryNode, type Schema } from './index';
import { issues } from './test-utils/fixtures';

const ast = (input: string) => parse(input, issues).ast;
const codes = (input: string, schema: Schema = issues) =>
    parse(input, schema).diagnostics.map(d => d.code);

function show(node: QueryNode | null): string {
    if (!node) return '∅';
    switch (node.type) {
        case 'and':
            return `and(${node.children.map(show).join(', ')})`;
        case 'or':
            return `or(${node.children.map(show).join(', ')})`;
        case 'not':
            return `not(${show(node.child)})`;
        case 'text':
            return node.quoted ? `"${node.value}"` : node.value;
        case 'exists':
            return `has(${node.field})`;
        case 'shortcut':
            return `${node.name}:${node.values.join(',')}=>${show(node.expansion)}`;
        case 'filter': {
            const value = (v: (typeof node & { op: 'eq' })['value'] | null): string => {
                if (!v) return '*';
                if (v.kind === 'variable') return `@${v.name}`;
                if (v.kind === 'date') return JSON.stringify(v.value);
                if (v.kind === 'string' && v.wildcard) return `${v.wildcard}(${v.value})`;
                return String(v.value);
            };
            if (node.op === 'in') return `${node.field} in [${node.values.map(value).join(', ')}]`;
            if (node.op === 'range')
                return `${node.field} in ${value(node.min)}..${value(node.max)}`;
            return `${node.field} ${node.op} ${value(node.value)}`;
        }
    }
}

const tree = (input: string) => show(ast(input));

describe('structure', () => {
    it('returns no tree for an empty query', () => {
        expect(parse('', issues)).toEqual({ input: '', ast: null, diagnostics: [], ok: true });
        expect(parse('   \n\t', issues).ast).toBeNull();
    });

    it('reads words and quoted phrases as free text', () => {
        expect(tree('memory leak')).toBe('and(memory, leak)');
        expect(tree('"memory leak"')).toBe('"memory leak"');
        expect(tree('"say \\"hi\\"" "C:\\dir" "a\\\\b"')).toBe(
            'and("say "hi"", "C:\\dir", "a\\b")'
        );
        expect(tree('"a b"c')).toBe('"a bc"');
    });

    it('joins terms with AND and gives OR the lowest precedence', () => {
        expect(tree('a b OR c')).toBe('or(and(a, b), c)');
        expect(tree('a AND b OR c AND d')).toBe('or(and(a, b), and(c, d))');
        expect(tree('a (b OR c)')).toBe('and(a, or(b, c))');
        expect(tree('((a))')).toBe('a');
        expect(tree('a (b c)')).toBe('and(a, and(b, c))');
    });

    it('negates with a leading - or NOT', () => {
        expect(tree('-a')).toBe('not(a)');
        expect(tree('NOT a b')).toBe('and(not(a), b)');
        expect(tree('-(a OR b)')).toBe('not(or(a, b))');
        expect(tree('--a')).toBe('not(not(a))');
        expect(tree('NOT -status:open')).toBe('not(not(status eq open))');
        expect(tree('foo-bar')).toBe('foo-bar');
    });

    it('treats lowercase keywords as words', () => {
        expect(tree('a or b and not c')).toBe('and(a, or, b, and, not, c)');
    });

    it('records spans that point into the input', () => {
        const input = '  -status:open (a OR "b c")';
        const node = ast(input)!;
        expect(node.type).toBe('and');
        const [negated, group] = (node as { children: readonly QueryNode[] }).children;
        expect(input.slice(negated!.span.start, negated!.span.end)).toBe('-status:open');
        expect(input.slice(group!.span.start, group!.span.end)).toBe('(a OR "b c")');
        const filter = (negated as { child: QueryNode & { type: 'filter'; op: 'eq' } }).child;
        expect(input.slice(filter.value.span!.start, filter.value.span!.end)).toBe('open');
    });
});

describe('filters', () => {
    it('resolves field names and aliases case-insensitively', () => {
        expect(tree('author:alice by:bob BY:carol Status:open')).toBe(
            'and(author eq alice, author eq bob, author eq carol, status eq open)'
        );
    });

    it('keeps the canonical spelling of enum values', () => {
        expect(tree('status:OPEN')).toBe('status eq open');
    });

    it('reads lists as any-of', () => {
        expect(tree('status:open,closed label:"good first issue",bug')).toBe(
            'and(status in [open, closed], label in [good first issue, bug])'
        );
        expect(tree('status:open,')).toBe('status eq open');
        expect(codes('status:open,,closed')).toEqual(['empty-value']);
    });

    it('reads comparisons and ranges on numbers, dates and ordered enums', () => {
        expect(tree('comments:>5 comments:>=5 comments:<5 comments:<=5')).toBe(
            'and(comments gt 5, comments gte 5, comments lt 5, comments lte 5)'
        );
        expect(tree('comments:1..5 comments:1..* comments:*..5 comments:..5 comments:5..')).toBe(
            'and(comments in 1..5, comments in 1..*, comments in *..5, comments in *..5, comments in 5..*)'
        );
        expect(tree('priority:>=high priority:low..medium')).toBe(
            'and(priority gte high, priority in low..medium)'
        );
        expect(tree('score:-1.5 score:.5 score:1e3 score:-0')).toBe(
            'and(score eq -1.5, score eq 0.5, score eq 1000, score eq 0)'
        );
    });

    it('reads booleans', () => {
        expect(tree('draft:true draft:no draft:YES')).toBe(
            'and(draft eq true, draft eq false, draft eq true)'
        );
    });

    it('reads dates', () => {
        const node = ast('created:2026-03 created:today created:-7d created:2026-03-14T10:00:00Z');
        expect(node).toMatchObject({
            children: [
                { value: { kind: 'date', value: { type: 'calendar', year: 2026, month: 3 } } },
                { value: { kind: 'date', value: { type: 'keyword', name: 'today' } } },
                { value: { kind: 'date', value: { type: 'relative', amount: -7, unit: 'd' } } },
                {
                    value: {
                        kind: 'date',
                        value: { type: 'instant', epochMs: Date.UTC(2026, 2, 14, 10) },
                    },
                },
            ],
        });
    });

    it('reads * at the ends of a string as a wildcard, and quotes keep it literal', () => {
        expect(tree('author:al* author:*ce author:*li* author:"a*b" author:*"x y"*')).toBe(
            'and(author eq prefix(al), author eq suffix(ce), author eq contains(li), author eq a*b, author eq contains(x y))'
        );
        expect(codes('author:a*b')).toEqual(['invalid-wildcard']);
        expect(codes('author:*')).toEqual(['invalid-wildcard']);
        expect(codes('author:**')).toEqual(['invalid-wildcard']);
    });

    it('keeps * literal when a field turns wildcards off', () => {
        const schema = defineSchema({ fields: { sku: { type: 'string', wildcards: false } } });
        expect(show(parse('sku:AB*', schema).ast)).toBe('sku eq AB*');
    });

    it('reads @variables only on fields that declare them', () => {
        expect(tree('author:@me assignee:@ME')).toBe('and(author eq @me, assignee eq @me)');
        expect(tree('label:@me')).toBe('label eq @me');
        const result = parse('author:@mee', issues);
        expect(result.diagnostics).toMatchObject([
            { code: 'unknown-variable', suggestions: ['@me'] },
        ]);
        expect(tree('author:"@me"')).toBe('author eq @me');
        expect(ast('author:"@me"')).toMatchObject({ value: { kind: 'string' } });
    });

    it('reads has: and no: for fields that can be empty', () => {
        expect(tree('has:assignee no:label has:label,closed')).toBe(
            'and(has(assignee), not(has(label)), or(has(label), has(closed)))'
        );
        expect(codes('has:author')).toEqual(['not-nullable']);
        const unknown = parse('has:asignee', issues);
        expect(unknown.diagnostics).toMatchObject([
            { code: 'unknown-field', suggestions: ['assignee'] },
        ]);
        expect(codes('has:')).toEqual(['missing-value']);
        expect(tree('has:,label')).toBe('has(label)');
    });

    it('expands shortcuts and keeps their name', () => {
        expect(tree('is:open')).toBe('is:open=>status eq open');
        expect(tree('IS:Draft,closed')).toBe(
            'is:draft,closed=>or(draft eq true, status in [closed, merged])'
        );
        expect(tree('is:unassigned')).toBe('is:unassigned=>not(has(assignee))');
        const node = ast('x is:open')!;
        const shortcut = (node as { children: readonly QueryNode[] }).children[1]!;
        expect(shortcut.span).toEqual({ start: 2, end: 9 });
        expect((shortcut as { expansion: QueryNode }).expansion.span).toEqual({ start: 2, end: 9 });
        expect(ast('is:open')).toMatchObject({
            expansion: { value: { kind: 'enum', value: 'open' } },
        });
        expect(
            (ast('is:open') as { expansion: { value: object } }).expansion.value
        ).not.toHaveProperty('span');
        expect(parse('is:opne', issues).diagnostics).toMatchObject([
            { code: 'invalid-value', suggestions: ['open'] },
        ]);
        expect(codes('is:')).toEqual(['missing-value']);
        expect(tree('is:open,')).toBe('is:open=>status eq open');
    });

    it('expands shortcuts that stand for groups, ranges and negations', () => {
        const schema = defineSchema({
            fields: {
                n: { type: 'number' },
                s: { type: 'string' },
                d: { type: 'date' },
            },
            shortcuts: {
                q: {
                    mid: 'n:2..8 s:a,b',
                    either: '-(n:1 OR s:x)',
                    recent: 'd:>-7d',
                },
            },
        });
        const parsed = parse('q:mid,either,recent', schema);
        expect(parsed.diagnostics).toEqual([]);
        expect(show(parsed.ast)).toBe(
            'q:mid,either,recent=>or(and(n in 2..8, s in [a, b]), not(or(n eq 1, s eq x)), d gt {"type":"relative","amount":-7,"unit":"d"})'
        );
        const spans = JSON.stringify(parsed.ast, (key, value) =>
            key === 'span' ? `${value.start}-${value.end}` : value
        );
        expect(spans.match(/"span":"[^"]+"/g)!.every(span => span === '"span":"0-19"')).toBe(true);
    });

    it('reads words that only look like filters as text', () => {
        expect(tree('10:30 :x "a:b" a"b:c"')).toBe('and(10:30, :x, "a:b", ab:c)');
    });
});

describe('diagnostics', () => {
    it('suggests a field for a typo and drops only that term', () => {
        const result = parse('stauts:open author:alice', issues);
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toEqual([
            {
                severity: 'error',
                code: 'unknown-field',
                message: 'Unknown filter "stauts"',
                start: 0,
                end: 6,
                suggestions: ['status'],
            },
        ]);
        expect(show(result.ast)).toBe('author eq alice');
    });

    it('omits suggestions when nothing is close', () => {
        expect(parse('zzzzzz:1', issues).diagnostics[0]).not.toHaveProperty('suggestions');
    });

    it('reports missing values', () => {
        expect(codes('status:')).toEqual(['missing-value']);
        expect(codes('comments:>')).toEqual(['missing-value']);
        expect(codes('status:,')).toEqual(['missing-value']);
    });

    it('reports invalid values with what is accepted', () => {
        const [enumError] = parse('status:opn', issues).diagnostics;
        expect(enumError).toMatchObject({
            code: 'invalid-value',
            message: '"opn" is not a valid status; expected open, closed, merged',
            suggestions: ['open'],
            start: 7,
            end: 10,
        });
        expect(parse('comments:many', issues).diagnostics[0]!.message).toBe(
            '"many" is not a number'
        );
        expect(parse('comments:1.5', issues).diagnostics[0]!.message).toBe(
            'comments must be a whole number'
        );
        expect(parse('comments:-1', issues).diagnostics[0]!.message).toBe(
            "comments can't be less than 0"
        );
        expect(parse('draft:maybe', issues).diagnostics[0]!.code).toBe('invalid-value');
        expect(parse('created:tody', issues).diagnostics[0]).toMatchObject({
            code: 'invalid-value',
            suggestions: ['today'],
        });
        expect(codes('created:2026-02-30')).toEqual(['invalid-value']);
        expect(codes('score:Infinity score:0x10 score:1_000')).toEqual([
            'invalid-value',
            'invalid-value',
            'invalid-value',
        ]);
    });

    it('enforces number limits on both ends', () => {
        const schema = defineSchema({ fields: { stars: { type: 'number', max: 5 } } });
        expect(parse('stars:6', schema).diagnostics[0]!.message).toBe("stars can't be more than 5");
    });

    it('rejects operators a field does not support', () => {
        expect(codes('author:>a')).toEqual(['unsupported-operator']);
        expect(codes('status:>open')).toEqual(['unsupported-operator']);
        expect(parse('status:>open', issues).diagnostics[0]!.message).toContain(
            'mark the field as ordered'
        );
        expect(codes('draft:>true')).toEqual(['unsupported-operator']);
        expect(codes('comments:>1,2')).toEqual(['invalid-value']);
        expect(codes('comments:>1..2')).toEqual(['invalid-value']);
        expect(codes('assignee:>@me')).toEqual(['unsupported-operator']);
        expect(codes('comments:*..*')).toEqual(['invalid-value']);
        expect(codes('comments:a..2')).toEqual(['invalid-value']);
    });

    it('rejects variables and wildcards in comparisons', () => {
        const schema = defineSchema({ fields: { owner: { type: 'number', variables: ['me'] } } });
        expect(codes('owner:>@me', schema)).toEqual(['unsupported-operator']);
        expect(codes('owner:@me..5', schema)).toEqual(['unsupported-operator']);
        expect(show(parse('owner:@me,3', schema).ast)).toBe('owner in [@me, 3]');
    });

    it('shortens long lists of accepted values', () => {
        const schema = defineSchema({
            fields: {
                c: { type: 'enum', values: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] },
            },
        });
        expect(parse('c:z', schema).diagnostics[0]!.message).toBe(
            '"z" is not a valid c; expected a, b, c, d, e, f, g, h, …'
        );
    });

    it('keeps .. literal in fields without ranges', () => {
        expect(tree('author:a..b')).toBe('author eq a..b');
    });

    it('reports an unterminated quote and still reads the term', () => {
        const result = parse('author:"jane doe', issues);
        expect(result.diagnostics).toMatchObject([
            { code: 'unterminated-quote', start: 7, end: 16 },
        ]);
        expect(show(result.ast)).toBe('author eq jane doe');
        expect(parse('"abc', issues).diagnostics).toMatchObject([
            { code: 'unterminated-quote', start: 0 },
        ]);
    });

    it('recovers from unbalanced parentheses', () => {
        const missing = parse('(a OR b', issues);
        expect(missing.diagnostics).toMatchObject([
            { code: 'unbalanced-paren', message: 'Missing ")"', start: 0, end: 1 },
        ]);
        expect(show(missing.ast)).toBe('or(a, b)');
        const extra = parse('a) b', issues);
        expect(extra.diagnostics).toMatchObject([
            { code: 'unbalanced-paren', message: 'Unexpected ")"', start: 1 },
        ]);
        expect(show(extra.ast)).toBe('and(a, b)');
    });

    it('warns about operators with nothing to apply to', () => {
        expect(codes('OR a')).toEqual(['dangling-operator']);
        expect(codes('a OR')).toEqual(['dangling-operator']);
        expect(codes('a AND')).toEqual(['dangling-operator']);
        expect(codes('AND a')).toEqual(['dangling-operator']);
        expect(codes('a AND OR b')).toEqual(['dangling-operator']);
        expect(codes('NOT')).toEqual(['dangling-operator']);
        expect(codes('a -')).toEqual(['dangling-operator']);
        expect(tree('a - b')).toBe('and(a, b)');
        expect(codes('a - b')).toEqual(['dangling-operator']);
        expect(parse('a OR', issues).ok).toBe(true);
        expect(tree('(NOT)')).toBe('∅');
    });

    it('warns about empty groups and empty phrases', () => {
        expect(codes('a () b')).toEqual(['empty-group']);
        expect(tree('a () b')).toBe('and(a, b)');
        expect(codes('""')).toEqual(['empty-value']);
    });

    it('does not double-report a negated invalid term', () => {
        expect(codes('-status:nope')).toEqual(['invalid-value']);
        expect(tree('-status:nope a')).toBe('a');
    });

    it('rejects free text when the schema forbids it', () => {
        const schema = defineSchema({
            fields: { status: { type: 'enum', values: ['a'] } },
            text: false,
        });
        expect(codes('hello status:a', schema)).toEqual(['text-not-allowed']);
        expect(show(parse('hello status:a', schema).ast)).toBe('status eq a');
    });
});

describe('limits', () => {
    it('rejects overly long input without parsing it', () => {
        const result = parse('a'.repeat(30), issues, { maxLength: 10 });
        expect(result).toMatchObject({
            ast: null,
            ok: false,
            diagnostics: [{ code: 'too-complex', start: 10, end: 30 }],
        });
    });

    it('stops at the nesting limit without overflowing the stack', () => {
        const deep = `${'('.repeat(5000)}a${')'.repeat(5000)} b`;
        const result = parse(deep, issues, { maxLength: 20_000 });
        expect(result.diagnostics.map(d => d.code)).toEqual(['too-complex']);
        expect(show(result.ast)).toBe('b');

        const negations = parse(`${'-'.repeat(50)}a b`, issues, { maxDepth: 3 });
        expect(negations.diagnostics.map(d => d.code)).toEqual(['too-complex']);
        expect(show(negations.ast)).toBe('b');

        const groups = parse('-(-(-(-(a)))) b', issues, { maxDepth: 3 });
        expect(show(groups.ast)).toBe('b');
        expect(parse('NOT NOT NOT NOT a', issues, { maxDepth: 3 }).diagnostics).toHaveLength(1);
        const skipped = parse('NOT NOT NOT NOT (a (b)) c', issues, { maxDepth: 3 });
        expect(skipped.diagnostics.map(d => d.code)).toEqual(['too-complex']);
        expect(show(skipped.ast)).toBe('c');
    });

    it('stops counting terms and list items at the limit', () => {
        const result = parse('a b c d e', issues, { maxTerms: 3 });
        expect(result.diagnostics).toMatchObject([{ code: 'too-complex', start: 6, end: 7 }]);
        expect(show(result.ast)).toBe('and(a, b, c)');
        expect(show(parse('status:open,closed,merged', issues, { maxTerms: 2 }).ast)).toBe(
            'status in [open, closed]'
        );
    });
});

describe('schema guard', () => {
    it('rejects anything that is not a schema', () => {
        expect(() => parse('a', {} as never)).toThrow(
            'Expected a schema created by defineSchema()'
        );
        expect(() => parse('a', null as never)).toThrow(TypeError);
    });
});
