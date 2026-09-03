/** Shared documentation for the surviving developer-credential deprecation. */
export const DEPRECATION_DOCS_URL =
  process.env.DEPRECATION_DOCS_URL || 'https://alia.onl/docs/migration/compatibility-window';

/** RFC 9745 / RFC 9651 structured-field Date. */
export function toStructuredFieldDate(when: Date): string {
  return `@${Math.floor(when.getTime() / 1000)}`;
}

/** RFC 8594 HTTP-date. */
export function toHttpDate(when: Date): string {
  return when.toUTCString();
}
