import 'pinia';

declare module 'pinia' {
  export interface DefineStoreOptionsBase<S, Store> {
    persist?:
      | boolean
      | {
          pick?: string[];
          omit?: string[];
        };
  }
}
