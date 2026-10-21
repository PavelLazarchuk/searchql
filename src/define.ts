import { parseShortcutQuery } from './parse';
import { buildSchema } from './schema';
import type { FieldMap, Schema, SchemaDefinition } from './types';

export function defineSchema<const F extends FieldMap>(definition: SchemaDefinition<F>): Schema<F> {
    const schema = buildSchema(definition);
    for (const [name, presets] of Object.entries(schema.shortcuts)) {
        for (const [key, query] of Object.entries(presets)) {
            const result = parseShortcutQuery(query, schema as Schema);
            const problem = result.diagnostics.find(d => d.severity === 'error');
            if (problem || !result.ast) {
                throw new TypeError(
                    `Shortcut ${name}:${key} expands to an invalid query "${query}": ${problem?.message ?? 'it is empty'}`
                );
            }
        }
    }
    return schema;
}
