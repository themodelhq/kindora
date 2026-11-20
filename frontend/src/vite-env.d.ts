/// <reference types="vite/client" />

interface ImportMetaEnv {
  VITE_APP_NAME?: string;
  VITE_APP_URL?: string;
  VITE_API_URL?: string;
  VITE_ENVIRONMENT?: string;
  VITE_DEFAULT_CURRENCY?: string;
  VITE_DEFAULT_LANGUAGE?: string;
  VITE_DEMO_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
