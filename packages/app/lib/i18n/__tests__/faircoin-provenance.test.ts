import { describe, expect, it } from 'vitest';
import en from '@/lib/i18n/locales/en.json';
import es from '@/lib/i18n/locales/es.json';

/**
 * That the FairCoin card's provenance line actually says where the price came
 * from — the content, not just that a key resolves.
 *
 * The card's own tests mock `t` to echo the key back, which is right for
 * layout: they must not break every time wording changes. But it means they
 * cannot tell "Indexed price" from "Indexed price from the WFAIR/USDC pool on
 * Base", and the whole reason that line exists is the second one. This string
 * was silently shortened to the first once already, and every test stayed
 * green.
 *
 * So this asserts the one thing about the wording that is load-bearing: a price
 * taken from a thin liquidity pool has to name the pool. Everything else about
 * the phrasing is free to change.
 */

const locales = { en, es } as const;

describe('the FairCoin provenance line', () => {
  it.each(Object.keys(locales))('names the pool it was taken from (%s)', (name) => {
    const line: string = locales[name as keyof typeof locales].faircoin.indexed;
    expect(line).toMatch(/WFAIR/);
    expect(line).toMatch(/USDC/);
    // Long enough to be a sentence rather than a label: the label is what the
    // reader gets when the explanation is lost.
    expect(line.length).toBeGreaterThan(30);
  });

  it.each(Object.keys(locales))('says which pool had no price, when it has none (%s)', (name) => {
    const hint: string = locales[name as keyof typeof locales].faircoin.noPriceHint;
    expect(hint).toMatch(/WFAIR/);
  });
});
