/** Oxy registry identity of the Alia product. Public identifier, never a credential. */
export const ALIA_APPLICATION_ID = '6a2f851751b784a86fd0e934';
export const ALIA_SERVICE_AUDIENCE = `oxy-service:${ALIA_APPLICATION_ID}` as const;
