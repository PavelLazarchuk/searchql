import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { highlight, parse } from './index';
import { issues } from './test-utils/fixtures';

const view = (input: string) =>
    highlight(input, issues)
        .map(t => `${t.kind}${t.error ? '!' : ''}:${input.slice(t.start, t.end)}`)
        .join(' ');

describe('highlight', () => {
    it('labels each part of a filter', () => {
        expect(view('-status:open,closed (a OR "b c")')).toBe(
            'negation:- field:status punctuation:: value:open punctuation:, value:closed whitespace:  ' +
                'paren:( text:a whitespace:  keyword:OR whitespace:  text:"b c" paren:)'
        );
        expect(view('comments:>=5 created:2026..*')).toBe(
            'field:comments punctuation:: operator:>= value:5 whitespace:  field:created punctuation:: value:2026 operator:.. value:*'
        );
    });

    it('keeps .. inside values of fields without ranges', () => {
        expect(view('author:a..b')).toBe('field:author punctuation:: value:a..b');
    });

    it('flags the parts errors point at', () => {
        expect(view('stauts:open status:opn')).toBe(
            'field!:stauts punctuation:: value:open whitespace:  field:status punctuation:: value!:opn'
        );
        expect(view('nope:>1')).toBe('field!:nope punctuation:: value:>1');
        expect(view('"abc')).toBe('text!:"abc');
    });

    it('accepts an existing parse result', () => {
        const input = 'status:opn';
        expect(highlight(input, issues, parse(input, issues))).toEqual(highlight(input, issues));
    });

    it('covers the input exactly, whatever it is', () => {
        fc.assert(
            fc.property(
                fc.string({
                    unit: fc.constantFrom(
                        'a',
                        ':',
                        ',',
                        '"',
                        '\\',
                        '(',
                        ')',
                        '-',
                        ' ',
                        '.',
                        '>',
                        '*',
                        's',
                        't'
                    ),
                }),
                input => {
                    const tokens = highlight(input, issues);
                    expect(tokens.map(t => input.slice(t.start, t.end)).join('')).toBe(input);
                    tokens.forEach((t, i) => {
                        expect(t.end).toBeGreaterThan(t.start);
                        if (i > 0) expect(t.start).toBe(tokens[i - 1]!.end);
                    });
                }
            ),
            { numRuns: 500 }
        );
    });
});
