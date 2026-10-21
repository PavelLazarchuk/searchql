import type { DateKeyword, DateValue, RelativeUnit } from './types';

const DATE_PATTERN =
    /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?)?)?$/i;

const RELATIVE_PATTERN = /^([+-])(\d{1,6})(min|mo|m|h|d|w|y)$/i;

const KEYWORDS: ReadonlySet<string> = new Set<DateKeyword>([
    'now',
    'today',
    'yesterday',
    'tomorrow',
]);

const MINUTE = 60_000;
const HOUR = 3_600_000;

export function parseDate(text: string): DateValue | null {
    const lower = text.toLowerCase();
    if (KEYWORDS.has(lower)) {
        return { type: 'keyword', name: lower as DateKeyword };
    }

    const relative = RELATIVE_PATTERN.exec(text);
    if (relative) {
        const unit = relative[3]!.toLowerCase();
        const amount = Number(relative[2]) * (relative[1] === '-' ? -1 : 1);
        return {
            type: 'relative',
            amount: amount === 0 ? 0 : amount,
            unit: (unit === 'm' ? 'min' : unit) as RelativeUnit,
        };
    }

    const match = DATE_PATTERN.exec(text);
    if (!match) return null;

    const [, y, mo, d, h, mi, s, fraction, zone] = match;
    const year = Number(y);
    if (year < 1000) return null;
    const month = mo === undefined ? undefined : Number(mo);
    const day = d === undefined ? undefined : Number(d);
    const hour = h === undefined ? undefined : Number(h);
    const minute = mi === undefined ? undefined : Number(mi);
    const second = s === undefined ? undefined : Number(s);

    if (month !== undefined && (month < 1 || month > 12)) return null;
    if (day !== undefined && (day < 1 || day > daysInMonth(year, month!))) return null;
    if (hour !== undefined && hour > 23) return null;
    if (minute !== undefined && minute > 59) return null;
    if (second !== undefined && second > 59) return null;

    if (zone !== undefined) {
        const offset = parseOffset(zone);
        if (offset === null) return null;
        const ms = fraction === undefined ? 0 : Math.floor(Number(`0${fraction}`) * 1000);
        const local = Date.UTC(year, month! - 1, day!, hour!, minute!, second ?? 0, ms);
        return { type: 'instant', epochMs: local - offset };
    }
    if (fraction !== undefined) return null;

    return stripUndefined({ type: 'calendar' as const, year, month, day, hour, minute, second });
}

function parseOffset(zone: string): number | null {
    if (zone.toUpperCase() === 'Z') return 0;
    const digits = zone.slice(1).replace(':', '');
    const hours = Number(digits.slice(0, 2));
    const minutes = Number(digits.slice(2));
    if (hours > 23 || minutes > 59) return null;
    return (zone.startsWith('-') ? -1 : 1) * (hours * HOUR + minutes * MINUTE);
}

function stripUndefined<T extends object>(value: T): T {
    for (const key of Object.keys(value) as (keyof T)[]) {
        if (value[key] === undefined) delete value[key];
    }
    return value;
}

export function formatDate(value: DateValue): string {
    switch (value.type) {
        case 'keyword':
            return value.name;
        case 'relative':
            return `${value.amount < 0 ? '-' : '+'}${Math.abs(value.amount)}${value.unit}`;
        case 'instant':
            return new Date(value.epochMs).toISOString();
        case 'calendar': {
            let out = String(value.year);
            if (value.month === undefined) return out;
            out += `-${pad(value.month)}`;
            if (value.day === undefined) return out;
            out += `-${pad(value.day)}`;
            if (value.hour === undefined) return out;
            out += `T${pad(value.hour)}:${pad(value.minute ?? 0)}`;
            if (value.second !== undefined) out += `:${pad(value.second)}`;
            return out;
        }
    }
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

export interface Interval {
    readonly start: number;
    readonly end: number;
}

interface Wall {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    ms: number;
}

export function resolveDate(value: DateValue, now: number, timeZone: string): Interval {
    switch (value.type) {
        case 'instant':
            return { start: value.epochMs, end: value.epochMs + 1 };
        case 'relative': {
            const at = shift(now, value.amount, value.unit, timeZone);
            return { start: at, end: at + 1 };
        }
        case 'keyword': {
            if (value.name === 'now') return { start: now, end: now + 1 };
            const offset = value.name === 'today' ? 0 : value.name === 'yesterday' ? -1 : 1;
            const wall = toWall(now, timeZone);
            const day = { ...wall, day: wall.day + offset, hour: 0, minute: 0, second: 0, ms: 0 };
            return {
                start: fromWall(day, timeZone),
                end: fromWall({ ...day, day: day.day + 1 }, timeZone),
            };
        }
        case 'calendar': {
            const start: Wall = {
                year: value.year,
                month: value.month ?? 1,
                day: value.day ?? 1,
                hour: value.hour ?? 0,
                minute: value.minute ?? 0,
                second: value.second ?? 0,
                ms: 0,
            };
            const end = { ...start };
            if (value.month === undefined) end.year++;
            else if (value.day === undefined) end.month++;
            else if (value.hour === undefined) end.day++;
            else if (value.second === undefined) end.minute++;
            else end.second++;
            return { start: fromWall(start, timeZone), end: fromWall(end, timeZone) };
        }
    }
}

function shift(from: number, amount: number, unit: RelativeUnit, timeZone: string): number {
    if (unit === 'min') return from + amount * MINUTE;
    if (unit === 'h') return from + amount * HOUR;
    const wall = toWall(from, timeZone);
    if (unit === 'd' || unit === 'w') {
        return fromWall({ ...wall, day: wall.day + amount * (unit === 'w' ? 7 : 1) }, timeZone);
    }
    const months = wall.year * 12 + (wall.month - 1) + amount * (unit === 'y' ? 12 : 1);
    const year = Math.floor(months / 12);
    const month = (months % 12) + 1;
    return fromWall(
        { ...wall, year, month, day: Math.min(wall.day, daysInMonth(year, month)) },
        timeZone
    );
}

function daysInMonth(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function wallToUtc(wall: Wall): number {
    return Date.UTC(
        wall.year,
        wall.month - 1,
        wall.day,
        wall.hour,
        wall.minute,
        wall.second,
        wall.ms
    );
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
    let format = formatters.get(timeZone);
    if (!format) {
        format = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
        });
        formatters.set(timeZone, format);
    }
    return format;
}

function isUtc(timeZone: string): boolean {
    return timeZone === 'UTC' || timeZone === 'Etc/UTC';
}

function toWall(epochMs: number, timeZone: string): Wall {
    const date = new Date(epochMs);
    if (isUtc(timeZone)) {
        return {
            year: date.getUTCFullYear(),
            month: date.getUTCMonth() + 1,
            day: date.getUTCDate(),
            hour: date.getUTCHours(),
            minute: date.getUTCMinutes(),
            second: date.getUTCSeconds(),
            ms: date.getUTCMilliseconds(),
        };
    }
    const wall: Wall = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0, ms: 0 };
    for (const part of formatter(timeZone).formatToParts(date)) {
        if (part.type in wall) wall[part.type as keyof Wall] = Number(part.value);
    }
    wall.ms = date.getUTCMilliseconds();
    return wall;
}

function offsetAt(epochMs: number, timeZone: string): number {
    return wallToUtc(toWall(epochMs, timeZone)) - epochMs;
}

function fromWall(wall: Wall, timeZone: string): number {
    const local = wallToUtc(wall);
    if (isUtc(timeZone)) return local;
    const first = offsetAt(local, timeZone);
    const guess = local - first;
    const second = offsetAt(guess, timeZone);
    if (second === first) return guess;
    const retry = local - second;
    return offsetAt(retry, timeZone) === second ? retry : guess;
}

export function assertTimeZone(timeZone: string): void {
    if (!isUtc(timeZone)) formatter(timeZone);
}
