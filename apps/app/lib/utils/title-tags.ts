// Known translations of "TITLE" that LLMs may produce
const TAG = String.raw`CLARITY_TITLE|TITLE|TÍTULO|TITRE|TITOLO|TITEL|ЗАГОЛОВОК`;

/** Matches complete [TITLE]...[/TITLE] and <TITLE>...</TITLE> tags (including translated variants) */
export const TITLE_STRIP_RE = new RegExp(
  String.raw`\[(${TAG})\].*?\[\/\1\]|<(${TAG})>.*?<\/\2>`, 'gi',
);

/** Also matches incomplete/partial title tags at end of stream (for streaming display) */
export const TITLE_PARTIAL_RE = new RegExp(
  String.raw`\[(${TAG})\].*?(\[\/\1\])?$|<(${TAG})>.*?(<\/\3>)?$`, 'si',
);

/** Regex to extract the title value from the first matching tag */
const TITLE_EXTRACT_RE = new RegExp(
  String.raw`\[(${TAG})\](.*?)\[\/\1\]|<(${TAG})>(.*?)<\/\3>`, 'i',
);

/** Extract the title value from content and return cleaned content + title */
export function extractTitle(content: string): { content: string; title: string | null } {
  const titleMatch = content.match(TITLE_EXTRACT_RE);
  if (titleMatch) {
    return {
      content: content.replace(TITLE_STRIP_RE, '').trim(),
      title: (titleMatch[2] || titleMatch[4]).trim(),
    };
  }
  return { content, title: null };
}

/** Strip complete title tags from content (for final/stored text) */
export function stripTitleTags(content: string): string {
  return content.replace(TITLE_STRIP_RE, '').trim();
}

/** Strip both complete and partial title tags (for streaming display) */
export function stripTitleTagsPartial(content: string): string {
  return content.replace(TITLE_STRIP_RE, '').replace(TITLE_PARTIAL_RE, '').trim();
}
