import { parse } from './parse';
import { getField, internals } from './schema';
import { indexOfUnquoted, isWhitespace, quoteIfNeeded, splitUnquoted, unquote } from './scan';
import type {
    FieldDefinition,
    FieldName,
    ParseResult,
    QueryNode,
    Schema,
    Span,
    Value,
} from './types';

export interface ActiveFilter {
    readonly kind: 'filter' | 'shortcut' | 'exists';
    readonly field: string;
    readonly negated: boolean;
    readonly op: 'eq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'range';
    readonly values: readonly string[];
    readonly text: string;
    readonly span: Span;
}

export type ComparisonText = '>' | '>=' | '<' | '<=';

export interface SetFilterOptions {
    readonly op?: ComparisonText;
    readonly negate?: boolean;
}

type FieldArgument<S extends Schema> = FieldName<S> | (string & Record<never, never>);

interface Term {
    readonly filter: ActiveFilter;
    readonly node: QueryNode;
}

export function getFilters<S extends Schema>(input: string, schema: S): ActiveFilter[] {
    return terms(input, parse(input, schema)).map(term => term.filter);
}

export function hasFilter<S extends Schema>(
    input: string,
    schema: S,
    field: FieldArgument<S>,
    value?: string,
    options: { negated?: boolean } = {}
): boolean {
    const target = resolveTarget(schema, field);
    const key = value === undefined ? undefined : valueKey(schema, target, value);
    return matching(input, schema, target, options.negated).some(
        term => key === undefined || keysOf(schema, term).includes(key)
    );
}

export function setFilter<S extends Schema>(
    input: string,
    schema: S,
    field: FieldArgument<S>,
    value: string | readonly string[] | null,
    options: SetFilterOptions = {}
): string {
    const target = resolveTarget(schema, field);
    const result = parse(input, schema);
    const op = options.op ? OPS[options.op] : undefined;
    const existing = matching(input, schema, target, options.negate === true, result).filter(
        term => (op ? term.filter.op === op : !['gt', 'gte', 'lt', 'lte'].includes(term.filter.op))
    );
    const values = value === null ? [] : typeof value === 'string' ? [value] : [...value];
    const term = values.length > 0 ? buildTerm(target.name, values, options) : null;

    if (existing.length === 0) return term ? append(input, result, term) : input;
    return applyEdits(
        input,
        existing.map((entry, index) => ({
            span: entry.filter.span,
            text: index === 0 ? term : null,
        }))
    );
}

export function addFilter<S extends Schema>(
    input: string,
    schema: S,
    field: FieldArgument<S>,
    value: string | readonly string[],
    options: SetFilterOptions = {}
): string {
    const target = resolveTarget(schema, field);
    const values = typeof value === 'string' ? [value] : [...value];
    if (values.length === 0) return input;
    return append(input, parse(input, schema), buildTerm(target.name, values, options));
}

export function removeFilter<S extends Schema>(
    input: string,
    schema: S,
    field: FieldArgument<S>,
    value?: string,
    options: { negated?: boolean } = {}
): string {
    const target = resolveTarget(schema, field);
    const existing = matching(input, schema, target, options.negated);
    if (value === undefined) {
        return applyEdits(
            input,
            existing.map(term => ({ span: term.filter.span, text: null }))
        );
    }
    const key = valueKey(schema, target, value);
    const edits: Edit[] = [];
    for (const term of existing) {
        if (!keysOf(schema, term).includes(key)) continue;

        const prefix = prefixOf(term);
        const keep = splitUnquoted(term.filter.text.slice(prefix.length), ',')
            .map(piece => piece.text)
            .filter(piece => piece !== '' && rawKey(schema, target, piece) !== key);
        edits.push({
            span: term.filter.span,
            text: keep.length > 0 ? prefix + keep.join(',') : null,
        });
    }
    return applyEdits(input, edits);
}

export function toggleFilter<S extends Schema>(
    input: string,
    schema: S,
    field: FieldArgument<S>,
    value: string,
    options: { negate?: boolean } = {}
): string {
    const negated = options.negate === true;
    if (hasFilter(input, schema, field, value, { negated })) {
        return removeFilter(input, schema, field, value, { negated });
    }
    const target = resolveTarget(schema, field);
    const list = matching(input, schema, target, negated).find(
        term => term.filter.op === 'eq' || term.filter.op === 'in'
    );
    if (!list) return addFilter(input, schema, field, value, { negate: negated });
    const end = list.filter.span.end;
    const separator = input[end - 1] === ',' ? '' : ',';
    return `${input.slice(0, end)}${separator}${quoteIfNeeded(value)}${input.slice(end)}`;
}

const OPS = { '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' } as const;

interface Target {
    readonly kind: 'filter' | 'shortcut';
    readonly name: string;
}

function resolveTarget(schema: Schema, field: string): Target {
    const lookup = internals(schema);
    const name = lookup.fieldLookup.get(String(field).toLowerCase());
    if (name !== undefined) return { kind: 'filter', name };
    const shortcut = lookup.shortcutLookup.get(String(field).toLowerCase());
    if (shortcut !== undefined) return { kind: 'shortcut', name: shortcut };
    throw new TypeError(`Unknown field "${field}"`);
}

function terms(input: string, result: ParseResult): Term[] {
    const ast = result.ast;
    const nodes = !ast ? [] : ast.type === 'and' ? ast.children : [ast];
    const out: Term[] = [];
    for (const node of nodes) {
        const filter = describe(input, node);
        if (filter) out.push({ filter, node });
    }
    return out;
}

function matching(
    input: string,
    schema: Schema,
    target: Target,
    negated: boolean | undefined,
    result: ParseResult = parse(input, schema)
): Term[] {
    return terms(input, result).filter(
        term =>
            term.filter.kind === target.kind &&
            term.filter.field === target.name &&
            (negated === undefined || term.filter.negated === negated)
    );
}

function describe(input: string, node: QueryNode): ActiveFilter | null {
    const negated = node.type === 'not';
    const inner = node.type === 'not' ? node.child : node;
    const base = { negated, text: input.slice(node.span.start, node.span.end), span: node.span };
    const raw = (value: Value | null): string =>
        value?.span ? input.slice(value.span.start, value.span.end) : '';

    switch (inner.type) {
        case 'filter':
            return {
                ...base,
                kind: 'filter',
                field: inner.field,
                op: inner.op,
                values:
                    inner.op === 'in'
                        ? inner.values.map(raw)
                        : inner.op === 'range'
                          ? [raw(inner.min), raw(inner.max)]
                          : [raw(inner.value)],
            };
        case 'shortcut':
            return {
                ...base,
                kind: 'shortcut',
                field: inner.name,
                op: inner.values.length > 1 ? 'in' : 'eq',
                values: [...inner.values],
            };
        case 'exists':
            return { ...base, kind: 'exists', field: inner.field, op: 'eq', values: [] };
        default:
            return null;
    }
}

function keysOf(schema: Schema, term: Term): string[] {
    const inner = term.node.type === 'not' ? term.node.child : term.node;
    if (inner.type === 'shortcut') return inner.values.map(value => value.toLowerCase());
    if (inner.type !== 'filter' || (inner.op !== 'eq' && inner.op !== 'in')) return [];
    const field = getField(schema, inner.field);
    const values = inner.op === 'in' ? inner.values : [inner.value];
    return values.map(value => keyOf(value, field));
}

function valueKey(schema: Schema, target: Target, value: string): string {
    if (target.kind === 'shortcut') return value.toLowerCase();
    return rawKey(schema, target, quoteIfNeeded(value));
}

function rawKey(schema: Schema, target: Target, raw: string): string {
    if (target.kind === 'shortcut') return unquote(raw).toLowerCase();
    const result = parse(`${target.name}:${raw}`, schema);
    const node = result.ast;
    if (node?.type === 'filter' && node.op === 'eq')
        return keyOf(node.value, getField(schema, target.name));
    return `\u0000${raw}`;
}

function keyOf(value: Value, field: FieldDefinition): string {
    switch (value.kind) {
        case 'string': {
            const text =
                field.type === 'string' && field.caseSensitive
                    ? value.value
                    : value.value.toLowerCase();
            return `s:${value.wildcard ?? ''}:${text}`;
        }
        case 'date':
            return `d:${JSON.stringify(value.value)}`;
        case 'variable':
            return `@${value.name}`;
        default:
            return `${value.kind[0]}:${String(value.value)}`;
    }
}

function prefixOf(term: Term): string {
    return term.filter.text.slice(0, indexOfUnquoted(term.filter.text, ':') + 1);
}

function buildTerm(name: string, values: readonly string[], options: SetFilterOptions): string {
    return `${options.negate ? '-' : ''}${name}:${options.op ?? ''}${values.map(quoteIfNeeded).join(',')}`;
}

function append(input: string, result: ParseResult, term: string): string {
    const trimmed = input.trim();
    if (trimmed === '') return term;
    if (result.ast?.type === 'or') return `(${trimmed}) ${term}`;
    return `${input.trimEnd()} ${term}`;
}

interface Edit {
    readonly span: Span;
    readonly text: string | null;
}

function applyEdits(input: string, edits: readonly Edit[]): string {
    let output = input;
    for (const edit of [...edits].sort((a, b) => b.span.start - a.span.start)) {
        let { start, end } = edit.span;
        if (edit.text === null) {
            const after = skipSpaces(output, end, 1);
            if (after > end) end = after;
            else start = skipSpaces(output, start, -1);
        }
        output = output.slice(0, start) + (edit.text ?? '') + output.slice(end);
    }
    return output;
}

function skipSpaces(text: string, from: number, direction: 1 | -1): number {
    let i = from;
    if (direction === 1) {
        while (i < text.length && isWhitespace(text[i]!)) i++;
    } else {
        while (i > 0 && isWhitespace(text[i - 1]!)) i--;
    }
    return i;
}
