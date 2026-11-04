import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            'commander',
            '@modelcontextprotocol/*',
            '@deepseek-ai/*',
            '@paper-craft/cli',
            '@paper-craft/cli/*',
            '@paper-craft/mcp',
            '@paper-craft/mcp/*',
            '**/cli/**',
            '**/mcp/**',
            '**/tools/**',
          ],
        },
      ],
    },
  },
  {
    files: ['packages/{cli,mcp}/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['**/core/src/**', '**/core/dist/**', '**/tools/**'],
        },
      ],
    },
  },
  {
    files: ['packages/mcp/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            'commander',
            '@paper-craft/cli',
            '@paper-craft/cli/*',
            '**/cli/**',
            '**/core/src/**',
            '**/core/dist/**',
          ],
        },
      ],
    },
  },
  {
    ignores: ['**/dist/', '**/node_modules/', '**/web/'],
  },
);
