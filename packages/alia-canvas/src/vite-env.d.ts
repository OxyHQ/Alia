/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Alia workflow API (workflows, execute, models). */
  readonly VITE_API_URL?: string;
  /** Base URL of the Oxy API used by OxyProvider for authentication. */
  readonly VITE_OXY_URL?: string;
  /** Registered Oxy application client id for this app. */
  readonly VITE_OXY_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
