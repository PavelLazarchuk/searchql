import {
    lower,
    type LowerOptions,
    type LoweredLeaf,
    type LoweredNode,
    type Primitive,
} from './lower';
import type { FieldName, QueryInput, Schema } from './types';

export interface PredicateOptions<S extends Schema, T> extends LowerOptions<S> {
    readonly fields?: Partial<Record<FieldName<S>, string | ((item: T) => unknown)>>;
    readonly text?: (item: T, term: string) => boolean;
}

export function toPredicate<S extends Schema, T = Record<string, unknown>>(
    query: QueryInput,
    schema: S,
    options: PredicateOptions<S, T> = {}
): (item: T) => boolean {
    const tree = lower(query, schema, options);
    const getters = new Map<string, (item: T) => unknown>();
    const fieldMap = (options.fields ?? {}) as Record<
        string,
        string | ((item: T) => unknown) | undefined
    >;

    const getter = (field: string): ((item: T) => unknown) => {
        let get = getters.get(field);
        if (!get) {
            const source = fieldMap[field];
            get = typeof source === 'function' ? source : pathGetter<T>(source ?? field);
            getters.set(field, get);
        }
        return get;
    };

    const textFields = Object.keys(schema.fields).filter(name => {
        const type = schema.fields[name]!.type;
        return type === 'string' || type === 'enum';
    });
    const text =
        options.text ??
        ((item: T, term: string): boolean => {
            const needle = term.toLowerCase();
            return textFields.some(field =>
                valuesOf(getter(field)(item)).some(
                    value => typeof value === 'string' && value.toLowerCase().includes(needle)
                )
            );
        });

    const testLeaf = (leaf: LoweredLeaf, item: T): boolean => {
        if (leaf.type === 'text') return text(item, leaf.value);
        const value = getter(leaf.field)(item);
        if (leaf.type === 'exists') {
            return (
                value !== null &&
                value !== undefined &&
                !(Array.isArray(value) && value.length === 0)
            );
        }
        return valuesOf(value).some(element => testValue(leaf, element));
    };

    const test = (node: LoweredNode, item: T): boolean => {
        switch (node.type) {
            case 'const':
                return node.value;
            case 'and':
                return node.children.every(child => test(child, item));
            case 'or':
                return node.children.some(child => test(child, item));
            case 'not':
                return !testLeaf(node.child, item);
            default:
                return testLeaf(node, item);
        }
    };

    return item => test(tree, item);
}

function pathGetter<T>(path: string): (item: T) => unknown {
    const parts = path.split('.');
    if (parts.length === 1) {
        return item =>
            item === null || item === undefined
                ? undefined
                : (item as Record<string, unknown>)[path];
    }
    return item => {
        let current: unknown = item;
        for (const part of parts) {
            if (current === null || current === undefined) return undefined;
            current = (current as Record<string, unknown>)[part];
        }
        return current;
    };
}

function valuesOf(value: unknown): readonly unknown[] {
    return Array.isArray(value) ? value : [value];
}

function testValue(
    leaf: Exclude<LoweredLeaf, { type: 'text' | 'exists' }>,
    value: unknown
): boolean {
    if (value === null || value === undefined) return false;
    switch (leaf.type) {
        case 'compare':
            return compare(value, leaf.op, leaf.value);
        case 'in':
            return leaf.values.some(target => compare(value, 'eq', target));
        case 'match': {
            if (typeof value !== 'string') return false;
            const haystack = leaf.caseSensitive ? value : value.toLowerCase();
            const needle = leaf.caseSensitive ? leaf.value : leaf.value.toLowerCase();
            switch (leaf.mode) {
                case 'exact':
                    return haystack === needle;
                case 'prefix':
                    return haystack.startsWith(needle);
                case 'suffix':
                    return haystack.endsWith(needle);
                case 'contains':
                    return haystack.includes(needle);
            }
        }
    }
}

function compare(value: unknown, op: string, target: Primitive): boolean {
    let left: number | string | boolean;
    let right: number | string | boolean;
    if (target instanceof Date) {
        left = toEpoch(value);
        right = target.getTime();
        if (Number.isNaN(left)) return false;
    } else if (typeof value !== typeof target) {
        return false;
    } else {
        left = value as number | string | boolean;
        right = target;
    }
    switch (op) {
        case 'eq':
            return left === right;
        case 'gt':
            return left > right;
        case 'gte':
            return left >= right;
        case 'lt':
            return left < right;
        default:
            return left <= right;
    }
}

function toEpoch(value: unknown): number {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return Date.parse(value);
    return NaN;
}
