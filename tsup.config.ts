import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts', 'src/sql/index.ts', 'src/prisma/index.ts', 'src/mongo/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    splitting: true,
    treeshake: true,
    target: 'es2020',
});
