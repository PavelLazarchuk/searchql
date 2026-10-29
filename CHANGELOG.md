# searchql

## 1.0.2

### Patch Changes

- ae966d3: Validate parse limits, and keep unparsed list items when editing a query

    - `parse()` throws a `SearchqlError` with code `invalid-option` when `maxLength`, `maxDepth` or `maxTerms` is not a non-negative integer or `Infinity`, or when `options` is not an object. Before, `maxTerms: NaN` or `-1` silently dropped every term and still returned `ok: true`.
    - `removeFilter()` (and `toggleFilter()` when it removes) cuts only the matching value out of a list, so items the parser rejected stay as typed: removing `closed` from `status:open,bogus,closed` gives `status:open,bogus`, not `status:open`.
    - `toggleFilter()` no longer adds a second comma when the list already ends with one: `label:a,` becomes `label:a,b`, not `label:a,,b`.

## 1.0.1

### Patch Changes

- 3bb15ec: Fix boolean fields accepting object property names: `draft:constructor` or `draft:__proto__` parsed without errors and passed a function or `{}` on to the SQL, Prisma, Mongo and predicate compilers. They are now reported as `invalid-value`. Compilers also reject hand-built trees whose field name only exists on `Object.prototype`, and `toMongoFilter()` no longer returns a shared object for match-nothing filters.

## 1.0.0

### Major Changes

- Initial release.
- TypeScript support.
- Documentation.
