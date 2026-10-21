# searchql

## 1.0.1

### Patch Changes

- 3bb15ec: Fix boolean fields accepting object property names: `draft:constructor` or `draft:__proto__` parsed without errors and passed a function or `{}` on to the SQL, Prisma, Mongo and predicate compilers. They are now reported as `invalid-value`. Compilers also reject hand-built trees whose field name only exists on `Object.prototype`, and `toMongoFilter()` no longer returns a shared object for match-nothing filters.

## 1.0.0

### Major Changes

- Initial release.
- TypeScript support.
- Documentation.
