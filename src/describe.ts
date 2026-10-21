import { canBeEmpty, enumKeys, internals, isRangeable } from './schema';
import type { FieldDefinition, Schema } from './types';

export interface DescribeOptions {
    readonly examples?: readonly string[];
}

export function describeSchema(schema: Schema, options: DescribeOptions = {}): string {
    const lookup = internals(schema);
    const fields = Object.entries(schema.fields);
    const lines: string[] = ['Search syntax:'];

    if (Array.isArray(schema.text) && schema.text.length > 0) {
        lines.push(
            `- Plain words search ${schema.text.join(', ')}. Quote phrases: "exact phrase".`
        );
    } else if (schema.text !== false) {
        lines.push('- Plain words search the text. Quote phrases: "exact phrase".');
    }
    lines.push(
        '- field:value filters by a field; field:a,b matches any of the values.',
        '- Terms separated by spaces must all match; put OR between terms to match either; group with parentheses.',
        '- A leading - excludes: -field:value, -word, -(a OR b).'
    );
    if (fields.some(([, field]) => isRangeable(field))) {
        lines.push(
            '- Numbers and dates compare: field:>10, field:<=2026-03-01, and ranges field:10..20 (* for an open end).'
        );
    }
    if (fields.some(([, field]) => field.type === 'date')) {
        lines.push(
            '- Dates: 2026-03-14, 2026-03, 2026, today, yesterday, now, or relative: -7d (last 7 days), -12h, -2w, -3mo, -1y.'
        );
    }
    if (fields.some(([, field]) => field.type === 'string' && field.wildcards !== false)) {
        lines.push(
            '- In text fields * at the start or end matches anything: name:jo*, email:*@example.com.'
        );
    }
    const emptiable = fields.filter(([, field]) => canBeEmpty(field)).map(([name]) => name);
    if (emptiable.length > 0 && (lookup.hasKeyword || lookup.noKeyword)) {
        const forms = [lookup.hasKeyword && 'has:field', lookup.noKeyword && 'no:field']
            .filter(Boolean)
            .join(' / ');
        lines.push(`- ${forms} test whether a field is empty (works for ${emptiable.join(', ')}).`);
    }

    lines.push('', 'Fields:');
    for (const [name, field] of fields) {
        const aliases = field.aliases?.length ? ` (also: ${field.aliases.join(', ')})` : '';
        const note = field.description ? ` ${field.description.replace(/\.?$/, '.')}` : '';
        lines.push(`- ${name}${aliases}: ${typeOf(field)}.${note}`);
    }

    const shortcuts = Object.entries(schema.shortcuts);
    if (shortcuts.length > 0) {
        lines.push('', 'Shortcuts:');
        for (const [name, presets] of shortcuts) {
            for (const [key, query] of Object.entries(presets)) {
                lines.push(`- ${name}:${key} means ${query}`);
            }
        }
    }

    if (options.examples?.length) {
        lines.push('', 'Examples:', ...options.examples.map(example => `- ${example}`));
    }
    return lines.join('\n');
}

function typeOf(field: FieldDefinition): string {
    const parts: string[] = [];
    switch (field.type) {
        case 'enum':
            parts.push(
                `one of ${enumKeys(field).join(', ')}${field.ordered ? ' (in this order, so it compares)' : ''}`
            );
            break;
        case 'string':
            parts.push(
                field.match === 'contains'
                    ? 'text, matches anywhere'
                    : field.match === 'prefix'
                      ? 'text, matches the start'
                      : 'text, exact match'
            );
            if (field.caseSensitive) parts.push('case-sensitive');
            break;
        case 'number': {
            parts.push(field.integer ? 'whole number' : 'number');
            if (field.min !== undefined) parts.push(`at least ${field.min}`);
            if (field.max !== undefined) parts.push(`at most ${field.max}`);
            break;
        }
        case 'date':
            parts.push('date');
            break;
        case 'boolean':
            parts.push('true or false');
            break;
    }
    if (field.multiple) parts.push('a list, matches if any item does');
    if (field.variables?.length)
        parts.push(`accepts ${field.variables.map(v => `@${v}`).join(', ')}`);
    return parts.join(', ');
}
