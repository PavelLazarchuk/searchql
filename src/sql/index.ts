import { SearchqlError } from '../errors';
import { lower, type LowerOptions, type LoweredLeaf, type LoweredNode } from '../lower';
import { getField } from '../schema';
import type { FieldName, QueryInput, Schema } from '../types';

export type SqlDialect = 'postgres' | 'mysql' | 'sqlite';

export interface SqlColumn {
    readonly column?: string;
    readonly expression?: string;
    readonly array?: boolean;
}

export type SqlLeaf = Exclude<LoweredLeaf, { type: 'text' }>;

export interface SqlContext {
    readonly dialect: SqlDialect;
    param(value: unknown): string;
    identifier(name: string): string;
    leaf(leaf: SqlLeaf, target: string | SqlColumn): string;
}

export type SqlColumnMapping = string | SqlColumn | ((leaf: SqlLeaf, ctx: SqlContext) => string);

export interface SqlOptions<S extends Schema = Schema> extends LowerOptions<S> {
    readonly dialect: SqlDialect;
    readonly columns?: Partial<Record<FieldName<S>, SqlColumnMapping>>;
    readonly text?: (term: string, ctx: SqlContext) => string;
    readonly paramOffset?: number;
    readonly dateValue?: (date: Date) => unknown;
}

export interface SqlResult {
    readonly sql: string;
    readonly params: unknown[];
    readonly strings: TemplateStringsArray;
}

const DIALECTS = new Set<SqlDialect>(['postgres', 'mysql', 'sqlite']);

const OPERATORS = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;

const SWAPPED = { eq: '=', gt: '<', gte: '<=', lt: '>', lte: '>=' } as const;

const MARK = '\u0000';

export function toSql<S extends Schema>(
    query: QueryInput,
    schema: S,
    options: SqlOptions<S>
): SqlResult {
    const dialect = options?.dialect;
    if (!DIALECTS.has(dialect)) {
        throw new SearchqlError(
            'invalid-option',
            'toSql() needs `dialect`: postgres, mysql or sqlite'
        );
    }
    const tree = lower(query, schema, options);
    const params: unknown[] = [];
    const columns = (options.columns ?? {}) as Record<string, SqlColumnMapping | undefined>;
    const dateValue =
        options.dateValue ??
        (dialect === 'sqlite' ? (date: Date) => date.toISOString() : (date: Date) => date);

    const context: SqlContext = {
        dialect,
        param(value) {
            let bound = value;
            if (value instanceof Date) bound = dateValue(value);
            else if (typeof value === 'boolean' && dialect === 'sqlite') bound = value ? 1 : 0;
            params.push(bound);
            return `${MARK}${params.length - 1}${MARK}`;
        },
        identifier: name => quoteIdentifier(dialect, name),
        leaf: (leaf, target) => leafAt(leaf, toTarget(target, false)),
    };

    const toTarget = (mapping: string | SqlColumn, multiple: boolean): Target => {
        if (typeof mapping === 'string')
            return { expr: context.identifier(mapping), array: multiple };
        const expr =
            mapping.expression ??
            (mapping.column === undefined ? undefined : context.identifier(mapping.column));
        if (expr === undefined) {
            throw new SearchqlError(
                'invalid-option',
                'A column mapping needs `column` or `expression`'
            );
        }
        return { expr, array: mapping.array ?? multiple };
    };

    const leafAt = (leaf: SqlLeaf, target: Target): string => {
        if (!target.array) return scalarLeaf(leaf, target.expr, context);
        return arrayLeaf(leaf, target.expr, context);
    };

    const compileLeaf = (leaf: LoweredLeaf): string => {
        if (leaf.type === 'text') {
            if (!options.text) {
                throw new SearchqlError(
                    'unsupported',
                    'Free-text terms need `text` fields in the schema or a `text` option in toSql()'
                );
            }
            return options.text(leaf.value, context);
        }
        const mapping = columns[leaf.field];
        if (typeof mapping === 'function') return mapping(leaf, context);
        return leafAt(leaf, fieldTarget(leaf.field, mapping));
    };

    const fieldTarget = (field: string, mapping: string | SqlColumn | undefined): Target =>
        toTarget(mapping ?? field, getField(schema, field).multiple === true);

    const compile = (node: LoweredNode): string => {
        switch (node.type) {
            case 'const':
                return node.value ? 'TRUE' : 'FALSE';
            case 'and':
            case 'or':
                return node.children
                    .map(child =>
                        child.type === 'and' || child.type === 'or'
                            ? `(${compile(child)})`
                            : compile(child)
                    )
                    .join(node.type === 'and' ? ' AND ' : ' OR ');
            case 'not': {
                const child = node.child;
                const mapping = child.type === 'exists' ? columns[child.field] : undefined;
                if (child.type === 'exists' && typeof mapping !== 'function') {
                    const target = fieldTarget(child.field, mapping);
                    if (!target.array) return `${target.expr} IS NULL`;
                }
                return `(${compileLeaf(child)}) IS NOT TRUE`;
            }
            default:
                return compileLeaf(node);
        }
    };

    const marked = tree.type === 'and' || tree.type === 'or' ? `(${compile(tree)})` : compile(tree);
    const offset = options.paramOffset ?? 0;
    const parts = marked.split(MARK);
    const strings: string[] = [];
    const ordered: unknown[] = [];
    let sql = '';
    for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) {
            strings.push(parts[i]!);
            sql += parts[i];
        } else {
            ordered.push(params[Number(parts[i])]);
            sql += dialect === 'postgres' ? `$${offset + ordered.length}` : '?';
        }
    }
    return { sql, params: ordered, strings: templateStrings(strings) };
}

interface Target {
    readonly expr: string;
    readonly array: boolean;
}

function scalarLeaf(leaf: SqlLeaf, expr: string, ctx: SqlContext): string {
    switch (leaf.type) {
        case 'exists':
            return `${expr} IS NOT NULL`;
        case 'compare':
            return `${expr} ${OPERATORS[leaf.op]} ${ctx.param(leaf.value)}`;
        case 'in':
            return `${expr} IN (${leaf.values.map(value => ctx.param(value)).join(', ')})`;
        case 'match':
            return matchSql(leaf, expr, ctx);
    }
}

function matchSql(
    leaf: Extract<SqlLeaf, { type: 'match' }>,
    expr: string,
    ctx: SqlContext
): string {
    const { dialect } = ctx;
    if (leaf.mode === 'exact') {
        if (!leaf.caseSensitive) return `LOWER(${expr}) = LOWER(${ctx.param(leaf.value)})`;
        return dialect === 'mysql'
            ? `${expr} = CAST(${ctx.param(leaf.value)} AS BINARY)`
            : `${expr} = ${ctx.param(leaf.value)}`;
    }
    if (dialect === 'sqlite' && leaf.caseSensitive) {
        return `${expr} GLOB ${ctx.param(wrap(leaf.mode, escapeGlob(leaf.value), '*'))}`;
    }
    const pattern = ctx.param(wrap(leaf.mode, escapeLike(leaf.value), '%'));
    if (dialect === 'postgres') {
        return `${expr} ${leaf.caseSensitive ? 'LIKE' : 'ILIKE'} ${pattern} ESCAPE '!'`;
    }
    if (leaf.caseSensitive) return `${expr} LIKE CAST(${pattern} AS BINARY) ESCAPE '!'`;
    return `LOWER(${expr}) LIKE LOWER(${pattern}) ESCAPE '!'`;
}

function arrayLeaf(leaf: SqlLeaf, expr: string, ctx: SqlContext): string {
    if (ctx.dialect === 'mysql') {
        throw new SearchqlError(
            'unsupported',
            'List columns are supported for postgres and sqlite; for MySQL map the field to a function in `columns`'
        );
    }
    if (ctx.dialect === 'postgres') {
        if (leaf.type === 'exists') return `cardinality(${expr}) > 0`;
        if (leaf.type === 'compare')
            return `${ctx.param(leaf.value)} ${SWAPPED[leaf.op]} ANY(${expr})`;
        return `EXISTS (SELECT 1 FROM unnest(${expr}) AS _sq(v) WHERE ${scalarLeaf(leaf, '_sq.v', ctx)})`;
    }
    if (leaf.type === 'exists') return `json_array_length(${expr}) > 0`;
    return `EXISTS (SELECT 1 FROM json_each(${expr}) AS _sq WHERE ${scalarLeaf(leaf, '_sq.value', ctx)})`;
}

function wrap(mode: 'prefix' | 'suffix' | 'contains', value: string, any: string): string {
    if (mode === 'prefix') return `${value}${any}`;
    if (mode === 'suffix') return `${any}${value}`;
    return `${any}${value}${any}`;
}

function escapeLike(value: string): string {
    return value.replace(/[!%_]/g, '!$&');
}

function escapeGlob(value: string): string {
    return value.replace(/[*?[]/g, '[$&]');
}

function quoteIdentifier(dialect: SqlDialect, name: string): string {
    const quote = dialect === 'mysql' ? '`' : '"';
    return name
        .split('.')
        .map(part => {
            if (part === '') {
                throw new SearchqlError('invalid-option', `Invalid column name "${name}"`);
            }
            return quote + part.split(quote).join(quote + quote) + quote;
        })
        .join('.');
}

function templateStrings(strings: string[]): TemplateStringsArray {
    return Object.freeze(
        Object.assign([...strings], { raw: Object.freeze([...strings]) })
    ) as TemplateStringsArray;
}
