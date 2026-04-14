// For more info, see https://github.com/storybookjs/eslint-plugin-storybook#configuration-flat-config-format
import storybook from "eslint-plugin-storybook";

import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([globalIgnores(['dist', 'storybook-static']), {
  files: ['**/*.{ts,tsx}'],
  extends: [
    js.configs.recommended,
    tseslint.configs.recommended,
    reactHooks.configs.flat.recommended,
    reactRefresh.configs.vite,
  ],
  plugins: {
    'jsx-a11y': jsxA11y,
  },
  rules: {
    ...jsxA11y.configs.recommended.rules,
    // Progressive a11y: warn on common issues to surface them without blocking CI
    'jsx-a11y/click-events-have-key-events': 'warn',
    'jsx-a11y/no-static-element-interactions': 'warn',
    'jsx-a11y/no-autofocus': 'warn',
    'jsx-a11y/no-noninteractive-element-interactions': 'warn',
    'jsx-a11y/label-has-associated-control': 'warn',
    // React Compiler rules — warn-only since we don't use the compiler yet
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    'react-hooks/set-state-in-effect': 'warn',
    'react-hooks/refs': 'warn',
    'react-hooks/purity': 'warn',
    'react-hooks/preserve-manual-memoization': 'warn',
  },
  languageOptions: {
    ecmaVersion: 2020,
    globals: globals.browser,
  },
}, {
  // Test files legitimately need `any` (mocks), unused bindings (setup code),
  // `this` aliasing (simulating event targets), and `require()` for dynamic
  // module mocks. Relaxed to warnings so test-only dead code still surfaces.
  files: ['tests/**/*.{ts,tsx}'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': 'warn',
    '@typescript-eslint/no-this-alias': 'off',
    '@typescript-eslint/no-require-imports': 'off',
  },
}, ...storybook.configs["flat/recommended"]])
