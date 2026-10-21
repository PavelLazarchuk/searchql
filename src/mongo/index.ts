import { SearchqlError } from '../errors';
import { lower, type LowerOptions, type LoweredLeaf, type LoweredNode } from '../lower';
import { getField } from '../schema';
import type { FieldName, QueryInput, Schema } from '../types';

export type MongoFilter = Record<string, unknown>;

export type MongoLeaf = Exclude<LoweredLeaf, { type: 'text' }>;

export interface MongoContext {
    leaf(leaf: MongoLeaf, path: string): MongoFilter;
}

export type MongoFieldMapping = string | ((leaf: MongoLeaf, ctx: MongoContext) => MongoFilter);

export interface MongoOptions<S extends Schema = Schema> extends LowerOptions<S> {
    readonly fields?: Partial<Record<FieldName<S>, MongoFieldMapping>>;
    readonly text?: (term: string) => MongoFilter;
}

const MATCH_NOTHING: MongoFilter = { $nor: [{}] };

export function toMongoFilter<S extends Schema>(
    query: QueryInput,
    schema: S,
    options: MongoOptions<S> = {}
): MongoFilter {
    const tree = lower(query, schema, options);
    const fields = (options.fields ?? {}) as Record<string, MongoFieldMapping | undefined>;
    const context: MongoContext = { leaf: (leaf, path) => leafAt(leaf, path, false) };

    const compileLeaf = (leaf: LoweredLeaf): MongoFilter => {
        if (leaf.type === 'text') {
            if (!options.text) {
                throw new SearchqlError(
                    'unsupported',
                    'Free-text terms need `text` fields in the schema or a `text` option in toMongoFilter()'
                );
            }
            return options.text(leaf.value);
        }
        const multiple = getField(schema, leaf.field).multiple === true;
        const mapping = fields[leaf.field];
        if (typeof mapping === 'function') return mapping(leaf, context);
        return leafAt(leaf, mapping ?? leaf.field, multiple);
    };

    const compile = (node: LoweredNode): MongoFilter => {
        switch (node.type) {
            case 'const':
                return node.value ? {} : MATCH_NOTHING;
            case 'and':
                return { $and: node.children.map(compile) };
            case 'or':
                return { $or: node.children.map(compile) };
            case 'not':
                return { $nor: [compileLeaf(node.child)] };
            default:
                return compileLeaf(node);
        }
    };

    return compile(tree);
}

function leafAt(leaf: MongoLeaf, path: string, multiple: boolean): MongoFilter {
    switch (leaf.type) {
        case 'exists':
            return multiple ? { [`${path}.0`]: { $exists: true } } : { [path]: { $ne: null } };
        case 'compare':
            return { [path]: { [`$${leaf.op}`]: leaf.value } };
        case 'in':
            return { [path]: { $in: [...leaf.values] } };
        case 'match': {
            if (leaf.mode === 'exact' && leaf.caseSensitive) return { [path]: { $eq: leaf.value } };
            const escaped = escapeRegex(leaf.value);
            const pattern =
                leaf.mode === 'exact'
                    ? `^${escaped}$`
                    : leaf.mode === 'prefix'
                      ? `^${escaped}`
                      : leaf.mode === 'suffix'
                        ? `${escaped}$`
                        : escaped;
            return {
                [path]: leaf.caseSensitive
                    ? { $regex: pattern }
                    : { $regex: pattern, $options: 'i' },
            };
        }
    }
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}
