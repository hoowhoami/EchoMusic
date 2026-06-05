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

declare module '@vue/runtime-core' {
  interface ComponentCustomProperties {
    $echo: EchoGlobalRuntime;
  }
}
