import { NAME_PATTERN, canBeEmpty, enumKeys, internals, isRangeable } from './schema';
import {
    indexOfUnquoted,
    quoteIfNeeded,
    scan,
    splitUnquoted,
    unquote,
    type WordToken,
} from './scan';
import type { FieldDefinition, FieldName, Schema } from './types';

export interface Suggestion {
    readonly label: string;
    readonly insert: string;
    readonly kind: 'field' | 'shortcut' | 'keyword' | 'value' | 'variable';
    readonly detail?: string;
}

export type SuggestContext =
    | { readonly kind: 'field'; readonly prefix: string }
    | { readonly kind: 'value'; readonly field: string; readonly prefix: string }
    | { readonly kind: 'shortcut'; readonly name: string; readonly prefix: string }
    | { readonly kind: 'exists'; readonly prefix: string }
    | { readonly kind: 'none' };

export interface SuggestResult {
    readonly from: number;
    readonly to: number;
    readonly context: SuggestContext;
    readonly items: readonly Suggestion[];
}

export interface SuggestOptions<S extends Schema = Schema> {
    readonly values?: Partial<Record<FieldName<S>, readonly string[]>>;
    readonly limit?: number;
}

const DATE_SUGGESTIONS: readonly [string, string][] = [
    ['today', 'today'],
    ['yesterday', 'yesterday'],
    ['-7d', 'within the last 7 days'],
    ['-30d', 'within the last 30 days'],
    ['-1y', 'within the last year'],
];

const NAME_PREFIX = /^[A-Za-z_][A-Za-z0-9_.-]*$|^$/;

export function suggest<S extends Schema>(
    input: string,
    cursor: number,
    schema: S,
    options: SuggestOptions<S> = {}
): SuggestResult {
    internals(schema);
    const at = Math.max(
        0,
        Math.min(Number.isFinite(cursor) ? Math.trunc(cursor) : input.length, input.length)
    );
    const limit = options.limit ?? 20;
    const word = scan(input).find(
        (token): token is WordToken => token.type === 'word' && token.start < at && at <= token.end
    );

    if (!word) {
        return {
            from: at,
            to: at,
            context: { kind: 'field', prefix: '' },
            items: fieldItems(schema, '', limit),
        };
    }

    const colon = word.text.startsWith('"') ? -1 : indexOfUnquoted(word.text, ':');
    const offset = at - word.start;

    if (colon < 0 || offset <= colon) {
        const prefix = word.text.slice(0, offset);
        if (!NAME_PREFIX.test(prefix) || ['AND', 'OR', 'NOT'].includes(word.text)) return none(at);
        return {
            from: word.start,
            to: colon < 0 ? word.end : word.start + colon + 1,
            context: { kind: 'field', prefix },
            items: fieldItems(schema, prefix, limit),
        };
    }

    const name = word.text.slice(0, colon);
    if (!NAME_PATTERN.test(name)) return none(at);
    return valueSuggestions(schema, options, name, word, colon, at, limit);
}

function none(at: number): SuggestResult {
    return { from: at, to: at, context: { kind: 'none' }, items: [] };
}

function valueSuggestions<S extends Schema>(
    schema: S,
    options: SuggestOptions<S>,
    typed: string,
    word: WordToken,
    colon: number,
    at: number,
    limit: number
): SuggestResult {
    const lookup = internals(schema);
    const key = typed.toLowerCase();
    const field = lookup.fieldLookup.get(key);
    const shortcut = field === undefined ? lookup.shortcutLookup.get(key) : undefined;
    const exists =
        field === undefined &&
        shortcut === undefined &&
        ((key === 'has' && lookup.hasKeyword) || (key === 'no' && lookup.noKeyword));
    if (field === undefined && shortcut === undefined && !exists) return none(at);

    let valueStart = word.start + colon + 1;
    let raw = word.text.slice(colon + 1);
    const operator = field === undefined ? undefined : /^(?:>=|<=|>|<)/.exec(raw)?.[0];
    if (operator) {
        valueStart += operator.length;
        raw = raw.slice(operator.length);
    }

    const pieces = splitUnquoted(raw, ',');
    const piece =
        pieces.find(
            p => valueStart + p.offset <= at && at <= valueStart + p.offset + p.text.length
        ) ?? pieces[pieces.length - 1]!;
    let from = valueStart + piece.offset;
    const to = from + piece.text.length;
    let text = piece.text.slice(0, at - from);

    const range =
        field !== undefined && isRangeable(schema.fields[field]!)
            ? indexOfUnquoted(piece.text, '..')
            : -1;
    if (range >= 0 && at - from >= range + 2) {
        from += range + 2;
        text = text.slice(range + 2);
    }
    const prefix = unquote(text);
    const others = new Set(pieces.filter(p => p !== piece).map(p => unquote(p.text).toLowerCase()));
    const fresh = (value: string): boolean => !others.has(value.toLowerCase());

    if (shortcut !== undefined) {
        const presets = schema.shortcuts[shortcut]!;
        const items = rank(
            Object.keys(presets)
                .filter(fresh)
                .map(value => ({
                    label: value,
                    insert: quoteIfNeeded(value),
                    kind: 'value' as const,
                    detail: presets[value],
                })),
            prefix,
            limit
        );
        return { from, to, context: { kind: 'shortcut', name: shortcut, prefix }, items };
    }

    if (exists) {
        const items = rank(
            Object.keys(schema.fields)
                .filter(name => canBeEmpty(schema.fields[name]!) && fresh(name))
                .map(name => ({
                    label: name,
                    insert: name,
                    kind: 'field' as const,
                    ...describe(schema.fields[name]!),
                })),
            prefix,
            limit
        );
        return { from, to, context: { kind: 'exists', prefix }, items };
    }

    const definition = schema.fields[field!]!;
    const known =
        ((options.values ?? {}) as Record<string, readonly string[] | undefined>)[field!] ?? [];
    const items = rank(
        [
            ...(definition.variables ?? []).map(variable => ({
                label: `@${variable}`,
                insert: `@${variable}`,
                kind: 'variable' as const,
            })),
            ...valuesFor(definition, known)
                .filter(([value]) => fresh(value))
                .map(([value, detail]) => ({
                    label: value,
                    insert: quoteIfNeeded(value),
                    kind: 'value' as const,
                    ...(detail ? { detail } : {}),
                })),
        ],
        prefix,
        limit
    );
    return { from, to, context: { kind: 'value', field: field!, prefix }, items };
}

function valuesFor(field: FieldDefinition, known: readonly string[]): [string, string?][] {
    switch (field.type) {
        case 'enum':
            return enumKeys(field).map(key => [key]);
        case 'boolean':
            return [['true'], ['false']];
        case 'date':
            return DATE_SUGGESTIONS.map(([value, detail]) => [value, detail]);
        default:
            return known.map(value => [value]);
    }
}

function fieldItems(schema: Schema, prefix: string, limit: number): Suggestion[] {
    const lookup = internals(schema);
    const items: (Suggestion & { aliases?: readonly string[] })[] = Object.entries(
        schema.fields
    ).map(([name, field]) => ({
        label: name,
        insert: `${name}:`,
        kind: 'field',
        aliases: field.aliases,
        ...describe(field),
    }));
    for (const [name, presets] of Object.entries(schema.shortcuts)) {
        items.push({
            label: name,
            insert: `${name}:`,
            kind: 'shortcut',
            detail: Object.keys(presets).join(', '),
        });
    }
    if (Object.values(schema.fields).some(canBeEmpty)) {
        if (lookup.hasKeyword)
            items.push({
                label: 'has',
                insert: 'has:',
                kind: 'keyword',
                detail: 'field is not empty',
            });
        if (lookup.noKeyword)
            items.push({ label: 'no', insert: 'no:', kind: 'keyword', detail: 'field is empty' });
    }
    return rank(items, prefix, limit).map(item => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { aliases: _aliases, ...rest } = item as Suggestion & { aliases?: readonly string[] };
        return rest;
    });
}

function describe(field: FieldDefinition): { detail: string } {
    if (field.description) return { detail: field.description };
    if (field.type === 'enum') return { detail: enumKeys(field).join(', ') };
    return { detail: field.multiple ? `${field.type} list` : field.type };
}

function rank<T extends Suggestion & { aliases?: readonly string[] }>(
    items: T[],
    prefix: string,
    limit: number
): T[] {
    const needle = prefix.toLowerCase();
    if (needle === '') return items.slice(0, limit);
    const scored: { item: T; score: number; index: number }[] = [];
    items.forEach((item, index) => {
        const label = item.label.toLowerCase();
        let score = -1;
        if (label.startsWith(needle)) score = 0;
        else if (item.aliases?.some(alias => alias.toLowerCase().startsWith(needle))) score = 1;
        else if (label.includes(needle)) score = 2;
        else if (isSubsequence(needle, label)) score = 3;
        if (score >= 0) scored.push({ item, score, index });
    });
    return scored
        .sort((a, b) => a.score - b.score || a.index - b.index)
        .slice(0, limit)
        .map(entry => entry.item);
}

function isSubsequence(needle: string, haystack: string): boolean {
    let i = 0;
    for (const char of haystack) {
        if (char === needle[i]) i++;
        if (i === needle.length) return true;
    }
    return false;
}
