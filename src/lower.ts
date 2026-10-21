import { assertTimeZone, resolveDate } from './date';
import { SearchqlError } from './errors';
import { enumKeys, enumStoredValue, getField, internals } from './schema';
import type {
    ComparisonOperator,
    EnumField,
    FieldDefinition,
    FilterNode,
    QueryInput,
    QueryNode,
    Schema,
    Value,
    VariableName,
} from './types';

export type Primitive = string | number | boolean | Date;

export type LoweredLeaf =
    | {
          readonly type: 'compare';
          readonly field: string;
          readonly op: ComparisonOperator;
          readonly value: Primitive;
      }
    | { readonly type: 'in'; readonly field: string; readonly values: readonly Primitive[] }
    | {
          readonly type: 'match';
          readonly field: string;
          readonly mode: 'exact' | 'prefix' | 'suffix' | 'contains';
          readonly value: string;
          readonly caseSensitive: boolean;
      }
    | { readonly type: 'exists'; readonly field: string }
    | { readonly type: 'text'; readonly value: string };

export type LoweredNode =
    | LoweredLeaf
    | { readonly type: 'not'; readonly child: LoweredLeaf }
    | { readonly type: 'and'; readonly children: readonly LoweredNode[] }
    | { readonly type: 'or'; readonly children: readonly LoweredNode[] }
    | { readonly type: 'const'; readonly value: boolean };

export interface LowerOptions<S extends Schema = Schema> {
    readonly now?: Date | number;
    readonly timeZone?: string;
    readonly variables?: Partial<Record<VariableName<S>, Primitive | readonly Primitive[]>>;
}

export function lower<S extends Schema>(
    query: QueryInput,
    schema: S,
    options: LowerOptions<S> = {}
): LoweredNode {
    internals(schema);
    const now = options.now === undefined ? Date.now() : +options.now;
    if (!Number.isFinite(now)) {
        throw new SearchqlError('invalid-option', '`now` is not a valid date');
    }
    const timeZone = options.timeZone ?? 'UTC';
    assertTimeZone(timeZone);
    const context: Context = {
        schema,
        now,
        timeZone,
        variables: (options.variables ?? {}) as Record<
            string,
            Primitive | readonly Primitive[] | undefined
        >,
    };
    const ast = astOf(query);
    return ast ? lowerNode(ast, context) : { type: 'const', value: true };
}

export function astOf(query: QueryInput): QueryNode | null {
    if (query === null || query === undefined) return null;
    if ('diagnostics' in query) return query.ast;
    return query;
}

interface Context {
    readonly schema: Schema;
    readonly now: number;
    readonly timeZone: string;
    readonly variables: Record<string, Primitive | readonly Primitive[] | undefined>;
}

function lowerNode(node: QueryNode, context: Context): LoweredNode {
    switch (node.type) {
        case 'and':
            return all(node.children.map(child => lowerNode(child, context)));
        case 'or':
            return any(node.children.map(child => lowerNode(child, context)));
        case 'not':
            return negate(lowerNode(node.child, context));
        case 'shortcut':
            return lowerNode(node.expansion, context);
        case 'exists':
            getField(context.schema, node.field);
            return { type: 'exists', field: node.field };
        case 'text':
            return lowerText(node.value, context.schema);
        case 'filter':
            return lowerFilter(node, getField(context.schema, node.field), context);
    }
}

function lowerText(value: string, schema: Schema): LoweredNode {
    if (!Array.isArray(schema.text)) return { type: 'text', value };
    return any(
        (schema.text as readonly string[]).map(field => ({
            type: 'match' as const,
            field,
            mode: 'contains' as const,
            value,
            caseSensitive: isCaseSensitive(schema.fields[field]!),
        }))
    );
}

function lowerFilter(node: FilterNode, field: FieldDefinition, context: Context): LoweredNode {
    const name = node.field;
    switch (node.op) {
        case 'in':
            return any(node.values.map(value => lowerEquals(name, field, value, context)));
        case 'eq':
            return lowerEquals(name, field, node.value, context);
        case 'range': {
            if (field.type === 'enum') {
                const keys = enumKeys(field);
                const position = (value: Value | null, fallback: number): number =>
                    value?.kind === 'enum' ? keys.indexOf(value.value) : fallback;
                const selected = keys.slice(
                    position(node.min, 0),
                    position(node.max, keys.length - 1) + 1
                );
                return selected.length === 0
                    ? { type: 'const', value: false }
                    : {
                          type: 'in',
                          field: name,
                          values: selected.map(key => enumStoredValue(field, key)),
                      };
            }
            const parts: LoweredNode[] = [];
            if (node.min) parts.push(lowerCompare(name, field, 'gte', node.min, context));
            if (node.max) parts.push(lowerCompare(name, field, 'lte', node.max, context));
            return all(parts);
        }
        default:
            return lowerCompare(name, field, node.op, node.value, context);
    }
}

function lowerEquals(
    name: string,
    field: FieldDefinition,
    value: Value,
    context: Context
): LoweredNode {
    switch (value.kind) {
        case 'variable':
            return lowerVariable(name, value.name, context);
        case 'string':
            return {
                type: 'match',
                field: name,
                mode:
                    value.wildcard ??
                    (field.type === 'string' ? (field.match ?? 'exact') : 'exact'),
                value: value.value,
                caseSensitive: isCaseSensitive(field),
            };
        case 'date': {
            if (value.value.type === 'relative') {
                const at = resolveDate(value.value, context.now, context.timeZone).start;
                const [from, to] = at <= context.now ? [at, context.now] : [context.now, at];
                return all([
                    { type: 'compare', field: name, op: 'gte', value: new Date(from) },
                    { type: 'compare', field: name, op: 'lte', value: new Date(to) },
                ]);
            }
            const { start, end } = resolveDate(value.value, context.now, context.timeZone);
            return all([
                { type: 'compare', field: name, op: 'gte', value: new Date(start) },
                { type: 'compare', field: name, op: 'lt', value: new Date(end) },
            ]);
        }
        default:
            return { type: 'compare', field: name, op: 'eq', value: storedValue(field, value) };
    }
}

function lowerCompare(
    name: string,
    field: FieldDefinition,
    op: Exclude<ComparisonOperator, 'eq'>,
    value: Value,
    context: Context
): LoweredNode {
    if (value.kind === 'date') {
        const { start, end } = resolveDate(value.value, context.now, context.timeZone);
        const bound =
            op === 'gt'
                ? ['gte', end]
                : op === 'gte'
                  ? ['gte', start]
                  : op === 'lt'
                    ? ['lt', start]
                    : ['lt', end];
        return {
            type: 'compare',
            field: name,
            op: bound[0] as ComparisonOperator,
            value: new Date(bound[1] as number),
        };
    }
    if (value.kind === 'enum' && field.type === 'enum') {
        const keys = enumKeys(field);
        const index = keys.indexOf(value.value);
        const selected = keys.filter((_, i) =>
            op === 'gt'
                ? i > index
                : op === 'gte'
                  ? i >= index
                  : op === 'lt'
                    ? i < index
                    : i <= index
        );
        if (selected.length === 0) return { type: 'const', value: false };
        return {
            type: 'in',
            field: name,
            values: selected.map(key => enumStoredValue(field, key)),
        };
    }
    return { type: 'compare', field: name, op, value: storedValue(field, value) };
}

function lowerVariable(name: string, variable: string, context: Context): LoweredNode {
    const value = context.variables[variable];
    if (value === undefined || value === null) {
        throw new SearchqlError(
            'missing-variable',
            `The query uses @${variable}, but no value was passed in options.variables.${variable}`
        );
    }
    if (Array.isArray(value)) {
        return value.length === 0
            ? { type: 'const', value: false }
            : { type: 'in', field: name, values: value };
    }
    return { type: 'compare', field: name, op: 'eq', value: value as Primitive };
}

function storedValue(field: FieldDefinition, value: Value): Primitive {
    switch (value.kind) {
        case 'enum':
            return enumStoredValue(field as EnumField, value.value);
        case 'number':
        case 'boolean':
        case 'string':
            return value.value;
        default:
            /* c8 ignore next */
            throw new SearchqlError('unsupported', `Unexpected ${value.kind} value`);
    }
}

function isCaseSensitive(field: FieldDefinition): boolean {
    return field.type === 'string' && field.caseSensitive === true;
}

function all(children: LoweredNode[]): LoweredNode {
    return junction('and', children);
}

function any(children: LoweredNode[]): LoweredNode {
    return junction('or', children);
}

function junction(type: 'and' | 'or', children: readonly LoweredNode[]): LoweredNode {
    const neutral = type === 'and';
    const flat: LoweredNode[] = [];
    for (const child of children) {
        if (child.type === 'const') {
            if (child.value === neutral) continue;
            return child;
        }
        if (child.type === type) flat.push(...child.children);
        else flat.push(child);
    }
    if (flat.length === 0) return { type: 'const', value: neutral };
    if (flat.length === 1) return flat[0]!;
    return { type, children: flat };
}

function negate(node: LoweredNode): LoweredNode {
    switch (node.type) {
        case 'const':
            return { type: 'const', value: !node.value };
        case 'not':
            return node.child;
        case 'and':
            return junction('or', node.children.map(negate));
        case 'or':
            return junction('and', node.children.map(negate));
        default:
            return { type: 'not', child: node };
    }
}
