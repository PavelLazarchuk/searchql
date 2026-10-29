import { parseDate } from './date';
import { SearchqlError } from './errors';
import { NAME_PATTERN, canBeEmpty, enumKeys, fieldNames, internals, isRangeable } from './schema';
import {
    indexOfUnquoted,
    scan,
    splitUnquoted,
    unquote,
    type RawToken,
    type WordToken,
} from './scan';
import { closest } from './similarity';
import type {
    ComparisonOperator,
    Diagnostic,
    DiagnosticCode,
    FieldDefinition,
    ParseOptions,
    ParseResult,
    QueryNode,
    Schema,
    Span,
    Value,
} from './types';

const DEFAULT_MAX_LENGTH = 2000;
const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_TERMS = 100;

const OPERATORS: readonly [string, ComparisonOperator][] = [
    ['>=', 'gte'],
    ['<=', 'lte'],
    ['>', 'gt'],
    ['<', 'lt'],
];

const OPERATOR_TEXT: Record<string, string> = {
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
    range: '..',
};

const BOOLEANS: ReadonlyMap<string, boolean> = new Map([
    ['true', true],
    ['yes', true],
    ['false', false],
    ['no', false],
]);

const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

const shortcutCache = new WeakMap<Schema, Map<string, QueryNode | null>>();

export function parse(input: string, schema: Schema, options: ParseOptions = {}): ParseResult {
    return new Parser(String(input), schema, options, true).run();
}

export function parseShortcutQuery(input: string, schema: Schema): ParseResult {
    return new Parser(input, schema, {}, false).run();
}

class Parser {
    private readonly tokens: RawToken[];
    private position = 0;
    private depth = 0;
    private terms = 0;
    private readonly diagnostics: Diagnostic[] = [];
    private readonly maxDepth: number;
    private readonly maxTerms: number;
    private readonly tooLong: boolean;

    constructor(
        private readonly input: string,
        private readonly schema: Schema,
        options: ParseOptions,
        private readonly allowShortcuts: boolean
    ) {
        internals(schema);
        if (options === null || typeof options !== 'object') {
            throw new SearchqlError('invalid-option', 'parse() options must be an object');
        }
        const maxLength = limitOf(options, 'maxLength', DEFAULT_MAX_LENGTH);
        this.maxDepth = limitOf(options, 'maxDepth', DEFAULT_MAX_DEPTH);
        this.maxTerms = limitOf(options, 'maxTerms', DEFAULT_MAX_TERMS);
        this.tooLong = input.length > maxLength;
        this.tokens = this.tooLong ? [] : scan(input).filter(token => token.type !== 'ws');
        if (this.tooLong) {
            this.report(
                'error',
                'too-complex',
                `The query is longer than ${maxLength} characters`,
                { start: maxLength, end: input.length }
            );
        }
    }

    run(): ParseResult {
        const parts: QueryNode[] = [];
        while (this.position < this.tokens.length) {
            const node = this.parseOr();
            if (node) parts.push(node);
            const stray = this.peek();
            if (stray?.type === 'rparen') {
                this.report('error', 'unbalanced-paren', 'Unexpected ")"', stray);
                this.position++;
            }
        }
        const ast = combine('and', parts);
        return {
            input: this.input,
            ast,
            diagnostics: this.diagnostics,
            ok: !this.diagnostics.some(d => d.severity === 'error'),
        };
    }

    private parseOr(): QueryNode | null {
        const children: QueryNode[] = [];
        const first = this.parseAnd();
        if (first) children.push(first);

        while (this.isKeyword(this.peek(), 'OR')) {
            const keyword = this.next()!;
            const right = this.parseAnd();
            if (!right || children.length === 0) {
                this.report(
                    'warning',
                    'dangling-operator',
                    'OR needs a term on both sides',
                    keyword
                );
            }
            if (right) children.push(right);
        }

        return combine('or', children);
    }

    private parseAnd(): QueryNode | null {
        const children: QueryNode[] = [];
        for (;;) {
            const token = this.peek();
            if (!token || token.type === 'rparen' || this.isKeyword(token, 'OR')) break;
            if (this.isKeyword(token, 'AND')) {
                this.next();
                const following = this.peek();
                if (
                    children.length === 0 ||
                    !following ||
                    following.type === 'rparen' ||
                    this.isKeyword(following, 'OR') ||
                    this.isKeyword(following, 'AND')
                ) {
                    this.report(
                        'warning',
                        'dangling-operator',
                        'AND needs a term on both sides',
                        token
                    );
                }
                continue;
            }
            const node = this.parseUnary();
            if (node) children.push(node);
        }
        return combine('and', children);
    }

    private parseUnary(): QueryNode | null {
        const token = this.peek()!;
        if (token.type === 'minus' || this.isKeyword(token, 'NOT')) {
            this.next();
            const hasOperand =
                this.atOperand() && (token.type !== 'minus' || this.peek()!.start === token.end);
            if (!hasOperand) {
                this.report('warning', 'dangling-operator', 'Nothing to negate', token);
                return null;
            }
            if (this.depth >= this.maxDepth) {
                this.tooDeep(token);
                this.skipOperand();
                return null;
            }
            this.depth++;
            const operand = this.parseUnary();
            this.depth--;
            if (!operand) return null;
            return {
                type: 'not',
                child: operand,
                span: { start: token.start, end: operand.span.end },
            };
        }
        return this.parsePrimary();
    }

    private parsePrimary(): QueryNode | null {
        const token = this.next()!;
        if (token.type === 'lparen') {
            if (this.depth >= this.maxDepth) {
                this.tooDeep(token);
                this.skipGroup();
                return null;
            }
            this.depth++;
            const reported = this.diagnostics.length;
            const inner = this.parseOr();
            this.depth--;
            let end = inner?.span.end ?? token.end;
            const close = this.peek();
            if (close?.type === 'rparen') {
                this.next();
                end = close.end;
            } else {
                this.report('error', 'unbalanced-paren', 'Missing ")"', token);
            }
            if (!inner) {
                if (this.diagnostics.length === reported) {
                    this.report('warning', 'empty-group', 'Empty parentheses', {
                        start: token.start,
                        end,
                    });
                }
                return null;
            }
            return { ...inner, span: { start: token.start, end } };
        }
        return this.parseWord(token as WordToken);
    }

    private atOperand(): boolean {
        const token = this.peek();
        return (
            token !== undefined &&
            token.type !== 'rparen' &&
            !this.isKeyword(token, 'OR') &&
            !this.isKeyword(token, 'AND')
        );
    }

    private skipOperand(): void {
        while (this.peek()?.type === 'minus' || this.isKeyword(this.peek(), 'NOT')) this.next();
        const token = this.peek();
        if (token?.type === 'word') this.next();
        else if (token?.type === 'lparen') {
            this.next();
            this.skipGroup();
        }
    }

    private skipGroup(): void {
        let open = 1;
        while (open > 0 && this.position < this.tokens.length) {
            const token = this.next()!;
            if (token.type === 'lparen') open++;
            else if (token.type === 'rparen') open--;
        }
    }

    private tooDeep(at: Span): void {
        this.report(
            'error',
            'too-complex',
            `Groups and negations are nested deeper than ${this.maxDepth} levels`,
            at
        );
    }

    private parseWord(token: WordToken): QueryNode | null {
        if (!this.countTerm(token)) return null;
        if (token.unterminated) {
            const quoteAt = token.start + token.text.indexOf('"');
            this.report('error', 'unterminated-quote', 'Missing closing quote', {
                start: quoteAt,
                end: token.end,
            });
        }

        const colon = token.text.startsWith('"') ? -1 : indexOfUnquoted(token.text, ':');
        const name = colon > 0 ? token.text.slice(0, colon) : '';
        if (colon <= 0 || !NAME_PATTERN.test(name)) {
            return this.textTerm(token);
        }

        const lookup = internals(this.schema);
        const nameSpan = { start: token.start, end: token.start + colon };
        const value = token.text.slice(colon + 1);
        const valueStart = nameSpan.end + 1;
        const key = name.toLowerCase();

        const field = lookup.fieldLookup.get(key);
        if (field !== undefined) {
            return this.filterTerm(
                field,
                this.schema.fields[field]!,
                name,
                value,
                valueStart,
                token
            );
        }
        const shortcut = this.allowShortcuts ? lookup.shortcutLookup.get(key) : undefined;
        if (shortcut !== undefined) {
            return this.shortcutTerm(shortcut, value, valueStart, token);
        }
        if ((key === 'has' && lookup.hasKeyword) || (key === 'no' && lookup.noKeyword)) {
            return this.existsTerm(key as 'has' | 'no', value, valueStart, token);
        }

        this.report(
            'error',
            'unknown-field',
            `Unknown filter "${name}"`,
            nameSpan,
            closest(name, this.knownNames())
        );
        return null;
    }

    private textTerm(token: WordToken): QueryNode | null {
        const value = unquote(token.text);
        if (this.schema.text === false) {
            this.report(
                'error',
                'text-not-allowed',
                'Free-text search is not available here; use field:value filters',
                token
            );
            return null;
        }
        if (value.trim() === '') {
            this.report('warning', 'empty-value', 'Empty search term', token);
            return null;
        }
        return {
            type: 'text',
            value,
            quoted: token.text.startsWith('"'),
            span: { start: token.start, end: token.end },
        };
    }

    private filterTerm(
        name: string,
        field: FieldDefinition,
        typed: string,
        raw: string,
        rawStart: number,
        token: WordToken
    ): QueryNode | null {
        const span = { start: token.start, end: token.end };
        if (raw === '') {
            this.report('error', 'missing-value', `Missing value after "${typed}:"`, span);
            return null;
        }

        const operator = OPERATORS.find(([text]) => raw.startsWith(text));
        if (operator) {
            const [text, op] = operator;
            const rest = raw.slice(text.length);
            const restSpan = { start: rawStart + text.length, end: token.end };
            if (rest === '') {
                this.report(
                    'error',
                    'missing-value',
                    `Missing value after "${typed}:${text}"`,
                    span
                );
                return null;
            }
            if (!this.supports(field, op, name, { start: rawStart, end: restSpan.start })) {
                return null;
            }
            if (indexOfUnquoted(rest, ',') >= 0) {
                this.report(
                    'error',
                    'invalid-value',
                    `"${text}" takes a single value, not a list`,
                    restSpan
                );
                return null;
            }
            const value = this.parseValue(name, field, rest, restSpan.start);
            if (!value || !this.valueSupports(value, op, name, restSpan)) return null;
            return { type: 'filter', field: name, op, value, span };
        }

        const pieces = splitUnquoted(raw, ',');
        if (pieces.every(piece => piece.text === '')) {
            this.report('error', 'missing-value', `Missing value after "${typed}:"`, span);
            return null;
        }
        if (pieces.length === 1 && isRangeable(field)) {
            const at = indexOfUnquoted(raw, '..');
            if (at >= 0) {
                return this.rangeTerm(name, field, raw, rawStart, at, span);
            }
        }

        const values: Value[] = [];
        for (const piece of pieces) {
            const pieceSpan = {
                start: rawStart + piece.offset,
                end: rawStart + piece.offset + piece.text.length,
            };
            if (piece.text === '') {
                if (piece.offset + piece.text.length < raw.length) {
                    this.report('warning', 'empty-value', 'Empty list item', pieceSpan);
                }
                continue;
            }
            if (values.length > 0 && !this.countTerm(pieceSpan)) break;
            const value = this.parseValue(name, field, piece.text, pieceSpan.start);
            if (value) values.push(value);
        }

        if (values.length === 0) return null;
        return values.length === 1
            ? { type: 'filter', field: name, op: 'eq', value: values[0]!, span }
            : { type: 'filter', field: name, op: 'in', values, span };
    }

    private rangeTerm(
        name: string,
        field: FieldDefinition,
        raw: string,
        rawStart: number,
        at: number,
        span: Span
    ): QueryNode | null {
        const rangeSpan = { start: rawStart, end: rawStart + raw.length };
        if (!this.supports(field, 'range', name, rangeSpan)) return null;

        const bound = (text: string, offset: number): Value | null | undefined => {
            if (text === '' || text === '*') return null;
            const value = this.parseValue(name, field, text, rawStart + offset);
            if (!value) return undefined;
            return this.valueSupports(value, 'range', name, rangeSpan) ? value : undefined;
        };

        const min = bound(raw.slice(0, at), 0);
        const max = bound(raw.slice(at + 2), at + 2);
        if (min === undefined || max === undefined) return null;
        if (min === null && max === null) {
            this.report(
                'error',
                'invalid-value',
                'A range needs at least one end, e.g. 10..20 or 10..*',
                rangeSpan
            );
            return null;
        }
        return { type: 'filter', field: name, op: 'range', min, max, span };
    }

    private existsTerm(
        keyword: 'has' | 'no',
        raw: string,
        rawStart: number,
        token: WordToken
    ): QueryNode | null {
        const span = { start: token.start, end: token.end };
        if (raw === '') {
            this.report('error', 'missing-value', `Missing field name after "${keyword}:"`, span);
            return null;
        }
        const lookup = internals(this.schema);
        const nodes: QueryNode[] = [];
        for (const piece of splitUnquoted(raw, ',')) {
            if (piece.text === '') continue;
            const pieceSpan = {
                start: rawStart + piece.offset,
                end: rawStart + piece.offset + piece.text.length,
            };
            const typed = unquote(piece.text);
            const name = lookup.fieldLookup.get(typed.toLowerCase());
            const field = name === undefined ? undefined : this.schema.fields[name];
            if (name === undefined || !field) {
                const candidates = Object.keys(this.schema.fields).filter(n =>
                    canBeEmpty(this.schema.fields[n]!)
                );
                this.report(
                    'error',
                    'unknown-field',
                    `Unknown field "${typed}"`,
                    pieceSpan,
                    closest(typed, candidates)
                );
                continue;
            }
            if (!canBeEmpty(field)) {
                this.report(
                    'error',
                    'not-nullable',
                    `"${name}" is never empty, so ${keyword}:${typed} can't be used`,
                    pieceSpan
                );
                continue;
            }
            const exists: QueryNode = { type: 'exists', field: name, span };
            nodes.push(keyword === 'has' ? exists : { type: 'not', child: exists, span });
        }
        if (nodes.length === 0) return null;
        return nodes.length === 1 ? nodes[0]! : { type: 'or', children: nodes, span };
    }

    private shortcutTerm(
        name: string,
        raw: string,
        rawStart: number,
        token: WordToken
    ): QueryNode | null {
        const span = { start: token.start, end: token.end };
        if (raw === '') {
            this.report('error', 'missing-value', `Missing value after "${name}:"`, span);
            return null;
        }
        const presets = this.schema.shortcuts[name]!;
        const keys = Object.keys(presets);
        const values: string[] = [];
        const expansions: QueryNode[] = [];
        for (const piece of splitUnquoted(raw, ',')) {
            if (piece.text === '') continue;
            const pieceSpan = {
                start: rawStart + piece.offset,
                end: rawStart + piece.offset + piece.text.length,
            };
            const typed = unquote(piece.text);
            const key = keys.find(k => k.toLowerCase() === typed.toLowerCase());
            if (key === undefined) {
                this.report(
                    'error',
                    'invalid-value',
                    `"${typed}" is not a valid ${name}: value; expected ${listOf(keys)}`,
                    pieceSpan,
                    closest(typed, keys)
                );
                continue;
            }
            const expansion = expandShortcut(this.schema, presets[key]!);
            if (expansion) {
                values.push(key);
                expansions.push(respan(expansion, span));
            }
        }
        if (values.length === 0) return null;
        const expansion =
            expansions.length === 1
                ? expansions[0]!
                : { type: 'or' as const, children: expansions, span };
        return { type: 'shortcut', name, values, expansion, span };
    }

    private parseValue(
        name: string,
        field: FieldDefinition,
        raw: string,
        start: number
    ): Value | null {
        const span = { start, end: start + raw.length };
        const quoted = raw.startsWith('"');

        if (!quoted && raw.startsWith('@') && field.variables && field.variables.length > 0) {
            const typed = raw.slice(1);
            const variable = field.variables.find(v => v.toLowerCase() === typed.toLowerCase());
            if (variable === undefined) {
                this.report(
                    'error',
                    'unknown-variable',
                    `Unknown variable "@${typed}"; ${name} accepts ${listOf(field.variables.map(v => `@${v}`))}`,
                    span,
                    closest(typed, field.variables).map(v => `@${v}`)
                );
                return null;
            }
            return { kind: 'variable', name: variable, span };
        }

        switch (field.type) {
            case 'string':
                return this.parseString(field.wildcards !== false, raw, span);
            case 'enum': {
                const typed = unquote(raw);
                const key = internals(this.schema).enumLookup.get(name)!.get(typed.toLowerCase());
                if (key === undefined) {
                    const keys = enumKeys(field);
                    this.report(
                        'error',
                        'invalid-value',
                        `"${typed}" is not a valid ${name}; expected ${listOf(keys)}`,
                        span,
                        closest(typed, keys)
                    );
                    return null;
                }
                return { kind: 'enum', value: key, span };
            }
            case 'number': {
                const typed = unquote(raw);
                const value = NUMBER_PATTERN.test(typed) ? Number(typed) : NaN;
                let problem: string | undefined;
                if (!Number.isFinite(value)) problem = `"${typed}" is not a number`;
                else if (field.integer && !Number.isInteger(value))
                    problem = `${name} must be a whole number`;
                else if (field.min !== undefined && value < field.min)
                    problem = `${name} can't be less than ${field.min}`;
                else if (field.max !== undefined && value > field.max)
                    problem = `${name} can't be more than ${field.max}`;
                if (problem) {
                    this.report('error', 'invalid-value', problem, span);
                    return null;
                }
                return { kind: 'number', value: value === 0 ? 0 : value, span };
            }
            case 'boolean': {
                const typed = unquote(raw);
                const value = BOOLEANS.get(typed.toLowerCase());
                if (value === undefined) {
                    this.report(
                        'error',
                        'invalid-value',
                        `"${typed}" is not a valid ${name}; expected true or false`,
                        span,
                        closest(typed, ['true', 'false'])
                    );
                    return null;
                }
                return { kind: 'boolean', value, span };
            }
            case 'date': {
                const typed = unquote(raw);
                const value = parseDate(typed);
                if (!value) {
                    this.report(
                        'error',
                        'invalid-value',
                        `"${typed}" is not a date; try 2026-03-14, 2026-03, today or -7d`,
                        span,
                        closest(typed, ['today', 'yesterday', 'tomorrow', 'now'])
                    );
                    return null;
                }
                return { kind: 'date', value, span };
            }
        }
    }

    private parseString(wildcards: boolean, raw: string, span: Span): Value | null {
        if (!wildcards || !raw.includes('*')) {
            return { kind: 'string', value: unquote(raw), span };
        }
        const leading = raw.startsWith('*');
        const trailing = raw.length > 1 && raw.endsWith('*');
        const core = raw.slice(leading ? 1 : 0, trailing ? -1 : raw.length);
        if (core === '' || indexOfUnquoted(core, '*') >= 0) {
            this.report(
                'error',
                'invalid-wildcard',
                core === ''
                    ? 'A wildcard needs some text, e.g. bug* — use has:field to find any value'
                    : '"*" works only at the start or end of a value; quote it to search for a literal "*"',
                span
            );
            return null;
        }
        const value = unquote(core);
        if (!leading && !trailing) return { kind: 'string', value, span };
        const wildcard = leading && trailing ? 'contains' : leading ? 'suffix' : 'prefix';
        return { kind: 'string', value, wildcard, span };
    }

    private supports(
        field: FieldDefinition,
        op: ComparisonOperator | 'range',
        name: string,
        span: Span
    ): boolean {
        if (isRangeable(field)) return true;
        const hint =
            field.type === 'enum' ? ' (mark the field as ordered to compare its values)' : '';
        this.report(
            'error',
            'unsupported-operator',
            `"${OPERATOR_TEXT[op]}" can't be used with ${name}${hint}`,
            span
        );
        return false;
    }

    private valueSupports(
        value: Value,
        op: ComparisonOperator | 'range',
        name: string,
        span: Span
    ): boolean {
        if (value.kind === 'variable' || (value.kind === 'string' && value.wildcard)) {
            this.report(
                'error',
                'unsupported-operator',
                `"${OPERATOR_TEXT[op]}" can't be combined with ${value.kind === 'variable' ? 'a variable' : 'a wildcard'} in ${name}`,
                span
            );
            return false;
        }
        return true;
    }

    private countTerm(at: Span): boolean {
        this.terms++;
        if (this.terms === this.maxTerms + 1) {
            this.report(
                'error',
                'too-complex',
                `The query has more than ${this.maxTerms} terms`,
                at
            );
        }
        return this.terms <= this.maxTerms;
    }

    private knownNames(): string[] {
        const lookup = internals(this.schema);
        const names = Object.keys(this.schema.fields).flatMap(name =>
            fieldNames(this.schema, name)
        );
        if (this.allowShortcuts) names.push(...Object.keys(this.schema.shortcuts));
        if (lookup.hasKeyword) names.push('has');
        if (lookup.noKeyword) names.push('no');
        return names;
    }

    private peek(): RawToken | undefined {
        return this.tokens[this.position];
    }

    private next(): RawToken | undefined {
        return this.tokens[this.position++];
    }

    private isKeyword(token: RawToken | undefined, keyword: 'AND' | 'OR' | 'NOT'): boolean {
        return token?.type === 'word' && token.text === keyword;
    }

    private report(
        severity: Diagnostic['severity'],
        code: DiagnosticCode,
        message: string,
        span: Span,
        suggestions?: readonly string[]
    ): void {
        this.diagnostics.push({
            severity,
            code,
            message,
            start: span.start,
            end: span.end,
            ...(suggestions && suggestions.length > 0 ? { suggestions } : {}),
        });
    }
}

function limitOf(options: ParseOptions, name: keyof ParseOptions, fallback: number): number {
    const value = options[name] ?? fallback;
    if (value !== Infinity && !(Number.isInteger(value) && value >= 0)) {
        throw new SearchqlError(
            'invalid-option',
            `parse() option ${name} must be a non-negative integer or Infinity`
        );
    }
    return value;
}

function combine(type: 'and' | 'or', children: QueryNode[]): QueryNode | null {
    if (children.length === 0) return null;
    if (children.length === 1) return children[0]!;
    return {
        type,
        children,
        span: { start: children[0]!.span.start, end: children[children.length - 1]!.span.end },
    };
}

function listOf(items: readonly string[]): string {
    const shown = items.slice(0, 8).join(', ');
    return items.length > 8 ? `${shown}, …` : shown;
}

function expandShortcut(schema: Schema, query: string): QueryNode | null {
    let cache = shortcutCache.get(schema);
    if (!cache) {
        cache = new Map();
        shortcutCache.set(schema, cache);
    }
    if (!cache.has(query)) {
        cache.set(query, parseShortcutQuery(query, schema).ast);
    }
    return cache.get(query) ?? null;
}

function respan(node: QueryNode, span: Span): QueryNode {
    switch (node.type) {
        case 'and':
        case 'or':
            return { ...node, children: node.children.map(child => respan(child, span)), span };
        case 'not':
            return { ...node, child: respan(node.child, span), span };
        case 'shortcut':
            return { ...node, expansion: respan(node.expansion, span), span };
        case 'filter':
            return stripValueSpans({ ...node, span });
        default:
            return { ...node, span };
    }
}

function stripValueSpans(node: QueryNode & { type: 'filter' }): QueryNode {
    const strip = (value: Value | null): Value | null => {
        if (!value) return value;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { span: _span, ...rest } = value;
        return rest as Value;
    };
    switch (node.op) {
        case 'in':
            return { ...node, values: node.values.map(value => strip(value)!) };
        case 'range':
            return { ...node, min: strip(node.min), max: strip(node.max) };
        default:
            return { ...node, value: strip(node.value)! };
    }
}
