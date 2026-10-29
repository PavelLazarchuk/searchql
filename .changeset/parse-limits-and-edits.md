---
'searchql': patch
---

Validate parse limits, and keep unparsed list items when editing a query

- `parse()` throws a `SearchqlError` with code `invalid-option` when `maxLength`, `maxDepth` or `maxTerms` is not a non-negative integer or `Infinity`, or when `options` is not an object. Before, `maxTerms: NaN` or `-1` silently dropped every term and still returned `ok: true`.
- `removeFilter()` (and `toggleFilter()` when it removes) cuts only the matching value out of a list, so items the parser rejected stay as typed: removing `closed` from `status:open,bogus,closed` gives `status:open,bogus`, not `status:open`.
- `toggleFilter()` no longer adds a second comma when the list already ends with one: `label:a,` becomes `label:a,b`, not `label:a,,b`.
