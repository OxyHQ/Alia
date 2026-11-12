/**
 * Gemies (`https://gemies.ai`, Gemies ADR 0034): where the person's gemies, their groups and spaces
 * live. This app is Alia's alone, so whatever belongs to another gemie is a link out to there.
 */
export const GEMIES_URL = 'https://gemies.ai';

/** A gemie's thread in Gemies, by its handle: `https://gemies.ai/@pepe`. */
export function gemieThreadUrl(handle: string): string {
  return `${GEMIES_URL}/@${encodeURIComponent(handle)}`;
}
