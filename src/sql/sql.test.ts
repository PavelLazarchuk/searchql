import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { SearchqlError, defineSchema, parse } from '../index';
import { NOW } from '../test-utils/dataset';
import { issues } from '../test-utils/fixtures';
import { toSql, type SqlDialect, type SqlOptions } from './index';

const base = { now: NOW, variables: { me: 'alice' } };
const compile = (
    input: string,
    dialect: SqlDialect = 'postgres',
    extra: Partial<SqlOptions<typeof issues>> = {}
) => toSql(parse(input, issues), issues, { dialect, ...base, ...extra });

describe('toSql output', () => {
    it('binds every value as a parameter', () => {
        expect(compile('status:open author:"x\' OR 1=1 --"')).toEqual(
            expect.objectContaining({
                sql: '("status" = $1 AND LOWER("author") = LOWER($2))',
                params: ['open', "x' OR 1=1 --"],
            })
        );
    });

    it('uses each dialect placeholder and identifier quoting', () => {
        expect(compile('status:open,closed', 'mysql').sql).toBe('(`status` = ? OR `status` = ?)');
        expect(compile('status:open,closed', 'sqlite').sql).toBe('("status" = ? OR "status" = ?)');
        expect(compile('status:open comments:>1', 'postgres', { paramOffset: 3 }).sql).toBe(
            '("status" = $4 AND "comments" > $5)'
        );
    });

    it('returns template strings for sql tags', () => {
        const { strings, params } = compile('status:open comments:>1');
        expect([...strings]).toEqual(['("status" = ', ' AND "comments" > ', ')']);
        expect(strings.raw).toEqual([...strings]);
        expect(params).toEqual(['open', 1]);
        expect(Object.isFrozen(strings)).toBe(true);
    });

    it('matches everything or nothing with constants', () => {
        expect(compile('')).toEqual(expect.objectContaining({ sql: 'TRUE', params: [] }));
        expect(compile('priority:>urgent').sql).toBe('FALSE');
    });

    it('nests groups with parentheses and wraps the whole expression', () => {
        expect(compile('status:open (comments:1 OR comments:2) -(draft:true score:1)').sql).toBe(
            '("status" = $1 AND ("comments" = $2 OR "comments" = $3) AND (("draft" = $4) IS NOT TRUE OR ("score" = $5) IS NOT TRUE))'
        );
        expect(compile('status:open').sql).toBe('"status" = $1');
    });

    it('negates with IS NOT TRUE so NULLs count as not matching', () => {
        expect(compile('-assignee:bob').sql).toBe('(LOWER("assignee") = LOWER($1)) IS NOT TRUE');
        expect(compile('no:assignee').sql).toBe('"assignee" IS NULL');
        expect(compile('has:assignee').sql).toBe('"assignee" IS NOT NULL');
    });

    it('writes pattern matches per dialect and escapes LIKE wildcards', () => {
        expect(compile('title:100%_!').sql).toBe(`"title" ILIKE $1 ESCAPE '!'`);
        expect(compile('title:100%_!').params).toEqual(['%100!%!_!!%']);
        expect(compile('title:x', 'mysql').sql).toBe("LOWER(`title`) LIKE LOWER(?) ESCAPE '!'");
        expect(compile('title:x', 'sqlite').sql).toBe(`LOWER("title") LIKE LOWER(?) ESCAPE '!'`);
        expect(compile('key:A*', 'postgres').sql).toBe(`"key" LIKE $1 ESCAPE '!'`);
        expect(compile('key:*[x]?*', 'sqlite')).toEqual(
            expect.objectContaining({ sql: '"key" GLOB ?', params: ['*[[]x][?]*'] })
        );
        expect(compile('key:*x', 'mysql').sql).toBe("`key` LIKE CAST(? AS BINARY) ESCAPE '!'");
        expect(compile('key:x', 'mysql').sql).toBe('`key` = CAST(? AS BINARY)');
        expect(compile('key:x', 'sqlite').sql).toBe('"key" = ?');
    });

    it('binds dates and booleans the way each driver expects', () => {
        expect(compile('created:>=2026-10-13 draft:true', 'postgres').params).toEqual([
            new Date('2026-10-13T00:00:00Z'),
            true,
        ]);
        expect(compile('created:>=2026-10-13 draft:true', 'sqlite').params).toEqual([
            '2026-10-13T00:00:00.000Z',
            1,
        ]);
        expect(compile('draft:false', 'sqlite').params).toEqual([0]);
        expect(
            compile('created:>=2026-10-13', 'mysql', { dateValue: (d: Date) => d.getTime() }).params
        ).toEqual([Date.parse('2026-10-13T00:00:00Z')]);
    });

    it('compiles list columns to array operators', () => {
        expect(compile('label:bug').sql).toBe(
            `EXISTS (SELECT 1 FROM unnest("label") AS _sq(v) WHERE LOWER(_sq.v) = LOWER($1))`
        );
        expect(compile('has:label').sql).toBe('cardinality("label") > 0');
        expect(compile('no:label').sql).toBe('(cardinality("label") > 0) IS NOT TRUE');
        expect(compile('label:bug', 'sqlite').sql).toBe(
            `EXISTS (SELECT 1 FROM json_each("label") AS _sq WHERE LOWER(_sq.value) = LOWER(?))`
        );
        expect(compile('has:label', 'sqlite').sql).toBe('json_array_length("label") > 0');
        expect(() => compile('label:bug', 'mysql')).toThrow(SearchqlError);
    });

    it('maps fields to columns and expressions', () => {
        const result = compile('author:alice comments:>1 label:bug', 'postgres', {
            columns: {
                author: 'u.login',
                comments: { column: 'i.comment_count' },
                label: { expression: 'i."tags"', array: true },
            },
        });
        expect(result.sql).toBe(
            `(LOWER("u"."login") = LOWER($1) AND "i"."comment_count" > $2 AND EXISTS (SELECT 1 FROM unnest(i."tags") AS _sq(v) WHERE LOWER(_sq.v) = LOWER($3)))`
        );
        expect(compile('author:x', 'mysql', { columns: { author: 'we`ird' } }).sql).toBe(
            'LOWER(`we``ird`) = LOWER(?)'
        );
        expect(compile('author:x', 'postgres', { columns: { author: 'we"ird' } }).sql).toBe(
            'LOWER("we""ird") = LOWER($1)'
        );
        expect(
            compile('label:bug', 'postgres', {
                columns: { label: { column: 'label', array: false } },
            }).sql
        ).toBe('LOWER("label") = LOWER($1)');
    });

    it('lets a column function build SQL with the helpers', () => {
        const result = compile('label:bug -label:ui', 'postgres', {
            columns: {
                label: (leaf, ctx) =>
                    `EXISTS (SELECT 1 FROM ${ctx.identifier('issue_labels')} l WHERE l.issue_id = issues.id AND ${ctx.leaf(leaf, 'l.name')})`,
            },
        });
        expect(result.sql).toBe(
            '(EXISTS (SELECT 1 FROM "issue_labels" l WHERE l.issue_id = issues.id AND LOWER("l"."name") = LOWER($1)) AND ' +
                '(EXISTS (SELECT 1 FROM "issue_labels" l WHERE l.issue_id = issues.id AND LOWER("l"."name") = LOWER($2))) IS NOT TRUE)'
        );
        expect(result.params).toEqual(['bug', 'ui']);
        const nested = compile('no:label', 'postgres', {
            columns: { label: (leaf, ctx) => ctx.leaf(leaf, { column: 'tags', array: true }) },
        });
        expect(nested.sql).toBe('(cardinality("tags") > 0) IS NOT TRUE');
    });

    it('keeps only the parameters a fragment uses, in order', () => {
        const result = compile('author:a', 'postgres', {
            columns: {
                author: (_leaf, ctx) => (ctx.param('unused'), `${ctx.param(1)} = ${ctx.param(2)}`),
            },
        });
        expect(result).toEqual(expect.objectContaining({ sql: '$1 = $2', params: [1, 2] }));
    });

    it('needs a text option for pass-through free text', () => {
        const schema = defineSchema({ fields: { title: { type: 'string' } }, text: true });
        expect(() => toSql(parse('hello', schema), schema, { dialect: 'postgres' })).toThrow(
            /text/
        );
        const result = toSql(parse('hello -world', schema), schema, {
            dialect: 'postgres',
            text: (term, ctx) => `search @@ plainto_tsquery(${ctx.param(term)})`,
        });
        expect(result.sql).toBe(
            '(search @@ plainto_tsquery($1) AND (search @@ plainto_tsquery($2)) IS NOT TRUE)'
        );
    });

    it('rejects bad options', () => {
        expect(() => toSql(null, issues, {} as never)).toThrow('toSql() needs `dialect`');
        expect(() => toSql(null, issues, undefined as never)).toThrow(SearchqlError);
        expect(() => compile('author:x', 'postgres', { columns: { author: {} } })).toThrow(
            'needs `column` or `expression`'
        );
        expect(() => compile('author:x', 'postgres', { columns: { author: 'a..b' } })).toThrow(
            'Invalid column name'
        );
        expect(() => compile('author:@me', 'postgres', { variables: {} })).toThrow(SearchqlError);
    });
});

describe('toSql on real engines', () => {
    it('handles join tables in Postgres', async () => {
        const db = new PGlite();
        await db.exec(`
            CREATE TABLE issues (id int PRIMARY KEY, title text);
            CREATE TABLE issue_labels (issue_id int, name text);
            INSERT INTO issues VALUES (1, 'a'), (2, 'b'), (3, 'c');
            INSERT INTO issue_labels VALUES (1, 'bug'), (1, 'ui'), (2, 'Bug');
        `);
        const schema = defineSchema({ fields: { label: { type: 'string', multiple: true } } });
        const where = toSql(parse('label:bug -label:ui', schema), schema, {
            dialect: 'postgres',
            columns: {
                label: (leaf, ctx) =>
                    `EXISTS (SELECT 1 FROM issue_labels l WHERE l.issue_id = issues.id AND ${ctx.leaf(leaf, 'l.name')})`,
            },
        });
        const rows = await db.query<{ id: number }>(
            `SELECT id FROM issues WHERE ${where.sql} ORDER BY id`,
            where.params
        );
        expect(rows.rows.map(r => r.id)).toEqual([2]);
    });

    it('filters dates in a time zone in SQLite', () => {
        const db = new DatabaseSync(':memory:');
        db.exec(`CREATE TABLE t (id INTEGER, created TEXT)`);
        const insert = db.prepare('INSERT INTO t VALUES (?, ?)');
        insert.run(1, '2026-10-12T20:59:59.000Z');
        insert.run(2, '2026-10-12T21:00:00.000Z');
        insert.run(3, '2026-10-13T20:59:59.999Z');
        insert.run(4, '2026-10-13T21:00:00.000Z');
        const where = toSql(parse('created:today', issues), issues, {
            dialect: 'sqlite',
            now: NOW,
            timeZone: 'Europe/Kyiv',
        });
        const rows = db
            .prepare(`SELECT id FROM t WHERE ${where.sql}`)
            .all(...(where.params as never[]));
        expect(rows.map(r => (r as { id: number }).id)).toEqual([2, 3]);
    });
});
