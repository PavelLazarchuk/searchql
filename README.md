# searchql

[![npm version](https://img.shields.io/npm/v/searchql.svg)](https://www.npmjs.com/package/searchql)
[![npm downloads](https://img.shields.io/npm/dm/searchql.svg)](https://www.npmjs.com/package/searchql)

GitHub-style search syntax for your own app — `is:open label:bug,ui -author:bot created:>-7d "memory leak"` — with a typed field schema, a parser that never throws, autocomplete, filter-chip editing, and safe compilation to parameterized SQL (Postgres, MySQL, SQLite), Prisma, MongoDB or an in-memory predicate.

Every admin panel, issue tracker and log viewer ends up with a search box like this, and the hand-rolled version breaks in the same places:

- `query.split(' ')` cuts `author:"Jane Doe"` in half and has no idea what `-` or `OR` mean.
- One typo (`stauts:open`) silently returns an empty page instead of saying "did you mean status?".
- Filters get glued into SQL strings, so the search box becomes an injection point — and `-label:bug` quietly drops every row where `label` is NULL.
- The browser filters with one set of rules and the database with another, so the same query shows different results.

searchql parses once, against a schema you declare, and compiles the same meaning to every target. The SQL, Mongo and in-memory targets are checked against each other on real engines (SQLite, Postgres via PGlite, mingo) with thousands of generated queries.

- **Zero runtime dependencies**, ESM + CJS, `sideEffects: false`, TypeScript-first
- **Small**: `parse` is ~5.6 kB gzipped, everything ~13 kB; each compiler is its own subpath
- **Runs anywhere**: browsers, Node 20+, Deno, Bun, Cloudflare Workers — time zones come from `Intl`

```ts
import { defineSchema, parse } from 'searchql';
import { toSql } from 'searchql/sql';

export const issueSearch = defineSchema({
    fields: {
        status: { type: 'enum', values: ['open', 'closed', 'merged'] },
        priority: { type: 'enum', values: ['low', 'medium', 'high', 'urgent'], ordered: true },
        author: { type: 'string', aliases: ['by'], variables: ['me'] },
        assignee: { type: 'string', nullable: true, variables: ['me'] },
        label: { type: 'string', multiple: true },
        title: { type: 'string', match: 'contains' },
        comments: { type: 'number', integer: true, min: 0 },
        created: { type: 'date' },
        draft: { type: 'boolean' },
    },
    text: ['title'], // plain words search the title
    shortcuts: {
        is: { open: 'status:open', closed: 'status:closed,merged', draft: 'draft:true' },
    },
});

const result = parse(
    'is:open label:bug -author:@me priority:>=high created:>-7d leak',
    issueSearch
);

if (!result.ok) {
    // [{ code: 'unknown-field', message: 'Unknown filter "stauts"', start: 0, end: 6, suggestions: ['status'] }]
    return { errors: result.diagnostics };
}

const where = toSql(result, issueSearch, {
    dialect: 'postgres',
    variables: { me: session.userId },
    timeZone: 'Europe/Kyiv',
});
// where.sql    → ("status" = $1 AND EXISTS (SELECT 1 FROM unnest("label") AS _sq(v) WHERE LOWER(_sq.v) = LOWER($2))
//                 AND ("author" = $3) IS NOT TRUE AND "priority" IN ($4, $5) AND "created" >= $6 AND "title" ILIKE $7 ESCAPE '!')
// where.params → ['open', 'bug', 'u_123', 'high', 'urgent', 2026-10-06T12:00:00.001Z, '%leak%']
await db.query(`SELECT * FROM issues WHERE deleted_at IS NULL AND ${where.sql}`, where.params);
```

## Install

```sh
npm install searchql
```

| Import            | What it gives you                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `searchql`        | `defineSchema`, `parse`, `suggest`, `highlight`, `format`, `describeSchema`, filter editing, `toPredicate`, `lower` |
| `searchql/sql`    | `toSql` — parameterized WHERE for Postgres, MySQL, SQLite                                                           |
| `searchql/prisma` | `toPrismaWhere` — a Prisma `where` object                                                                           |
| `searchql/mongo`  | `toMongoFilter` — a MongoDB filter                                                                                  |

## The syntax

What your users type. A copy-ready reference for a help page is in [docs/syntax.md](docs/syntax.md).

| Query                                           | Meaning                                                       |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `memory leak`, `"memory leak"`                  | free text, words or an exact phrase                           |
| `status:open`, `by:alice`                       | a field (or alias) equals a value                             |
| `label:bug,ui`                                  | any of the values                                             |
| `label:bug label:ui`                            | both: terms separated by spaces must all match                |
| `status:open OR draft:true`, `(a OR b) c`       | either; `OR` binds looser than spaces; parentheses group      |
| `-label:wontfix`, `NOT draft:true`, `-(a OR b)` | exclude                                                       |
| `comments:>5`, `>=`, `<`, `<=`                  | compare numbers, dates and ordered enums                      |
| `comments:1..10`, `created:2026-01..*`          | inclusive range, `*` for an open end                          |
| `created:2026-03-14`, `2026-03`, `2026`         | a whole day, month or year                                    |
| `created:today`, `yesterday`, `now`             | relative to now, in your time zone                            |
| `created:-7d` / `created:>-7d` / `created:<-1y` | within the last 7 days / after 7 days ago / older than a year |
| `name:jo*`, `email:*@acme.com`, `title:*leak*`  | wildcards at the start or end                                 |
| `assignee:@me`                                  | a variable you fill in at compile time                        |
| `has:assignee`, `no:label`                      | the field is set / empty                                      |
| `is:open`                                       | a shortcut you define                                         |

## Schema

`defineSchema` declares what can be searched. Call it once at module level; it validates the definition and throws a `TypeError` for mistakes (duplicate names, a shortcut whose query doesn't parse), so they surface at startup rather than on a user's query.

| Field type | Options                                                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `string`   | `match: 'exact' \| 'prefix' \| 'contains'` (default `exact`), `caseSensitive` (default `false`), `wildcards` (default `true`)                 |
| `enum`     | `values: [...]` or a record mapping typed words to stored values (`{ open: 'OPEN' }`, `{ low: 1, high: 3 }`), `ordered` to allow `>` and `..` |
| `number`   | `integer`, `min`, `max`                                                                                                                       |
| `date`     | —                                                                                                                                             |
| `boolean`  | accepts `true`/`false`/`yes`/`no`                                                                                                             |

Every field also takes:

- `aliases` — other names users may type (`by` for `author`)
- `description` — shown in autocomplete and in `describeSchema()`
- `multiple` — the field is a list (tags, labels): a filter matches when any element does
- `nullable` — the field can be empty, which enables `has:` and `no:`
- `variables` — placeholders such as `@me`, resolved when you compile

Schema-level options:

- `text` — what plain words do: a list of string fields to search with `contains` (default: none), `true` to hand them to your compiler's `text` option (full-text search), or `false` to report them as errors
- `shortcuts` — named presets, GitHub's `is:` style: `{ is: { open: 'status:open', mine: 'author:@me' } }`

## Parsing

```ts
const result = parse(input, schema, { maxLength: 2000, maxDepth: 16, maxTerms: 100 });
// { input, ast, diagnostics, ok }
```

`parse` never throws on user input. Each problem becomes a diagnostic with a position, and only the broken term is dropped, so `stauts:open author:alice` still searches by author while you underline `stauts`. `ok` is `false` when there is at least one error; it's your call whether to run the rest of the query or show the errors first.

| Code                   | Severity | Example                                    |
| ---------------------- | -------- | ------------------------------------------ |
| `unknown-field`        | error    | `stauts:open` → suggests `status`          |
| `invalid-value`        | error    | `status:opn` → suggests `open`             |
| `missing-value`        | error    | `status:`                                  |
| `unsupported-operator` | error    | `author:>a`, `status:>open` (not ordered)  |
| `invalid-wildcard`     | error    | `name:a*b`                                 |
| `unknown-variable`     | error    | `author:@mee` → suggests `@me`             |
| `not-nullable`         | error    | `has:author` on a field that's never empty |
| `text-not-allowed`     | error    | free text with `text: false`               |
| `unterminated-quote`   | error    | `author:"jane`                             |
| `unbalanced-paren`     | error    | `(a OR b`, `a) b`                          |
| `too-complex`          | error    | over `maxLength`, `maxDepth` or `maxTerms` |
| `dangling-operator`    | warning  | `a OR`, `a -`                              |
| `empty-group`          | warning  | `()`                                       |
| `empty-value`          | warning  | `label:a,,b`, `""`                         |

The limits exist because the input comes from users (or a model) and ends up in your database: deep nesting can't overflow the stack, and a pasted wall of terms can't become a 10 000-clause WHERE.

## Compiling

All compilers accept a `ParseResult`, a bare tree, or `null` (match everything), and share these options:

- `now` — the moment `today` and `-7d` are relative to (default: the current time)
- `timeZone` — IANA zone for calendar dates and `today` (default `UTC`); DST-correct
- `variables` — values for `@variables`; a list matches any of its items

### In memory

```ts
import { toPredicate } from 'searchql';

const visible = issues.filter(toPredicate(result, issueSearch, { variables: { me: user.login } }));
```

Fields are read as `item[field]` (following dots in the field name), or set `fields: { author: 'user.login', comments: item => item.stats.comments }`. Dates may be `Date`s, ISO strings or epoch milliseconds. With `text: true` in the schema, free text searches every string and enum field unless you pass `text: (item, term) => boolean`.

### SQL

```ts
import { toSql } from 'searchql/sql';

const where = toSql(result, issueSearch, {
    dialect: 'postgres', // 'postgres' | 'mysql' | 'sqlite'
    columns: {
        author: 'users.login', // a (qualified) column
        comments: { column: 'comment_count' },
        title: { expression: "coalesce(title, '')" }, // trusted SQL, never user input
    },
    paramOffset: 2, // Postgres placeholders start at $3
});
```

- Every user value is a bound parameter; identifiers come only from your schema and `columns`, quoted for the dialect.
- The output is a single boolean expression, wrapped in parentheses when needed, so it's safe to append with `AND`.
- Negation uses `IS NOT TRUE`, so `-assignee:bob` keeps rows where `assignee` is NULL — the same answer the in-memory predicate gives.
- `LIKE` wildcards in user text (`%`, `_`) are escaped. Case-insensitive matching uses `ILIKE` on Postgres and `LOWER()` elsewhere; case-sensitive matching uses `GLOB` on SQLite and a binary comparison on MySQL.
- `multiple` fields map to a native array on Postgres and a JSON array on SQLite.
- Dates are bound as `Date` (Postgres, MySQL) or ISO strings (SQLite); change it with `dateValue: d => d.getTime()`.

**Join tables and anything custom.** Map a field to a function. `ctx.leaf` compiles the comparison against another column, `ctx.param` binds a value:

```ts
toSql(result, issueSearch, {
    dialect: 'postgres',
    columns: {
        label: (leaf, ctx) =>
            `EXISTS (SELECT 1 FROM issue_labels l WHERE l.issue_id = issues.id AND ${ctx.leaf(leaf, 'l.name')})`,
    },
});
```

**Full-text search.** Set `text: true` in the schema and pass `text`:

```ts
toSql(result, schema, {
    dialect: 'postgres',
    text: (term, ctx) => `search_vector @@ websearch_to_tsquery('english', ${ctx.param(term)})`,
});
```

**Query builders.** Besides `sql` and `params`, the result has `strings`: the same SQL split around its parameters and shaped like a template literal's strings (with `raw`), for `sql` tags that take `(strings, ...values)` and bind the values themselves — Drizzle, Kysely and postgres.js work this way:

```ts
import { sql } from 'drizzle-orm';

const where = toSql(result, issueSearch, { dialect: 'postgres' });
db.select()
    .from(issues)
    .where(sql(where.strings, ...where.params));
```

### Prisma

```ts
import { toPrismaWhere } from 'searchql/prisma';

const where = toPrismaWhere(result, issueSearch, {
    fields: {
        author: 'author.login', // to-one relation path
        label: (leaf, ctx) => ({ labels: { some: ctx.leaf(leaf, 'name') } }), // to-many relation
    },
    insensitiveMode: true, // `mode: 'insensitive'`; set false on MySQL, SQLite, SQL Server
});
await prisma.issue.findMany({ where });
```

Negating a filter on a `nullable` field also keeps rows where it's null (`{ OR: [{ NOT: … }, { field: null }] }`), matching the other targets. Prisma scalar lists only support exact, case-sensitive values (`has`, `hasSome`); map anything else to a relation with a function.

### MongoDB

```ts
import { toMongoFilter } from 'searchql/mongo';

await db
    .collection('issues')
    .find(toMongoFilter(result, issueSearch, { fields: { author: 'user.login' } }));
```

Values are always wrapped in an operator (`$eq`, `$in`, an escaped `$regex`), so typed input can't inject operators. Negation is `$nor`, which matches missing fields too.

### Your own target

`lower(result, schema, options)` returns the query reduced to primitive comparisons in negation normal form — `compare`, `in`, `match`, `exists`, `text`, joined by `and` / `or`, with `not` only around leaves. The built-in compilers are short modules on top of it; Elasticsearch, Drizzle operators or Kysely expression builders fit the same shape.

## Search box UI

These are framework-agnostic: they take the input string and return data, so they work with React, Vue, Svelte or a plain `<input>`.

### Autocomplete

```ts
import { suggest } from 'searchql';

const { from, to, context, items } = suggest(input, cursor, issueSearch, {
    values: { label: knownLabels }, // values for string fields
});
// accept item: input.slice(0, from) + item.insert + input.slice(to)
```

`items` holds fields (with aliases ranked), shortcuts, `has:`/`no:`, enum values, booleans, date presets, variables and your `values` — already-picked list items are skipped. `context` says where the cursor is (`field`, `value` with its `field` and `prefix`, `shortcut`, `exists`), which is what you need to fetch more values from the server.

### Highlighting

```ts
import { highlight } from 'searchql';

highlight('-status:opn by:@me', issueSearch);
// [{ start: 0, end: 1, kind: 'negation', error: false },
//  { start: 1, end: 7, kind: 'field', error: false }, … { start: 8, end: 11, kind: 'value', error: true }, …]
```

The tokens cover every character, so rendering `input.slice(start, end)` per token in a mirror element reproduces the input with colours and squiggles for errors. Pass an existing `ParseResult` as the third argument to avoid parsing twice.

### Filter chips and facets

```ts
import { getFilters, setFilter, toggleFilter, removeFilter, addFilter, hasFilter } from 'searchql';

getFilters('leak label:bug,ui -by:bot', issueSearch);
// [{ kind: 'filter', field: 'label', negated: false, op: 'in', values: ['bug', 'ui'], text: 'label:bug,ui', span }, …]

toggleFilter('leak label:bug', issueSearch, 'label', 'ui'); // 'leak label:bug,ui'
toggleFilter('leak label:bug,ui', issueSearch, 'label', 'BUG'); // 'leak label:ui'
setFilter('leak status:open', issueSearch, 'status', ['closed', 'merged']); // 'leak status:closed,merged'
setFilter('a OR b', issueSearch, 'status', 'open'); // '(a OR b) status:open'
removeFilter('label:bug -label:ui leak', issueSearch, 'label'); // 'leak'
```

Edits work on the string the user sees and keep everything else byte for byte, so a chip bar, facet checkboxes and the text box stay one source of truth — which also makes the query string the natural thing to keep in the URL. Values are compared by meaning: `BUG` matches `bug` in a case-insensitive field, `OPEN` matches the enum `open`.

### Canonical form

`format(result)` writes the tree back with canonical names, minimal quotes and single spaces (`BY:alice  Status:OPEN` → `author:alice status:open`). Parsing it gives the same tree, so it works as a cache key or a clean URL.

## LLMs

Letting a model write SQL for "show me urgent bugs from last week" is an injection risk you can't review. Let it write a search query instead:

```ts
import { describeSchema, parse } from 'searchql';

const system = `Translate the request into a search query.\n\n${describeSchema(issueSearch)}`;
const query = await llm(system, 'urgent bugs from last week that nobody picked up');
// 'label:bug priority:urgent created:-7d no:assignee'

const result = parse(query, issueSearch);
if (!result.ok) retryWith(result.diagnostics); // precise, positioned feedback for a retry
```

`describeSchema` writes a plain-text cheat sheet — the syntax, every field with its type and accepted values, the shortcuts and your examples — that works as a help popover too. The model's output goes through the same schema, validation and limits as a person's, and the user can see and edit it in the search box.

## Semantics

The same rules hold in every target:

- Spaces mean AND, `OR` binds looser, `-` and `NOT` bind tightest.
- A list (`a,b`) matches any of its values. On `multiple` fields a filter matches when any element does.
- A negated filter matches rows where the field is empty. A comparison never matches an empty field.
- A date is a period: `created:2026-03` is all of March, `>2026-03` starts in April, `<=2026-03` ends with March. A relative date alone (`-7d`) means between then and now.
- String matching is case-insensitive unless the field says otherwise; enum values are matched case-insensitively and stored as you declared them.

Known differences between engines: SQLite's `LOWER()` and `LIKE` fold ASCII letters only, and MySQL compares by collation. Text with non-ASCII letters can match case-insensitively in memory and on Postgres but not on SQLite.

## Errors

User input never throws. Compilers throw `SearchqlError` (with a `code`) for problems in your setup: a `@variable` without a value (`missing-variable`), a construct a target can't express such as a list column on MySQL without a column function (`unsupported`), or bad options (`invalid-option`). An invalid `timeZone` throws the `RangeError` from `Intl`.

## Alternatives

| Package               | Syntax              | Schema & typo hints | Error positions, no throw | Autocomplete & chips | Targets                            |
| --------------------- | ------------------- | ------------------- | ------------------------- | -------------------- | ---------------------------------- |
| **searchql**          | GitHub/Gmail-style  | yes                 | yes                       | yes                  | SQL ×3, Prisma, MongoDB, memory    |
| `liqe`                | Lucene-style        | no                  | throws `SyntaxError`      | no                   | memory                             |
| `search-query-parser` | keywords and ranges | no                  | —                         | no                   | a plain object (last release 2022) |

## License

MIT
