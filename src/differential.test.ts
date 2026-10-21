import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { format, parse, toPredicate } from './index';
import { toMongoFilter } from './mongo';
import { toSql } from './sql';
import { ISSUES, NOW, type Issue } from './test-utils/dataset';
import { createPostgres, createSqlite, runMongo } from './test-utils/engines';
import { issues } from './test-utils/fixtures';

const options = { now: NOW, variables: { me: 'alice' } };

const op = fc.constantFrom('', '>', '>=', '<', '<=');
const date = fc.constantFrom(
    '2026',
    '2026-10',
    '2026-10-13',
    '2026-10-06',
    '2026-03-14T10:00',
    '2026-10-12T12:00:00Z',
    'today',
    'yesterday',
    'now',
    '-1h',
    '-7d',
    '-30d',
    '-1mo',
    '-1y',
    '+1d'
);
const word = (values: string[]) => fc.constantFrom(...values);

const atom: fc.Arbitrary<string> = fc.oneof(
    fc.tuple(word(['open', 'closed', 'merged', 'OPEN'])).map(([v]) => `status:${v}`),
    fc.subarray(['open', 'closed', 'merged'], { minLength: 2 }).map(vs => `status:${vs.join(',')}`),
    fc.tuple(op, word(['low', 'medium', 'high', 'urgent'])).map(([o, v]) => `priority:${o}${v}`),
    fc
        .tuple(word(['low', 'medium', '*']), word(['high', 'urgent', '*']))
        .filter(([a, b]) => a !== '*' || b !== '*')
        .map(([a, b]) => `priority:${a}..${b}`),
    word(['alice', 'BOB', 'carol', 'al*', '*ce', '*o*', '@me', 'mallory']).map(v => `author:${v}`),
    word(['bob', 'ALICE', '@me', 'c*', 'nobody']).map(v => `assignee:${v}`),
    word(['bug', 'UI', 'perf', 'b*', '*f', '*o*', 'bug,docs', 'nope']).map(v => `label:${v}`),
    word([
        'list',
        'LEAK',
        '100%',
        '100%*',
        'snake_case',
        '*_*',
        'wow!',
        '"star*search"',
        '*"\\"quotes\\""*',
        'path_to\\file',
    ]).map(v => `title:${v}`),
    word(['APP-1', 'app-2', 'APP*', 'app*', '*-1', '*P-*', 'APP-1,SEC-7']).map(v => `key:${v}`),
    fc.tuple(op, fc.integer({ min: 0, max: 21 })).map(([o, n]) => `comments:${o}${n}`),
    fc
        .tuple(word(['0', '2', '*']), word(['5', '12', '*']))
        .filter(([a, b]) => a !== '*' || b !== '*')
        .map(([a, b]) => `comments:${a}..${b}`),
    fc.tuple(op, word(['-1.5', '0', '2', '3.5', '7.25', '10'])).map(([o, n]) => `score:${o}${n}`),
    fc.tuple(op, date).map(([o, d]) => `created:${o}${d}`),
    fc.tuple(date, date).map(([a, b]) => `created:${a}..${b}`),
    fc.tuple(op, date).map(([o, d]) => `closed:${o}${d}`),
    word(['true', 'false', 'yes']).map(v => `draft:${v}`),
    word(['open', 'closed', 'draft', 'unassigned', 'open,draft']).map(v => `is:${v}`),
    word(['assignee', 'label', 'closed']).map(v => `has:${v}`),
    word(['assignee', 'label', 'closed']).map(v => `no:${v}`),
    word(['list', 'leak', '"memory leak"', 'CPU', 'mode', 'zzz'])
);

const query: fc.Arbitrary<string> = fc.letrec<{ node: string }>(tie => ({
    node: fc.oneof(
        { depthSize: 'small', withCrossShrink: true },
        atom,
        tie('node').map(q => `-(${q})`),
        atom.map(q => `-${q}`),
        tie('node').map(q => `NOT (${q})`),
        fc.array(tie('node'), { minLength: 2, maxLength: 3 }).map(qs => qs.join(' ')),
        fc.array(tie('node'), { minLength: 2, maxLength: 3 }).map(qs => `(${qs.join(' OR ')})`)
    ),
})).node;

let postgres: (sql: string, params: unknown[]) => Promise<number[]>;
let sqlite: (sql: string, params: unknown[]) => number[];

beforeAll(async () => {
    sqlite = createSqlite(ISSUES);
    postgres = await createPostgres(ISSUES);
});

const reference = (input: string): number[] => {
    const result = parse(input, issues);
    expect(result.diagnostics).toEqual([]);
    const test = toPredicate<typeof issues, Issue>(result, issues, options);
    return ISSUES.filter(test).map(row => row.id);
};

describe('every target selects the same rows as the predicate', () => {
    it('on generated queries', async () => {
        await fc.assert(
            fc.asyncProperty(query, async input => {
                const expected = reference(input);
                const result = parse(input, issues);

                const lite = toSql(result, issues, { dialect: 'sqlite', ...options });
                expect(sqlite(lite.sql, lite.params), `sqlite: ${input}\n${lite.sql}`).toEqual(
                    expected
                );

                const pg = toSql(result, issues, { dialect: 'postgres', ...options });
                expect(await postgres(pg.sql, pg.params), `postgres: ${input}\n${pg.sql}`).toEqual(
                    expected
                );

                const mongo = toMongoFilter(result, issues, options);
                expect(runMongo(ISSUES, mongo), `mongo: ${input}`).toEqual(expected);

                expect(reference(format(result)), `format: ${format(result)}`).toEqual(expected);
            }),
            { numRuns: 300 }
        );
    }, 120_000);

    it.each([
        ['status:open', [1, 4, 5, 7, 9]],
        ['-label:bug', [2, 3, 5, 8, 9, 10]],
        ['no:label', [2, 9]],
        ['is:unassigned', [2, 5, 9]],
        ['-assignee:bob', [2, 3, 4, 5, 6, 8, 9, 10]],
        ['created:-7d', [1, 2, 7]],
        ['created:2026-10', [1, 2, 3, 7, 10]],
        ['created:>2026-10-06', [1, 2, 7]],
        ['created:<=2026-10-05', [3, 4, 5, 6, 8, 9]],
        ['priority:>=high', [1, 3, 6, 7]],
        ['title:100%', [2]],
        ['title:*_*', [3, 9]],
        ['key:APP*', [1, 3, 5, 6, 8, 10]],
        ['author:@me', [1, 5, 10]],
        ['leak OR crash', [1, 6]],
        ['comments:..3', [2, 3, 5, 8, 9]],
    ])('%s', async (input, ids) => {
        expect(reference(input)).toEqual(ids);
        const lite = toSql(parse(input, issues), issues, { dialect: 'sqlite', ...options });
        expect(sqlite(lite.sql, lite.params)).toEqual(ids);
        const pg = toSql(parse(input, issues), issues, { dialect: 'postgres', ...options });
        expect(await postgres(pg.sql, pg.params)).toEqual(ids);
        expect(runMongo(ISSUES, toMongoFilter(parse(input, issues), issues, options))).toEqual(ids);
    });
});
