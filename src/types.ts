interface FieldBase {
    readonly aliases?: readonly string[];
    readonly description?: string;
    readonly multiple?: boolean;
    readonly nullable?: boolean;
    readonly variables?: readonly string[];
}

export interface StringField extends FieldBase {
    readonly type: 'string';
    readonly match?: 'exact' | 'prefix' | 'contains';
    readonly caseSensitive?: boolean;
    readonly wildcards?: boolean;
}

export interface EnumField extends FieldBase {
    readonly type: 'enum';
    readonly values: readonly string[] | Readonly<Record<string, string | number | boolean>>;
    readonly ordered?: boolean;
}

export interface NumberField extends FieldBase {
    readonly type: 'number';
    readonly integer?: boolean;
    readonly min?: number;
    readonly max?: number;
}

export interface DateField extends FieldBase {
    readonly type: 'date';
}

export interface BooleanField extends FieldBase {
    readonly type: 'boolean';
}

export type FieldDefinition = StringField | EnumField | NumberField | DateField | BooleanField;

export type FieldType = FieldDefinition['type'];

export type FieldMap = Readonly<Record<string, FieldDefinition>>;

export interface SchemaDefinition<F extends FieldMap = FieldMap> {
    readonly fields: F;
    readonly text?: boolean | readonly (keyof F & string)[];
    readonly shortcuts?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export type FieldName<S> = S extends Schema<infer F> ? keyof F & string : string;

export type VariableName<S> =
    S extends Schema<infer F>
        ? {
              [K in keyof F]: F[K] extends { variables: readonly (infer V)[] } ? V : never;
          }[keyof F] &
              string
        : string;

export interface Schema<F extends FieldMap = FieldMap> {
    readonly fields: F;
    readonly text: boolean | readonly string[];
    readonly shortcuts: Readonly<Record<string, Readonly<Record<string, string>>>>;
    readonly [SCHEMA_INTERNALS]: SchemaInternals;
}

export const SCHEMA_INTERNALS: unique symbol = Symbol.for('searchql.schema');

export interface SchemaInternals {
    readonly fieldLookup: ReadonlyMap<string, string>;
    readonly shortcutLookup: ReadonlyMap<string, string>;
    readonly enumLookup: ReadonlyMap<string, ReadonlyMap<string, string>>;
    readonly hasKeyword: boolean;
    readonly noKeyword: boolean;
}

export interface Span {
    readonly start: number;
    readonly end: number;
}

export type DateValue =
    | {
          readonly type: 'calendar';
          readonly year: number;
          readonly month?: number;
          readonly day?: number;
          readonly hour?: number;
          readonly minute?: number;
          readonly second?: number;
      }
    | { readonly type: 'instant'; readonly epochMs: number }
    | { readonly type: 'relative'; readonly amount: number; readonly unit: RelativeUnit }
    | { readonly type: 'keyword'; readonly name: DateKeyword };

export type RelativeUnit = 'min' | 'h' | 'd' | 'w' | 'mo' | 'y';

export type DateKeyword = 'now' | 'today' | 'yesterday' | 'tomorrow';

export type Value = (
    | {
          readonly kind: 'string';
          readonly value: string;
          readonly wildcard?: 'prefix' | 'suffix' | 'contains';
      }
    | { readonly kind: 'enum'; readonly value: string }
    | { readonly kind: 'number'; readonly value: number }
    | { readonly kind: 'boolean'; readonly value: boolean }
    | { readonly kind: 'date'; readonly value: DateValue }
    | { readonly kind: 'variable'; readonly name: string }
) & { readonly span?: Span };

export type ComparisonOperator = 'eq' | 'gt' | 'gte' | 'lt' | 'lte';

export type FilterNode = {
    readonly type: 'filter';
    readonly field: string;
    readonly span: Span;
} & (
    | { readonly op: ComparisonOperator; readonly value: Value }
    | { readonly op: 'in'; readonly values: readonly Value[] }
    | { readonly op: 'range'; readonly min: Value | null; readonly max: Value | null }
);

export interface ExistsNode {
    readonly type: 'exists';
    readonly field: string;
    readonly span: Span;
}

export interface TextNode {
    readonly type: 'text';
    readonly value: string;
    readonly quoted: boolean;
    readonly span: Span;
}

export interface ShortcutNode {
    readonly type: 'shortcut';
    readonly name: string;
    readonly values: readonly string[];
    readonly expansion: QueryNode;
    readonly span: Span;
}

export interface NotNode {
    readonly type: 'not';
    readonly child: QueryNode;
    readonly span: Span;
}

export interface AndNode {
    readonly type: 'and';
    readonly children: readonly QueryNode[];
    readonly span: Span;
}

export interface OrNode {
    readonly type: 'or';
    readonly children: readonly QueryNode[];
    readonly span: Span;
}

export type QueryNode =
    FilterNode | ExistsNode | TextNode | ShortcutNode | NotNode | AndNode | OrNode;

export type DiagnosticCode =
    | 'unknown-field'
    | 'missing-value'
    | 'empty-value'
    | 'invalid-value'
    | 'unsupported-operator'
    | 'invalid-wildcard'
    | 'unknown-variable'
    | 'not-nullable'
    | 'text-not-allowed'
    | 'unterminated-quote'
    | 'unbalanced-paren'
    | 'dangling-operator'
    | 'empty-group'
    | 'too-complex';

export interface Diagnostic {
    readonly severity: 'error' | 'warning';
    readonly code: DiagnosticCode;
    readonly message: string;
    readonly start: number;
    readonly end: number;
    readonly suggestions?: readonly string[];
}

export interface ParseResult {
    readonly input: string;
    readonly ast: QueryNode | null;
    readonly diagnostics: readonly Diagnostic[];
    readonly ok: boolean;
}

export interface ParseOptions {
    readonly maxLength?: number;
    readonly maxDepth?: number;
    readonly maxTerms?: number;
}

export type QueryInput = ParseResult | QueryNode | null;
