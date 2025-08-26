declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

declare interface Window {
  $globalLoading: {
    show: (message?: string) => void;
    hide: () => void;
  };
}
