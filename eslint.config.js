import pluginVue from 'eslint-plugin-vue';
import vueTsEslintConfig from '@vue/eslint-config-typescript';
import vuePrettierConfig from '@vue/eslint-config-prettier';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist-electron/**',
      'out/**',
      'release/**',
      '**/*.json',
      '**/*.md',
      '**/*.d.ts',
      'public/**',
      'server/**',
      // Rust 构建产物，体积可达数 GB，不参与前端 lint
      'native/**/target/**',
      // native 目录内附带的第三方 vendor 代码，不属于本项目源码
      'native/**/vendor/**',
      // electron-builder 下载/生成的运行时目录
      'build/mpv/**',
      'build/taskbar-layout/**',
      // 本地插件目录不属于仓库源码（由 .git/info/exclude 排除），
      // 避免开发者本地的插件源码/依赖把 lint 结果淹没
      'plugins/**',
      '.gitignore',
      '.DS_Store',
      // 本地调试/实验产物，不属于仓库源码
      '.zcode/**',
    ],
  },
  ...pluginVue.configs['flat/essential'],
  ...vueTsEslintConfig(),
  vuePrettierConfig,
  {
    rules: {
      'prettier/prettier': [
        'error',
        {
          singleQuote: true,
          semi: true,
          trailingComma: 'all',
        },
      ],
      'vue/multi-word-component-names': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['build/**/*.{js,cjs}', 'scripts/**/*.{js,cjs}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // 测试代码里的 mock/harness 常有「占位绑定」与 `const self = this` 惯用写法：
    // 这些不是产品代码缺陷，降为 warn 保留提示，但不阻塞 CI。
    files: ['tests/**'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
    },
  },
];
