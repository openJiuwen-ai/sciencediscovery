/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API prefix used to resolve downloads, e.g. `/api/v1`. Empty means static. */
  readonly VITE_HUB_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
