import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov'],
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.test.ts', 'src/test-utils/**', 'src/index.ts'],
            thresholds: {
                lines: 95,
                statements: 95,
                functions: 95,
                branches: 90,
            },
        },
    },
});
