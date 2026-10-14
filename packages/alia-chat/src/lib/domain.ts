/**
 * The host of a URL, or the string itself when it is not one. Citations drop a leading `www.`
 * (the number in `[3]` names a site); a source row in the work log keeps the host as served.
 */
export function domainOf(url: string, { stripWww = false }: { stripWww?: boolean } = {}): string {
  try {
    const host = new URL(url).hostname;
    return stripWww ? host.replace(/^www\./, '') : host;
  } catch {
    return url;
  }
}
