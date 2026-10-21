import { describe, expect, it } from 'vitest';
import { assertTimeZone, formatDate, parseDate, resolveDate } from './date';
import type { DateValue } from './types';

const utc = (iso: string) => Date.parse(iso);

describe('parseDate', () => {
    it.each([
        ['2026', { type: 'calendar', year: 2026 }],
        ['2026-03', { type: 'calendar', year: 2026, month: 3 }],
        ['2026-03-14', { type: 'calendar', year: 2026, month: 3, day: 14 }],
        [
            '2026-03-14T09:30',
            { type: 'calendar', year: 2026, month: 3, day: 14, hour: 9, minute: 30 },
        ],
        [
            '2026-03-14t09:30:15',
            { type: 'calendar', year: 2026, month: 3, day: 14, hour: 9, minute: 30, second: 15 },
        ],
        ['2026-03-14T09:30Z', { type: 'instant', epochMs: utc('2026-03-14T09:30:00Z') }],
        [
            '2026-03-14T09:30:00.250+02:00',
            { type: 'instant', epochMs: utc('2026-03-14T07:30:00.250Z') },
        ],
        ['2026-03-14T09:30-0530', { type: 'instant', epochMs: utc('2026-03-14T15:00:00Z') }],
        ['Today', { type: 'keyword', name: 'today' }],
        ['now', { type: 'keyword', name: 'now' }],
        ['-7d', { type: 'relative', amount: -7, unit: 'd' }],
        ['+2w', { type: 'relative', amount: 2, unit: 'w' }],
        ['-30m', { type: 'relative', amount: -30, unit: 'min' }],
        ['-30min', { type: 'relative', amount: -30, unit: 'min' }],
        ['-3MO', { type: 'relative', amount: -3, unit: 'mo' }],
        ['-12h', { type: 'relative', amount: -12, unit: 'h' }],
        ['-1y', { type: 'relative', amount: -1, unit: 'y' }],
        ['-0d', { type: 'relative', amount: 0, unit: 'd' }],
    ])('reads %s', (text, expected) => {
        expect(parseDate(text)).toEqual(expected);
    });

    it.each([
        '0999',
        '2026-13',
        '2026-00',
        '2026-02-29',
        '2026-04-31',
        '2026-03-14T24:00',
        '2026-03-14T10:60',
        '2026-03-14T10:00:60',
        '2026-03-14T10:00:00.5',
        '2026-03-14T10:00+24:00',
        '2026-03-14T10:00+02:60',
        '2026-3-14',
        '7d',
        '-7x',
        'last week',
    ])('rejects %s', text => {
        expect(parseDate(text)).toBeNull();
    });

    it('accepts leap days', () => {
        expect(parseDate('2028-02-29')).not.toBeNull();
    });
});

describe('formatDate', () => {
    it.each([
        '2026',
        '2026-03',
        '2026-03-14',
        '2026-03-14T09:30',
        '2026-03-14T09:30:05',
        'today',
        '-7d',
        '+2w',
        '-30min',
    ])('writes %s back the same way', text => {
        expect(formatDate(parseDate(text)!)).toBe(text);
    });

    it('writes instants in UTC', () => {
        expect(formatDate(parseDate('2026-03-14T09:30+02:00')!)).toBe('2026-03-14T07:30:00.000Z');
    });

    it('fills a missing minute', () => {
        expect(formatDate({ type: 'calendar', year: 2026, month: 1, day: 2, hour: 3 })).toBe(
            '2026-01-02T03:00'
        );
    });
});

describe('resolveDate', () => {
    const now = utc('2026-10-13T12:34:56.789Z');
    const resolve = (value: DateValue, zone = 'UTC') => {
        const { start, end } = resolveDate(value, now, zone);
        return [new Date(start).toISOString(), new Date(end).toISOString()];
    };

    it('covers the whole period of a calendar date', () => {
        expect(resolve(parseDate('2026')!)).toEqual([
            '2026-01-01T00:00:00.000Z',
            '2027-01-01T00:00:00.000Z',
        ]);
        expect(resolve(parseDate('2026-12')!)).toEqual([
            '2026-12-01T00:00:00.000Z',
            '2027-01-01T00:00:00.000Z',
        ]);
        expect(resolve(parseDate('2026-02-28')!)).toEqual([
            '2026-02-28T00:00:00.000Z',
            '2026-03-01T00:00:00.000Z',
        ]);
        expect(resolve(parseDate('2026-03-14T09:30')!)).toEqual([
            '2026-03-14T09:30:00.000Z',
            '2026-03-14T09:31:00.000Z',
        ]);
        expect(resolve(parseDate('2026-03-14T09:30:59')!)).toEqual([
            '2026-03-14T09:30:59.000Z',
            '2026-03-14T09:31:00.000Z',
        ]);
    });

    it('reads calendar dates in the given time zone', () => {
        expect(resolve(parseDate('2026-07-01')!, 'Europe/Kyiv')).toEqual([
            '2026-06-30T21:00:00.000Z',
            '2026-07-01T21:00:00.000Z',
        ]);
        expect(resolve(parseDate('2026-01-01')!, 'Europe/Kyiv')).toEqual([
            '2025-12-31T22:00:00.000Z',
            '2026-01-01T22:00:00.000Z',
        ]);
        expect(resolve(parseDate('2026-03-14')!, 'Etc/UTC')).toEqual([
            '2026-03-14T00:00:00.000Z',
            '2026-03-15T00:00:00.000Z',
        ]);
    });

    it('gets day lengths right across DST changes', () => {
        const [start, end] = resolve(parseDate('2026-03-08')!, 'America/New_York');
        expect(Date.parse(end!) - Date.parse(start!)).toBe(23 * 3_600_000);
        const [fallStart, fallEnd] = resolve(parseDate('2026-11-01')!, 'America/New_York');
        expect(Date.parse(fallEnd!) - Date.parse(fallStart!)).toBe(25 * 3_600_000);
        const [santiago] = resolve(parseDate('2026-09-06')!, 'America/Santiago');
        expect(santiago).toBe('2026-09-06T04:00:00.000Z');
    });

    it('resolves keywords around now', () => {
        expect(resolve({ type: 'keyword', name: 'now' })).toEqual([
            '2026-10-13T12:34:56.789Z',
            '2026-10-13T12:34:56.790Z',
        ]);
        expect(resolve({ type: 'keyword', name: 'today' })).toEqual([
            '2026-10-13T00:00:00.000Z',
            '2026-10-14T00:00:00.000Z',
        ]);
        expect(resolve({ type: 'keyword', name: 'yesterday' })).toEqual([
            '2026-10-12T00:00:00.000Z',
            '2026-10-13T00:00:00.000Z',
        ]);
        expect(resolve({ type: 'keyword', name: 'tomorrow' })).toEqual([
            '2026-10-14T00:00:00.000Z',
            '2026-10-15T00:00:00.000Z',
        ]);
        expect(resolve({ type: 'keyword', name: 'today' }, 'Australia/Sydney')).toEqual([
            '2026-10-12T13:00:00.000Z',
            '2026-10-13T13:00:00.000Z',
        ]);
    });

    it('moves relative dates by calendar units in the zone', () => {
        const at = (text: string, zone = 'UTC') => resolve(parseDate(text)!, zone)[0];
        expect(at('-30min')).toBe('2026-10-13T12:04:56.789Z');
        expect(at('-12h')).toBe('2026-10-13T00:34:56.789Z');
        expect(at('-7d')).toBe('2026-10-06T12:34:56.789Z');
        expect(at('+2w')).toBe('2026-10-27T12:34:56.789Z');
        expect(at('-1mo')).toBe('2026-09-13T12:34:56.789Z');
        expect(at('-10mo')).toBe('2025-12-13T12:34:56.789Z');
        expect(at('-1y')).toBe('2025-10-13T12:34:56.789Z');
        const fall = utc('2026-11-01T17:00:00Z');
        const dayBefore = resolveDate(parseDate('-1d')!, fall, 'America/New_York').start;
        expect(fall - dayBefore).toBe(25 * 3_600_000);
    });

    it('clamps to the end of shorter months', () => {
        const march31 = utc('2026-03-31T10:00:00Z');
        expect(new Date(resolveDate(parseDate('-1mo')!, march31, 'UTC').start).toISOString()).toBe(
            '2026-02-28T10:00:00.000Z'
        );
        const leap = utc('2028-02-29T10:00:00Z');
        expect(new Date(resolveDate(parseDate('-1y')!, leap, 'UTC').start).toISOString()).toBe(
            '2027-02-28T10:00:00.000Z'
        );
    });

    it('treats instants as single milliseconds', () => {
        expect(resolve(parseDate('2026-03-14T09:30Z')!)).toEqual([
            '2026-03-14T09:30:00.000Z',
            '2026-03-14T09:30:00.001Z',
        ]);
    });
});

describe('assertTimeZone', () => {
    it('throws for zones Intl does not know', () => {
        expect(() => assertTimeZone('Mars/Olympus')).toThrow(RangeError);
        expect(() => assertTimeZone('UTC')).not.toThrow();
        expect(() => assertTimeZone('Asia/Tokyo')).not.toThrow();
    });
});
