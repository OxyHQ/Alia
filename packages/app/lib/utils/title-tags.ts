// Known translations of "TITLE" that LLMs may produce
const TAG = String.raw`ALIA_TITLE|TITLE|TÍTULO|TITRE|TITOLO|TITEL|ЗАГОЛОВОК`;

/** Matches complete [TITLE]...[/TITLE] and <TITLE>...</TITLE> tags (including translated variants) */
export const TITLE_STRIP_RE = new RegExp(
  String.raw`\[(${TAG})\].*?\[\/\1\]|<(${TAG})>.*?<\/\2>`, 'gi',
);

