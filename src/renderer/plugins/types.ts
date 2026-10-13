import type { App as VueApp } from 'vue';
import type { Pinia } from 'pinia';
import type { Router } from 'vue-router';
import type { pluginRuntimeState } from './runtime';

export interface EchoGlobalRuntime {
  app: VueApp;
  router: Router;
  pinia: Pinia;
  plugins: typeof pluginRuntimeState;
  executeCommand: (id: string, ...args: unknown[]) => unknown;
}

// 扩充 'vue' 而不是 '@vue/runtime-core'：后者不是直接依赖，pnpm 的非提升
// node_modules 布局下 TS 解析不到它，会报
// "Invalid module name in augmentation, module '@vue/runtime-core' cannot be
// found"。'vue' 是直接依赖且官方文档推荐的目标，vue-router / pinia 同样扩充它。
declare module 'vue' {
  interface ComponentCustomProperties {
    $echo: EchoGlobalRuntime;
  }
}
