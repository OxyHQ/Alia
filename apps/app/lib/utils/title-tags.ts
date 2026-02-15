/** Matches complete [TITLE]...[/TITLE] and <TITLE>...</TITLE> tags */
export const TITLE_STRIP_RE = /\[TITLE\].*?\[\/TITLE\]|<TITLE>.*?<\/TITLE>/g;

/** Also matches incomplete/partial title tags at end of stream (for streaming display) */
export const TITLE_PARTIAL_RE = /\[TITLE\].*?(\[\/TITLE\])?$|<TITLE>.*?(<\/TITLE>)?$/s;

/** Extract the title value from content and return cleaned content + title */
export function extractTitle(content: string): { content: string; title: string | null } {
  const titleMatch = content.match(/\[TITLE\](.*?)\[\/TITLE\]|<TITLE>(.*?)<\/TITLE>/);
  if (titleMatch) {
    return {
      content: content.replace(TITLE_STRIP_RE, '').trim(),
      title: (titleMatch[1] || titleMatch[2]).trim(),
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
