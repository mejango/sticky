import { fixupConfigRules } from '@eslint/compat'
import { defineConfig, globalIgnores } from 'eslint/config'
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypeScript from 'eslint-config-next/typescript'

export default defineConfig([
  // Next's current plugin set still targets the ESLint 9 rule API. Keep every
  // rule enabled while adapting those plugins to ESLint 10's context API.
  ...fixupConfigRules([...nextCoreWebVitals, ...nextTypeScript]),
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // Sticky renders no HTML strings: React's escaping is the only path from
      // data to the page.
      'react/no-danger': 'error',
      // These rules are React Compiler eligibility checks. The app does not
      // enable the compiler, and adopting them requires deliberate state-model
      // refactors rather than a framework/tooling upgrade.
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    // Production code uses the SDK's supported chain definitions, not viem's
    // all-chain barrel.
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'viem/chains',
              message: "Import chains from '@bananapus/nana-sdk-core/chains'.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ['next.config.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  globalIgnores([
    '.next/**',
    '.next-*/**',
    'coverage/**',
    'playwright-report/**',
    'test-results/**',
    'public/**',
  ]),
])
