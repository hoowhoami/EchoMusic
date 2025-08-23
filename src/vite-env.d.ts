/// <reference types="vite/client" />

// 如果使用 Vite，也可以直接使用 Vite 提供的类型
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_APP_TITLE?: string;
  // 更多环境变量...
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
