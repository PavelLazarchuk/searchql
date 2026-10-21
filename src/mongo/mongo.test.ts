import { Query } from 'mingo';
import { describe, expect, it } from 'vitest';
import { defineSchema, parse } from '../index';
import { NOW } from '../test-utils/dataset';
import { issues } from '../test-utils/fixtures';
import { toMongoFilter } from './index';

const filter = (input: string, extra = {}) =>
    toMongoFilter(parse(input, issues), issues, { now: NOW, variables: { me: 'u1' }, ...extra });

describe('toMongoFilter', () => {
    it('matches everything or nothing with constants', () => {
        expect(filter('')).toEqual({});
        expect(filter('priority:>urgent')).toEqual({ $nor: [{}] });
    });

    it('wraps every value in an operator', () => {
        expect(filter('status:open comments:>=2 key:APP-1 priority:>=high')).toEqual({
            $and: [
                { status: { $eq: 'open' } },
                { comments: { $gte: 2 } },
                { key: { $eq: 'APP-1' } },
                { priority: { $in: ['high', 'urgent'] } },
            ],
        });
    });

    it('escapes regular expressions for string matches', () => {
        expect(filter('author:a.b author:a* title:"(x)?" key:*-1')).toEqual({
            $and: [
                { author: { $regex: '^a\\.b$', $options: 'i' } },
                { author: { $regex: '^a', $options: 'i' } },
                { title: { $regex: '\\(x\\)\\?', $options: 'i' } },
                { key: { $regex: '\\-1$' } },
            ],
        });
        const injected = filter('author:"(.*)|$where"');
        expect(new Query(injected).test({ author: 'anything' })).toBe(false);
        expect(new Query(injected).test({ author: '(.*)|$where' })).toBe(true);
    });

    it('negates with $nor and tests emptiness', () => {
        expect(filter('-assignee:bob')).toEqual({
            $nor: [{ assignee: { $regex: '^bob$', $options: 'i' } }],
        });
        expect(filter('has:assignee no:label')).toEqual({
            $and: [{ assignee: { $ne: null } }, { $nor: [{ 'label.0': { $exists: true } }] }],
        });
    });

    it('maps fields to paths and functions', () => {
        expect(filter('author:bob', { fields: { author: 'user.login' } })).toEqual({
            'user.login': { $regex: '^bob$', $options: 'i' },
        });
        const result = filter('label:bug', {
            fields: {
                label: (leaf: never, ctx: { leaf: (l: never, p: string) => object }) => ({
                    labels: { $elemMatch: ctx.leaf(leaf, 'name') },
                }),
            },
        });
        expect(result).toEqual({
            labels: { $elemMatch: { name: { $regex: '^bug$', $options: 'i' } } },
        });
        const docs = [{ labels: [{ name: 'Bug' }] }, { labels: [{ name: 'ui' }] }];
        expect(docs.filter(doc => new Query(result).test(doc))).toHaveLength(1);
    });

    it('resolves dates to Date objects', () => {
        expect(filter('created:<2026-10-13')).toEqual({
            created: { $lt: new Date('2026-10-13T00:00:00Z') },
        });
    });

    it('needs a text option for pass-through free text', () => {
        const schema = defineSchema({ fields: { title: { type: 'string' } }, text: true });
        expect(() => toMongoFilter(parse('hi', schema), schema)).toThrow(/text/);
        expect(
            toMongoFilter(parse('hi', schema), schema, {
                text: term => ({ $text: { $search: term } }),
            })
        ).toEqual({
            $text: { $search: 'hi' },
        });
    });
});
