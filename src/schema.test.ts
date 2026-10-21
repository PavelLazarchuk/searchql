import { describe, expect, it } from 'vitest';
import { defineSchema, describeSchema, parse } from './index';
import { issues } from './test-utils/fixtures';

describe('defineSchema', () => {
    it('freezes the schema and keeps the definition', () => {
        expect(Object.isFrozen(issues)).toBe(true);
        expect(issues.fields.status.type).toBe('enum');
        expect(issues.text).toEqual(['title']);
        expect(defineSchema({ fields: {} }).text).toEqual([]);
        expect(defineSchema({ fields: {}, text: true }).text).toBe(true);
    });

    it.each([
        [null, 'expects an object with a `fields` map'],
        [{}, 'expects an object with a `fields` map'],
        [{ fields: { a: { type: 'text' } } }, 'Field "a" needs a type'],
        [{ fields: { a: null } }, 'Field "a" needs a type'],
        [{ fields: { '1a': { type: 'string' } } }, 'Invalid name "1a"'],
        [{ fields: { 'a b': { type: 'string' } } }, 'Invalid name "a b"'],
        [
            { fields: { a: { type: 'string' }, A: { type: 'string' } } },
            'Name "A" (field "A") is already used by field "a"',
        ],
        [
            { fields: { a: { type: 'string', aliases: ['b'] }, b: { type: 'string' } } },
            'already used by alias of "a"',
        ],
        [{ fields: { a: { type: 'string', variables: ['m e'] } } }, 'invalid variable name "m e"'],
        [{ fields: { a: { type: 'enum', values: [] } } }, 'Enum field "a" has no values'],
        [{ fields: { a: { type: 'enum', values: {} } } }, 'Enum field "a" has no values'],
        [{ fields: { a: { type: 'enum', values: ['x', 'X'] } } }, 'lists "X" twice'],
        [{ fields: { a: { type: 'number', min: 2, max: 1 } } }, 'min is greater than max'],
        [
            { fields: { a: { type: 'number' } }, text: ['a'] },
            'text: "a" must be a string or enum field',
        ],
        [{ fields: {}, text: ['nope'] }, 'text: "nope" must be a string or enum field'],
        [{ fields: {}, text: 'yes' }, 'text must be a boolean or a list of field names'],
        [
            { fields: { is: { type: 'string' } }, shortcuts: { is: { a: 'is:x' } } },
            'Name "is" (shortcut "is") is already used',
        ],
        [{ fields: {}, shortcuts: { is: {} } }, 'Shortcut "is" has no values'],
        [{ fields: {}, shortcuts: { is: { a: 'x', A: 'y' } } }, 'empty or duplicate value "A"'],
        [{ fields: {}, shortcuts: { is: { ' ': 'x' } } }, 'empty or duplicate value " "'],
        [
            { fields: { a: { type: 'string' } }, shortcuts: { is: { x: 'b:1' } } },
            'Shortcut is:x expands to an invalid query "b:1": Unknown filter "b"',
        ],
        [
            { fields: {}, shortcuts: { is: { x: '' } } },
            'Shortcut is:x expands to an invalid query "": it is empty',
        ],
        [
            {
                fields: { a: { type: 'string' } },
                shortcuts: { is: { x: 'a:1' }, go: { y: 'is:x' } },
            },
            'Unknown filter "is"',
        ],
    ])('rejects %j', (definition, message) => {
        expect(() => defineSchema(definition as never)).toThrow(TypeError);
        expect(() => defineSchema(definition as never)).toThrow(message);
    });

    it('lets a field named has or no take over the keyword', () => {
        const schema = defineSchema({
            fields: { has: { type: 'string' }, x: { type: 'string', nullable: true } },
        });
        expect(parse('has:x', schema).ast).toMatchObject({ type: 'filter', field: 'has' });
        expect(parse('no:x', schema).ast).toMatchObject({
            type: 'not',
            child: { type: 'exists', field: 'x' },
        });
    });
});

describe('describeSchema', () => {
    it('writes a cheat sheet for people and LLMs', () => {
        expect(
            describeSchema(issues, { examples: ['is:open label:bug', 'author:@me created:-7d'] })
        ).toBe(
            [
                'Search syntax:',
                '- Plain words search title. Quote phrases: "exact phrase".',
                '- field:value filters by a field; field:a,b matches any of the values.',
                '- Terms separated by spaces must all match; put OR between terms to match either; group with parentheses.',
                '- A leading - excludes: -field:value, -word, -(a OR b).',
                '- Numbers and dates compare: field:>10, field:<=2026-03-01, and ranges field:10..20 (* for an open end).',
                '- Dates: 2026-03-14, 2026-03, 2026, today, yesterday, now, or relative: -7d (last 7 days), -12h, -2w, -3mo, -1y.',
                '- In text fields * at the start or end matches anything: name:jo*, email:*@example.com.',
                '- has:field / no:field test whether a field is empty (works for assignee, label, closed).',
                '',
                'Fields:',
                '- status: one of open, closed, merged. Issue state.',
                '- priority: one of low, medium, high, urgent (in this order, so it compares).',
                '- author (also: by): text, exact match, accepts @me.',
                '- assignee: text, exact match, accepts @me.',
                '- label: text, exact match, a list, matches if any item does.',
                '- title: text, matches anywhere.',
                '- comments: whole number, at least 0.',
                '- score: number.',
                '- created: date.',
                '- closed: date.',
                '- draft: true or false.',
                '- key: text, exact match, case-sensitive.',
                '',
                'Shortcuts:',
                '- is:open means status:open',
                '- is:closed means status:closed,merged',
                '- is:draft means draft:true',
                '- is:unassigned means no:assignee',
                '',
                'Examples:',
                '- is:open label:bug',
                '- author:@me created:-7d',
            ].join('\n')
        );
    });

    it('describes only what the schema uses', () => {
        const schema = defineSchema({
            fields: {
                sku: { type: 'string', match: 'prefix', wildcards: false },
                stars: { type: 'number', max: 5, description: 'Rating' },
            },
            text: false,
        });
        expect(describeSchema(schema)).toBe(
            [
                'Search syntax:',
                '- field:value filters by a field; field:a,b matches any of the values.',
                '- Terms separated by spaces must all match; put OR between terms to match either; group with parentheses.',
                '- A leading - excludes: -field:value, -word, -(a OR b).',
                '- Numbers and dates compare: field:>10, field:<=2026-03-01, and ranges field:10..20 (* for an open end).',
                '',
                'Fields:',
                '- sku: text, matches the start.',
                '- stars: number, at most 5. Rating.',
            ].join('\n')
        );
        const passThrough = defineSchema({
            fields: {
                e: { type: 'enum', values: ['a'], nullable: true },
                has: { type: 'boolean' },
            },
            text: true,
        });
        expect(describeSchema(passThrough)).toContain('- Plain words search the text.');
        expect(describeSchema(passThrough)).toContain(
            '- no:field test whether a field is empty (works for e).'
        );
    });
});
