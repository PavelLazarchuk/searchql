import { SearchqlError } from '../errors';
import { lower, type LowerOptions, type LoweredLeaf, type LoweredNode } from '../lower';
import { getField } from '../schema';
import type { FieldName, QueryInput, Schema } from '../types';

export type PrismaWhere = Record<string, unknown>;

export type PrismaLeaf = Exclude<LoweredLeaf, { type: 'text' }>;

export interface PrismaContext {
    leaf(leaf: PrismaLeaf, path: string): PrismaWhere;
}

export type PrismaFieldMapping = string | ((leaf: PrismaLeaf, ctx: PrismaContext) => PrismaWhere);

export interface PrismaOptions<S extends Schema = Schema> extends LowerOptions<S> {
    readonly fields?: Partial<Record<FieldName<S>, PrismaFieldMapping>>;
    readonly text?: (term: string) => PrismaWhere;
    readonly insensitiveMode?: boolean;
}

export function toPrismaWhere<S extends Schema>(
    query: QueryInput,
    schema: S,
    options: PrismaOptions<S> = {}
): PrismaWhere {
    const tree = lower(query, schema, options);
    const fields = (options.fields ?? {}) as Record<string, PrismaFieldMapping | undefined>;
    const insensitive = options.insensitiveMode !== false;

    const context: PrismaContext = {
        leaf: (leaf, path) => atPath(path, scalarCondition(leaf, insensitive)),
    };

    const compileLeaf = (leaf: LoweredLeaf, negated: boolean): PrismaWhere => {
        if (leaf.type === 'text') {
            if (!options.text) {
                throw new SearchqlError(
                    'unsupported',
                    'Free-text terms need `text` fields in the schema or a `text` option in toPrismaWhere()'
                );
            }
            const where = options.text(leaf.value);
            return negated ? { NOT: where } : where;
        }

        const field = getField(schema, leaf.field);
        const mapping = fields[leaf.field];
        if (typeof mapping === 'function') {
            const where = mapping(leaf, context);
            return negated ? { NOT: where } : where;
        }

        const path = mapping ?? leaf.field;
        if (field.multiple) {
            if (leaf.type === 'exists') return atPath(path, { isEmpty: negated });
            const where = atPath(path, listCondition(leaf, leaf.field));
            return negated ? { NOT: where } : where;
        }
        if (leaf.type === 'exists') return atPath(path, negated ? null : { not: null });

        const where = atPath(path, scalarCondition(leaf, insensitive));
        if (!negated) return where;
        return field.nullable ? { OR: [{ NOT: where }, atPath(path, null)] } : { NOT: where };
    };

    const compile = (node: LoweredNode): PrismaWhere => {
        switch (node.type) {
            case 'const':
                return node.value ? {} : { OR: [] };
            case 'and':
                return { AND: node.children.map(compile) };
            case 'or':
                return { OR: node.children.map(compile) };
            case 'not':
                return compileLeaf(node.child, true);
            default:
                return compileLeaf(node, false);
        }
    };

    return compile(tree);
}

function scalarCondition(leaf: PrismaLeaf, insensitive: boolean): unknown {
    switch (leaf.type) {
        case 'exists':
            return { not: null };
        case 'compare':
            return { [leaf.op === 'eq' ? 'equals' : leaf.op]: leaf.value };
        case 'in':
            return { in: [...leaf.values] };
        case 'match': {
            const key =
                leaf.mode === 'exact'
                    ? 'equals'
                    : leaf.mode === 'prefix'
                      ? 'startsWith'
                      : leaf.mode === 'suffix'
                        ? 'endsWith'
                        : 'contains';
            return !leaf.caseSensitive && insensitive
                ? { [key]: leaf.value, mode: 'insensitive' }
                : { [key]: leaf.value };
        }
    }
}

function listCondition(leaf: Exclude<PrismaLeaf, { type: 'exists' }>, field: string): unknown {
    if (leaf.type === 'compare' && leaf.op === 'eq') return { has: leaf.value };
    if (leaf.type === 'in') return { hasSome: [...leaf.values] };
    if (leaf.type === 'match' && leaf.mode === 'exact' && leaf.caseSensitive)
        return { has: leaf.value };
    throw new SearchqlError(
        'unsupported',
        `Prisma scalar lists can only test for exact values; map "${field}" to a function in \`fields\` ` +
            '(e.g. a relation with `some`), or make it case-sensitive with exact matching'
    );
}

function atPath(path: string, condition: unknown): PrismaWhere {
    const parts = path.split('.');
    let where: unknown = condition;
    for (let i = parts.length - 1; i >= 0; i--) {
        where = { [parts[i]!]: where };
    }
    return where as PrismaWhere;
}
