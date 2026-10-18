import { COPY_EN, type CopyEntry } from './copy-en';
import { COPY_ES } from './copy-es';

/**
 * A translator keyed the way the Alia app's own catalogue keys its strings, so the app hands its
 * `t` straight in (`labels.t`). The words the chat draws that are not one fixed `labels` field —
 * the thread, its cards, the thought panel, the work log — are asked for by key.
 */
export type Translate = (key: string, params?: Record<string, unknown>) => string;

function entryFor(entry: CopyEntry, count: number | undefined): string {
  if (typeof entry === 'string') return entry;
  if (count === 0 && entry.zero !== undefined) return entry.zero;
  if (count === 1 && entry.one !== undefined) return entry.one;
  return entry.other;
}

/** `{{name}}` and `%{name}` both name a parameter, as in the app's catalogue. */
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}|%\{(\w+)\}/g;

/**
 * The default translator: the English in `copy-en.ts`, with `{{count}}` plurals and parameters.
 * A key it does not know answers itself, so a missing string is visible rather than blank.
 */
function createCopy(catalogue: Readonly<Record<string, CopyEntry>>): Translate {
  return (key, params) => {
    const entry = catalogue[key];
    if (entry === undefined) return key;
    const count = typeof params?.count === 'number' ? params.count : undefined;
    return entryFor(entry, count).replace(PLACEHOLDER, (placeholder, a?: string, b?: string) => {
      const value = params?.[(a ?? b) as string];
      return value === undefined ? placeholder : String(value);
    });
  };
}

export const englishCopy = createCopy(COPY_EN);
export const spanishCopy = createCopy(COPY_ES);
