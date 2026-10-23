/** Own audio calls share Oxy's session transport; explicit external bearers remain supported. */
export type AudioRequestAuthentication =
  | { readonly transport: { fetch: typeof globalThis.fetch }; readonly token?: never }
  | { readonly token: string; readonly transport?: never };
