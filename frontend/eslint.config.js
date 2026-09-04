import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * Deliberately modest: correctness and hook rules, not formatting opinions.
 * A contributor should be able to run this and see only real problems.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '*.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // An unused name prefixed with _ is an intentional placeholder.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      // Filenames and marker titles are sanitized by stripping C0 control
      // characters. Matching them in a regex is the point, not a mistake.
      'no-control-regex': 'off',
      // The React Compiler rules from eslint-plugin-react-hooks v7. The tree is
      // clean against them, so they are errors: the handful of places the
      // analyzer cannot see through carry a local disable saying why.
      'react-hooks/refs': 'error',
      'react-hooks/purity': 'error',
      'react-hooks/set-state-in-effect': 'error',
    },
  },
  {
    // Node test files run outside the browser and use node: builtins.
    files: ['**/*.test.ts', '**/*.benchmark.ts'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
)
