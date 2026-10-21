import { parse } from './parse';
import { NAME_PATTERN, internals, isRangeable } from './schema';
import { indexOfUnquoted, scan, splitUnquoted } from './scan';
import type { ParseOptions, ParseResult, Schema } from './types';

export type HighlightKind =
    | 'whitespace'
    | 'text'
    | 'field'
    | 'operator'
    | 'value'
    | 'punctuation'
    | 'keyword'
    | 'negation'
    | 'paren';

export interface HighlightToken {
    readonly start: number;
    readonly end: number;
    readonly kind: HighlightKind;
    readonly error: boolean;
}

export function highlight(
    input: string,
    schema: Schema,
    options?: ParseOptions | ParseResult
): HighlightToken[] {
    internals(schema);
    const result = options && 'diagnostics' in options ? options : parse(input, schema, options);
    const errors = result.diagnostics.filter(d => d.severity === 'error');
    const pieces: { start: number; end: number; kind: HighlightKind }[] = [];
    const push = (start: number, end: number, kind: HighlightKind): void => {
        if (end > start) pieces.push({ start, end, kind });
    };

    for (const token of scan(input)) {
        switch (token.type) {
            case 'ws':
                push(token.start, token.end, 'whitespace');
                break;
            case 'lparen':
            case 'rparen':
                push(token.start, token.end, 'paren');
                break;
            case 'minus':
                push(token.start, token.end, 'negation');
                break;
            case 'word': {
                const { text, start, end } = token;
                if (text === 'AND' || text === 'OR' || text === 'NOT') {
                    push(start, end, 'keyword');
                    break;
                }
                const colon = text.startsWith('"') ? -1 : indexOfUnquoted(text, ':');
                if (colon <= 0 || !NAME_PATTERN.test(text.slice(0, colon))) {
                    push(start, end, 'text');
                    break;
                }
                const name = internals(schema).fieldLookup.get(text.slice(0, colon).toLowerCase());
                const field = name === undefined ? undefined : schema.fields[name];
                push(start, start + colon, 'field');
                push(start + colon, start + colon + 1, 'punctuation');
                let valueStart = start + colon + 1;
                const operator = field
                    ? /^(?:>=|<=|>|<)/.exec(text.slice(colon + 1))?.[0]
                    : undefined;
                if (operator) {
                    push(valueStart, valueStart + operator.length, 'operator');
                    valueStart += operator.length;
                }
                const raw = input.slice(valueStart, end);
                const items = splitUnquoted(raw, ',');
                items.forEach((item, index) => {
                    const itemStart = valueStart + item.offset;
                    if (index > 0) push(itemStart - 1, itemStart, 'punctuation');
                    const range =
                        field && isRangeable(field) && items.length === 1
                            ? indexOfUnquoted(item.text, '..')
                            : -1;
                    if (range >= 0) {
                        push(itemStart, itemStart + range, 'value');
                        push(itemStart + range, itemStart + range + 2, 'operator');
                        push(itemStart + range + 2, itemStart + item.text.length, 'value');
                    } else {
                        push(itemStart, itemStart + item.text.length, 'value');
                    }
                });
                break;
            }
        }
    }

    return pieces.map(piece => ({
        ...piece,
        error: errors.some(d => piece.start < Math.max(d.end, d.start + 1) && d.start < piece.end),
    }));
}
