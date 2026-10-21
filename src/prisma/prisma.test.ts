import { describe, expect, it } from 'vitest';
import { SearchqlError, defineSchema, parse } from '../index';
import { NOW } from '../test-utils/dataset';
import { issues } from '../test-utils/fixtures';
import { toPrismaWhere } from './index';

const labels = {
    label: (leaf: never, ctx: { leaf: (l: never, p: string) => object }) => ({
        labels: { some: ctx.leaf(leaf, 'name') },
    }),
};
const where = (input: string, extra = {}) =>
    toPrismaWhere(parse(input, issues), issues, {
        now: NOW,
        variables: { me: 'u1' },
        fields: labels as never,
        ...extra,
    });

describe('toPrismaWhere', () => {
    it('matches everything or nothing with constants', () => {
        expect(where('')).toEqual({});
        expect(where('priority:>urgent')).toEqual({ OR: [] });
    });

    it('compiles comparisons, lists and ranges', () => {
        expect(where('status:open comments:>1 score:1..2 priority:>=high')).toEqual({
            AND: [
                { status: { equals: 'open' } },
                { comments: { gt: 1 } },
                { score: { gte: 1 } },
                { score: { lte: 2 } },
                { priority: { in: ['high', 'urgent'] } },
            ],
        });
        expect(where('status:open,closed')).toEqual({
            OR: [{ status: { equals: 'open' } }, { status: { equals: 'closed' } }],
        });
        expect(where('created:2026-10-13')).toEqual({
            AND: [
                { created: { gte: new Date('2026-10-13T00:00:00Z') } },
                { created: { lt: new Date('2026-10-14T00:00:00Z') } },
            ],
        });
    });

    it('maps string match modes, with insensitive mode by default', () => {
        expect(where('author:Al* title:leak author:*ce author:bob key:A*')).toEqual({
            AND: [
                { author: { startsWith: 'Al', mode: 'insensitive' } },
                { title: { contains: 'leak', mode: 'insensitive' } },
                { author: { endsWith: 'ce', mode: 'insensitive' } },
                { author: { equals: 'bob', mode: 'insensitive' } },
                { key: { startsWith: 'A' } },
            ],
        });
        expect(where('author:bob', { insensitiveMode: false })).toEqual({
            author: { equals: 'bob' },
        });
    });

    it('keeps null rows when a nullable field is negated', () => {
        expect(where('-assignee:bob')).toEqual({
            OR: [{ NOT: { assignee: { equals: 'bob', mode: 'insensitive' } } }, { assignee: null }],
        });
        expect(where('-author:bob')).toEqual({
            NOT: { author: { equals: 'bob', mode: 'insensitive' } },
        });
        expect(where('has:assignee')).toEqual({ assignee: { not: null } });
        expect(where('no:assignee')).toEqual({ assignee: null });
    });

    it('nests dotted paths through to-one relations', () => {
        expect(where('author:bob', { fields: { author: 'author.login' } })).toEqual({
            author: { login: { equals: 'bob', mode: 'insensitive' } },
        });
        expect(where('-assignee:bob', { fields: { assignee: 'assignee.login' } })).toEqual({
            OR: [
                { NOT: { assignee: { login: { equals: 'bob', mode: 'insensitive' } } } },
                { assignee: { login: null } },
            ],
        });
    });

    it('compiles to-many relations through a field function', () => {
        expect(where('label:bug -label:ui')).toEqual({
            AND: [
                { labels: { some: { name: { equals: 'bug', mode: 'insensitive' } } } },
                { NOT: { labels: { some: { name: { equals: 'ui', mode: 'insensitive' } } } } },
            ],
        });
        expect(where('has:label')).toEqual({ labels: { some: { name: { not: null } } } });
    });

    it('supports scalar lists for exact values', () => {
        const schema = defineSchema({
            fields: {
                tags: { type: 'string', multiple: true, caseSensitive: true },
                ids: { type: 'number', multiple: true },
            },
        });
        const run = (q: string) => toPrismaWhere(parse(q, schema), schema);
        expect(run('tags:a')).toEqual({ tags: { has: 'a' } });
        expect(run('-tags:a')).toEqual({ NOT: { tags: { has: 'a' } } });
        expect(run('ids:1')).toEqual({ ids: { has: 1 } });
        expect(run('has:tags')).toEqual({ tags: { isEmpty: false } });
        expect(run('no:tags')).toEqual({ tags: { isEmpty: true } });
        expect(() => run('tags:a*')).toThrow(SearchqlError);
        expect(() => run('ids:>1')).toThrow(/scalar lists/);
        expect(() => toPrismaWhere(parse('label:bug', issues), issues)).toThrow(/scalar lists/);
    });

    it('resolves variables, including lists, to `in`', () => {
        expect(where('author:@me')).toEqual({ author: { equals: 'u1' } });
        expect(where('author:@me', { variables: { me: ['u1', 'u2'] } })).toEqual({
            author: { in: ['u1', 'u2'] },
        });
    });

    it('needs a text option for pass-through free text', () => {
        const schema = defineSchema({ fields: { title: { type: 'string' } }, text: true });
        expect(() => toPrismaWhere(parse('hi', schema), schema)).toThrow(/text/);
        const result = toPrismaWhere(parse('hi -bye', schema), schema, {
            text: term => ({ body: { search: term } }),
        });
        expect(result).toEqual({
            AND: [{ body: { search: 'hi' } }, { NOT: { body: { search: 'bye' } } }],
        });
    });
});
