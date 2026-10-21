export default {
    '**/*.ts': ['prettier --write', 'eslint --fix --max-warnings=0', 'vitest related --run'],
    '**/*.{json,md,yml,yaml,mjs}': ['prettier --write'],
};
