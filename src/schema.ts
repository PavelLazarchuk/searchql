import {
    SCHEMA_INTERNALS,
    type EnumField,
    type FieldDefinition,
    type FieldMap,
    type Schema,
    type SchemaDefinition,
    type SchemaInternals,
} from './types';

export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

const VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const FIELD_TYPES = new Set(['string', 'enum', 'number', 'date', 'boolean']);

export function buildSchema<const F extends FieldMap>(definition: SchemaDefinition<F>): Schema<F> {
    if (definition === null || typeof definition !== 'object' || !definition.fields) {
        throw new TypeError('defineSchema() expects an object with a `fields` map');
    }

    const taken = new Map<string, string>();
    const claim = (name: string, owner: string): void => {
        if (!NAME_PATTERN.test(name)) {
            throw new TypeError(
                `Invalid name "${name}" (${owner}): use letters, digits, "_", "." and "-", starting with a letter or "_"`
            );
        }
        const key = name.toLowerCase();
        const previous = taken.get(key);
        if (previous !== undefined) {
            throw new TypeError(`Name "${name}" (${owner}) is already used by ${previous}`);
        }
        taken.set(key, owner);
    };

    const fieldLookup = new Map<string, string>();
    const enumLookup = new Map<string, ReadonlyMap<string, string>>();

    for (const [name, field] of Object.entries(definition.fields)) {
        validateField(name, field);
        claim(name, `field "${name}"`);
        fieldLookup.set(name.toLowerCase(), name);
        for (const alias of field.aliases ?? []) {
            claim(alias, `alias of "${name}"`);
            fieldLookup.set(alias.toLowerCase(), name);
        }
        if (field.type === 'enum') {
            const lookup = new Map<string, string>();
            for (const key of enumKeys(field)) {
                if (lookup.has(key.toLowerCase())) {
                    throw new TypeError(`Enum field "${name}" lists "${key}" twice`);
                }
                lookup.set(key.toLowerCase(), key);
            }
            enumLookup.set(name, lookup);
        }
    }

    const shortcuts = definition.shortcuts ?? {};
    const shortcutLookup = new Map<string, string>();
    for (const [name, presets] of Object.entries(shortcuts)) {
        claim(name, `shortcut "${name}"`);
        shortcutLookup.set(name.toLowerCase(), name);
        const keys = Object.keys(presets);
        if (keys.length === 0) {
            throw new TypeError(`Shortcut "${name}" has no values`);
        }
        const seen = new Set<string>();
        for (const key of keys) {
            if (key.trim() === '' || seen.has(key.toLowerCase())) {
                throw new TypeError(`Shortcut "${name}" has an empty or duplicate value "${key}"`);
            }
            seen.add(key.toLowerCase());
        }
    }

    const text = definition.text ?? [];
    if (Array.isArray(text)) {
        for (const name of text as readonly string[]) {
            const field = definition.fields[name];
            if (!field || (field.type !== 'string' && field.type !== 'enum')) {
                throw new TypeError(`text: "${name}" must be a string or enum field`);
            }
        }
    } else if (typeof text !== 'boolean') {
        throw new TypeError('text must be a boolean or a list of field names');
    }

    const internals: SchemaInternals = {
        fieldLookup,
        shortcutLookup,
        enumLookup,
        hasKeyword: !taken.has('has'),
        noKeyword: !taken.has('no'),
    };

    return Object.freeze({
        fields: definition.fields,
        text: Array.isArray(text) ? Object.freeze([...text]) : text,
        shortcuts,
        [SCHEMA_INTERNALS]: internals,
    }) as Schema<F>;
}

function validateField(name: string, field: FieldDefinition): void {
    if (field === null || typeof field !== 'object' || !FIELD_TYPES.has(field.type)) {
        throw new TypeError(`Field "${name}" needs a type: string, enum, number, date or boolean`);
    }
    for (const variable of field.variables ?? []) {
        if (!VARIABLE_PATTERN.test(variable)) {
            throw new TypeError(`Field "${name}": invalid variable name "${variable}"`);
        }
    }
    if (field.type === 'enum' && enumKeys(field).length === 0) {
        throw new TypeError(`Enum field "${name}" has no values`);
    }
    if (field.type === 'number') {
        if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
            throw new TypeError(`Number field "${name}": min is greater than max`);
        }
    }
}

export function internals(schema: Schema): SchemaInternals {
    const value = (schema as Partial<Schema> | null)?.[SCHEMA_INTERNALS];
    if (!value) {
        throw new TypeError('Expected a schema created by defineSchema()');
    }
    return value;
}

export function enumKeys(field: EnumField): string[] {
    return Array.isArray(field.values)
        ? [...(field.values as readonly string[])]
        : Object.keys(field.values);
}

export function enumStoredValue(field: EnumField, key: string): string | number | boolean {
    if (Array.isArray(field.values)) return key;
    return (field.values as Readonly<Record<string, string | number | boolean>>)[key] ?? key;
}

export function isRangeable(field: FieldDefinition): boolean {
    return (
        field.type === 'number' ||
        field.type === 'date' ||
        (field.type === 'enum' && field.ordered === true)
    );
}

export function canBeEmpty(field: FieldDefinition): boolean {
    return field.nullable === true || field.multiple === true;
}

export function getField(schema: Schema, name: string): FieldDefinition {
    const field = Object.hasOwn(schema.fields, name) ? schema.fields[name] : undefined;
    if (!field) {
        throw new TypeError(`Unknown field "${name}"`);
    }
    return field;
}

export function fieldNames(schema: Schema, name: string): string[] {
    return [name, ...(schema.fields[name]?.aliases ?? [])];
}
