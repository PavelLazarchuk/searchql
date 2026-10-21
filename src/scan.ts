export type RawToken =
    | {
          readonly type: 'ws' | 'lparen' | 'rparen' | 'minus';
          readonly start: number;
          readonly end: number;
      }
    | {
          readonly type: 'word';
          readonly start: number;
          readonly end: number;
          readonly text: string;
          readonly unterminated: boolean;
      };

export type WordToken = Extract<RawToken, { type: 'word' }>;

const WHITESPACE = /\s/u;

export function isWhitespace(char: string): boolean {
    return WHITESPACE.test(char);
}

export function scan(input: string): RawToken[] {
    const tokens: RawToken[] = [];
    const length = input.length;
    let i = 0;

    while (i < length) {
        const char = input[i]!;

        if (isWhitespace(char)) {
            let end = i + 1;
            while (end < length && isWhitespace(input[end]!)) end++;
            tokens.push({ type: 'ws', start: i, end });
            i = end;
            continue;
        }

        if (char === '(' || char === ')') {
            tokens.push({ type: char === '(' ? 'lparen' : 'rparen', start: i, end: i + 1 });
            i++;
            continue;
        }

        if (char === '-') {
            tokens.push({ type: 'minus', start: i, end: i + 1 });
            i++;
            continue;
        }

        let end = i;
        let unterminated = false;
        while (end < length) {
            const c = input[end]!;
            if (isWhitespace(c) || c === '(' || c === ')') break;
            if (c === '"') {
                const close = skipQuoted(input, end);
                if (close < 0) {
                    unterminated = true;
                    end = length;
                    break;
                }
                end = close;
            } else {
                end++;
            }
        }
        tokens.push({ type: 'word', start: i, end, text: input.slice(i, end), unterminated });
        i = end;
    }

    return tokens;
}

function skipQuoted(text: string, open: number): number {
    let i = open + 1;
    while (i < text.length) {
        const c = text[i];
        if (c === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) {
            i += 2;
        } else if (c === '"') {
            return i + 1;
        } else {
            i++;
        }
    }
    return -1;
}

export function indexOfUnquoted(text: string, needle: string, from = 0): number {
    let i = from;
    while (i < text.length) {
        if (text[i] === '"') {
            const close = skipQuoted(text, i);
            if (close < 0) return -1;
            i = close;
            continue;
        }
        if (text.startsWith(needle, i)) return i;
        i++;
    }
    return -1;
}

export interface Piece {
    readonly text: string;
    readonly offset: number;
}

export function splitUnquoted(text: string, separator: string): Piece[] {
    const pieces: Piece[] = [];
    let start = 0;
    for (;;) {
        const at = indexOfUnquoted(text, separator, start);
        if (at < 0) {
            pieces.push({ text: text.slice(start), offset: start });
            return pieces;
        }
        pieces.push({ text: text.slice(start, at), offset: start });
        start = at + separator.length;
    }
}

export function unquote(text: string): string {
    if (!text.includes('"')) return text;
    let out = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (c === '"') {
            quoted = !quoted;
        } else if (quoted && c === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) {
            out += text[i + 1];
            i++;
        } else {
            out += c;
        }
    }
    return out;
}

export function quote(text: string): string {
    return `"${text.replace(/[\\"]/g, '\\$&')}"`;
}

const BREAKS_TERM = /[\s",()]|^$/u;
const HAS_MEANING = /[\s",()*]|^$|^[<>=@]|\.\./u;
const KEYWORDS = new Set(['AND', 'OR', 'NOT']);

export function quoteIfNeeded(text: string): string {
    return BREAKS_TERM.test(text) ? quote(text) : text;
}

export function formatLiteral(text: string): string {
    return HAS_MEANING.test(text) ? quote(text) : text;
}

export function formatTextTerm(text: string): string {
    return HAS_MEANING.test(text) ||
        text.startsWith('-') ||
        text.includes(':') ||
        KEYWORDS.has(text)
        ? quote(text)
        : text;
}
