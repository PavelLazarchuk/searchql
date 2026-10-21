import { describe, expect, it } from 'vitest';
import { defineSchema, parse, toPredicate } from './index';
import { ISSUES, NOW, type Issue } from './test-utils/dataset';
import { issues } from './test-utils/fixtures';

const ids = (input: string, options = {}) => {
    const test = toPredicate<typeof issues, Issue>(parse(input, issues), issues, {
        now: NOW,
        variables: { me: 'alice' },
        ...options,
    });
    return ISSUES.filter(test).map(issue => issue.id);
};

describe('toPredicate', () => {
    it('matches everything for an empty query', () => {
        expect(ids('')).toHaveLength(ISSUES.length);
    });

    it('matches list fields when any element matches', () => {
        expect(ids('label:bug')).toEqual([1, 4, 6, 7]);
        expect(ids('label:bug label:ui')).toEqual([1]);
        expect(ids('label:p*')).toEqual([3, 8]);
    });

    it('keeps empty values when a filter is negated', () => {
        expect(ids('-assignee:bob')).not.toContain(1);
        expect(ids('-assignee:bob')).toContain(2);
        expect(ids('has:assignee')).toEqual([1, 3, 4, 6, 7, 8, 10]);
        expect(ids('no:label')).toEqual([2, 9]);
    });

    it('reads dates stored as Date, ISO strings or epoch numbers', () => {
        const items = [
            { id: 1, created: new Date('2026-10-13T00:00:00Z') },
            { id: 2, created: '2026-10-13T05:00:00Z' },
            { id: 3, created: Date.parse('2026-10-13T23:00:00Z') },
            { id: 4, created: '2026-10-12' },
            { id: 5, created: 'garbage' },
            { id: 6, created: null },
            { id: 7, created: true },
        ];
        const test = toPredicate(parse('created:2026-10-13', issues), issues, { now: NOW });
        expect(items.filter(test).map(item => item.id)).toEqual([1, 2, 3]);
    });

    it('never matches a comparison across types', () => {
        const test = toPredicate(parse('comments:5', issues), issues);
        expect([{ comments: '5' }, { comments: 5 }, { comments: [5] }, {}].map(test)).toEqual([
            false,
            true,
            true,
            false,
        ]);
        const strings = toPredicate(parse('author:5', issues), issues);
        expect(strings({ author: 5 })).toBe(false);
    });

    it('reads fields through paths and functions', () => {
        const items = [
            { id: 1, user: { login: 'alice' }, meta: { count: 3 } },
            { id: 2, user: null, meta: { count: 9 } },
            { id: 3 },
        ];
        const test = toPredicate<typeof issues, (typeof items)[number]>(
            parse('author:alice OR comments:>5', issues),
            issues,
            {
                fields: { author: 'user.login', comments: item => item.meta?.count },
            }
        );
        expect(items.filter(test).map(item => item.id)).toEqual([1, 2]);
        const dotted = toPredicate(
            parse('author:x', defineSchema({ fields: { author: { type: 'string' } } })),
            defineSchema({
                fields: { 'user.name': { type: 'string' }, author: { type: 'string' } },
            })
        );
        expect(dotted({ author: 'x' })).toBe(true);
        expect(toPredicate(parse('author:x', issues), issues)(null as never)).toBe(false);
    });

    it('follows dots in field names by default', () => {
        const schema = defineSchema({ fields: { 'user.name': { type: 'string' } } });
        const test = toPredicate(parse('user.name:ann', schema), schema);
        expect(test({ user: { name: 'Ann' } })).toBe(true);
        expect(test({ user: undefined })).toBe(false);
    });

    it('searches every string and enum field for text by default', () => {
        const schema = defineSchema({
            fields: {
                title: { type: 'string' },
                state: { type: 'enum', values: ['open'] },
                n: { type: 'number' },
            },
            text: true,
        });
        const test = toPredicate(parse('OPE', schema), schema);
        expect(test({ title: 'x', state: 'open' })).toBe(true);
        expect(test({ title: ['nope', 'reopen'] })).toBe(true);
        expect(test({ title: 'x', n: 'open' })).toBe(false);
        const custom = toPredicate(parse('hello', schema), schema, {
            text: (item: { body: string }, term) => item.body === term,
        });
        expect(custom({ body: 'hello' })).toBe(true);
    });

    it('respects case sensitivity and match modes', () => {
        expect(ids('key:app-2')).toEqual([2]);
        expect(ids('key:APP-2')).toEqual([]);
        expect(ids('key:*-1')).toEqual([1]);
        expect(ids('title:LIST')).toEqual([1, 8]);
        expect(ids('author:ALICE')).toEqual([1, 5, 10]);
        expect(ids('author:*O*')).toEqual([2, 3, 7, 8]);
        expect(ids('title:"\\"quotes\\""')).toEqual([6]);
    });

    it('resolves enum values to their stored form', () => {
        const schema = defineSchema({
            fields: { state: { type: 'enum', values: { open: 'OPEN', done: 'DONE' } } },
        });
        const test = toPredicate(parse('state:open', schema), schema);
        expect([{ state: 'OPEN' }, { state: 'open' }].map(test)).toEqual([true, false]);
    });

    it('compares booleans and numbers', () => {
        expect(ids('draft:true')).toEqual([4, 8]);
        expect(ids('score:>=7.25')).toEqual([5, 6, 7]);
        expect(ids('score:<0')).toEqual([3]);
    });
});
