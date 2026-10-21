import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esm = {
    core: await import('../dist/index.js'),
    sql: await import('../dist/sql/index.js'),
    prisma: await import('../dist/prisma/index.js'),
    mongo: await import('../dist/mongo/index.js'),
};
const cjs = {
    core: require('../dist/index.cjs'),
    sql: require('../dist/sql/index.cjs'),
    prisma: require('../dist/prisma/index.cjs'),
    mongo: require('../dist/mongo/index.cjs'),
};

for (const [format, { core, sql, prisma, mongo }] of Object.entries({ esm, cjs })) {
    const schema = core.defineSchema({
        fields: {
            status: { type: 'enum', values: ['open', 'closed'] },
            author: { type: 'string', variables: ['me'] },
            created: { type: 'date' },
        },
    });
    const result = core.parse('status:open -author:bob created:>2026-01-01', schema);
    assert.equal(result.ok, true, format);
    assert.equal(core.format(result), 'status:open -author:bob created:>2026-01-01', format);

    const where = sql.toSql(result, schema, { dialect: 'postgres' });
    assert.equal(
        where.sql,
        '("status" = $1 AND (LOWER("author") = LOWER($2)) IS NOT TRUE AND "created" >= $3)',
        format
    );
    assert.deepEqual(prisma.toPrismaWhere(result, schema).AND.length, 3, format);
    assert.deepEqual(mongo.toMongoFilter(result, schema).$and.length, 3, format);

    const test = core.toPredicate(result, schema);
    assert.equal(test({ status: 'open', author: 'alice', created: '2026-02-01' }), true, format);

    assert.throws(
        () => sql.toSql(core.parse('author:@me', schema), schema, { dialect: 'sqlite' }),
        error => error instanceof core.SearchqlError && error.code === 'missing-variable',
        format
    );
    assert.equal(core.suggest('sta', 3, schema).items[0].insert, 'status:', format);
}

console.log(`dist smoke test passed on Node ${process.versions.node}`);
