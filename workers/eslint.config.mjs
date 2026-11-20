// ESLint flat config for @kindora/workers. Used by `npm run lint:check`.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '*.js'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Workers intentionally use console-based structured logging and
      // occasional `require`-free CommonJS style; keep the recommended set
      // strict but quiet on stylistic-only complaints.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
    },
  },
);
