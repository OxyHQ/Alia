/** Commas of the languages the apps greet in: Latin, fullwidth, ideographic and Arabic. */
const COMMA = /[,，、،]/;

/**
 * A greeting in two lines: the address ("Hi Nate,") over the rest ("what's on your mind?"). It
 * breaks after the first comma, which keeps the greeting one string a translator writes once; a
 * greeting without one (or with nothing after it) stays a single line.
 */
export function greetingLines(greeting: string): [string] | [string, string] {
  const at = greeting.search(COMMA);
  if (at < 0) return [greeting];
  const first = greeting.slice(0, at + 1);
  const rest = greeting.slice(at + 1).trim();
  return rest === '' ? [greeting] : [first, rest];
}
