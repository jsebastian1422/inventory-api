import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', 'node_modules/**', '*.cjs', 'migrations/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // Hexagonal rule: the domain must not depend on frameworks, DB or infrastructure.
    files: ['services/*/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '@nestjs/*',
            'fastify',
            'fastify/*',
            'pg',
            'pg/*',
            '**/infrastructure/**',
            '**/application/**',
          ],
        },
      ],
    },
  },
  {
    // Plain Node scripts (not TypeScript): declare the globals they use.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  {
    rules: { '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_' }] },
  },
);
