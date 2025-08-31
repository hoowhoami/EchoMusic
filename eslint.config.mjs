import typescriptEslint from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import vue from 'eslint-plugin-vue';
import js from '@eslint/js';
import globals from 'globals';
import vueParser from 'vue-eslint-parser';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'electron/dist/**', 'server/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,ts}'],
    plugins: {
      '@typescript-eslint': typescriptEslint,
    },
    languageOptions: {
      parser: typescriptParser,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      ...typescriptEslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['**/*.vue'],
    plugins: {
      vue,
      '@typescript-eslint': typescriptEslint,
    },
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: typescriptParser,
        sourceType: 'module',
        ecmaVersion: 'latest',
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      'vue/multi-word-component-names': 'off',
      'vue/max-attributes-per-line': ['error', { singleline: 3, multiline: 1 }],
      'vue/no-unused-vars': 'error',
      'vue/require-v-for-key': 'error',
      'vue/valid-v-model': 'error',
      'vue/valid-v-for': 'error',
      'vue/return-in-computed-property': 'error',
      'vue/no-side-effects-in-computed-properties': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-require-imports': 'off',
      'no-undef': 'off',
    },
  },
  {
    files: ['**/*.{js,ts,vue}'],
    plugins: {
      '@typescript-eslint': typescriptEslint,
    },
    rules: {
      semi: ['error', 'always'],
      quotes: ['error', 'single'],
      'comma-dangle': ['error', 'always-multiline'],
    },
  },
  {
    files: ['**/.eslintrc.{js,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
      ecmaVersion: 5,
      sourceType: 'commonjs',
    },
  },
];
