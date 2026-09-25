import { describe, expect, it } from 'vitest';
import en from '@/shared/i18n/locales/en.json';
import es from '@/shared/i18n/locales/es.json';

/**
 * The two catalogs say the same things.
 *
 * `i18n.enableFallback` papers over a key missing from `es.json`: the Spanish
 * reader gets the English string, silently, and nothing fails. That is how the
 * whole security settings page and the agent reviews came to be English in
 * Spanish (#608) — 35 keys that existed in one file only. So parity is asserted
 * rather than hoped for, and with it the two ways a translation breaks a
 * string without removing it: an empty value, and a placeholder that one
 * language spells differently (`{{count}}` in English, `{{cuenta}}` in Spanish
 * interpolates nothing).
 */

type Catalog = { [key: string]: string | Catalog };

/** A plural entry is a leaf: its `one`/`other` forms differ by language. */
const PLURAL_FORMS = new Set(['zero', 'one', 'other']);
const isPlural = (value: Catalog): boolean =>
  Object.keys(value).length > 0 && Object.keys(value).every((key) => PLURAL_FORMS.has(key));

function leaves(catalog: Catalog, prefix = ''): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') out.set(path, [value]);
    else if (isPlural(value)) out.set(path, Object.values(value) as string[]);
    else for (const [inner, strings] of leaves(value, path)) out.set(inner, strings);
  }
  return out;
}

const placeholders = (strings: string[]): string[] =>
  [...new Set(strings.flatMap((text) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}|%\{(\w+)\}/g)].map((m) => m[1] ?? m[2])))].sort();

const EN = leaves(en as Catalog);
const ES = leaves(es as Catalog);

describe('the locale catalogs', () => {
  it('are read at all', () => {
    expect(EN.size).toBeGreaterThan(1000);
  });

  it('have exactly the same keys', () => {
    expect([...EN.keys()].filter((key) => !ES.has(key))).toEqual([]);
    expect([...ES.keys()].filter((key) => !EN.has(key))).toEqual([]);
  });

  it('have no empty strings, except an affix one language does not need', () => {
    // `effort.headlinePrefix` is "" in English and a word in Spanish: word
    // order differs, so an affix may legitimately be nothing.
    const empty = [...EN, ...ES].filter(
      ([key, strings]) => !/(Prefix|Suffix)$/.test(key) && strings.some((text) => text.trim() === ''),
    );
    expect(empty.map(([key]) => key)).toEqual([]);
  });

  it('interpolate the same placeholders in both languages', () => {
    const mismatched = [...EN]
      .filter(([key]) => ES.has(key))
      .filter(([key, strings]) => placeholders(strings).join() !== placeholders(ES.get(key)!).join())
      .map(([key]) => key);
    expect(mismatched).toEqual([]);
  });
});
