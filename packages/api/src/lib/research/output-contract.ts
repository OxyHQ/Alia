/**
 * Output contract — what SHAPE the person asked their research answer to take.
 *
 * Research mode used to answer every request the same way: five angles, a
 * 800–1500 word report with headings, tables and a "limitations" section. A
 * request like «resume en dos frases qué es React con una fuente» carries its
 * own, very different, contract — two sentences, one source — and the report
 * template ran straight over it (#541). Worse, the decomposer turned the
 * FORMAT words into research angles ("how to write a two-sentence summary",
 * "citation styles"), so half the sources were about summarising rather than
 * about React.
 *
 * This module reads the contract out of the request BEFORE decomposition, so
 * that (a) the decomposer and the fallback search queries see the SUBJECT, and
 * (b) the synthesiser is told the length, shape, language and source count the
 * person actually asked for. It is a deterministic parser rather than a model
 * call on purpose: it costs nothing, it cannot fail, and it does not add a
 * phase to the progress stream the SDK and the flow fixtures pin.
 *
 * When nothing is detected the contract is `report`, which keeps the existing
 * long-form behaviour byte for byte.
 */

export type OutputShape = 'report' | 'sentences' | 'paragraphs' | 'bullets' | 'words' | 'brief';

export interface OutputContract {
  /** The requested shape. `report` is the default long-form behaviour. */
  shape: OutputShape;
  /** Exact count for `sentences`, `paragraphs`, `bullets`; a ceiling for `words`. */
  count?: number;
  /** A language the request named explicitly (English name); otherwise mirror the request. */
  language?: string;
  /** How many sources were asked for, when the request named a number ("con una fuente"). */
  sourceCount?: number;
  /** Whether the request asked for a source/citation at all. */
  wantsSources: boolean;
  /**
   * The request with its formatting instructions removed — what the research
   * is ABOUT. Used for the fallback decomposition and reformulated searches so
   * "resume en dos frases qué es React" searches for React, not for résumés.
   */
  subject: string;
}

const NUMBER_WORDS: Record<string, number> = {
  // English
  a: 1, an: 1, one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  // Spanish (accents stripped before lookup)
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
};

/** Two and up, in digits or words: a plural count never collides with an article. */
const PLURAL = String.raw`(\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)`;
/** The singular forms, which are also articles ("a sentence embedding"), so they only count after a preposition. */
const SINGULAR = String.raw`(a|an|one|single|un|una|uno)`;

/**
 * Strip accents and case so «párrafo» and «parrafo» match one pattern.
 *
 * Folded ONE CODE UNIT AT A TIME, so the result is exactly as long as the
 * input and a match index in the folded text is the same index in the
 * original. A whole-string `normalize('NFD')` would not be: a precomposed `é`
 * expands to two code units and loses one, so «qué es React» comes back one
 * unit shorter and every span after it is off by one. A unit whose fold is not
 * itself a single unit (a lone surrogate, `İ`) is kept as it is.
 */
function fold(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const unit = text[i];
    const folded = unit.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    out += folded.length === 1 ? folded : unit;
  }
  return out;
}

function toCount(token: string): number | undefined {
  const digits = Number.parseInt(token, 10);
  if (Number.isFinite(digits)) return digits;
  // The token is the person's own text, so it can be "constructor" or
  // "valueOf"; those are inherited and are not numbers.
  if (!Object.hasOwn(NUMBER_WORDS, token)) return undefined;
  return NUMBER_WORDS[token];
}

interface ShapeRule {
  shape: OutputShape;
  re: RegExp;
  /** Which capture group holds the count, if any. */
  countGroup?: number;
}

/**
 * Ordered: the first match wins, so explicit counts come before the vague
 * "brief" words. Every pattern is written against the FOLDED request.
 */
const SHAPE_RULES: ShapeRule[] = [
  { shape: 'sentences', re: new RegExp(String.raw`\b(?:in|en|de|con|of|using)?\s*${PLURAL}[\s-]*(sentences?|frases?|oraciones?|lineas?|lines?)\b`), countGroup: 1 },
  { shape: 'sentences', re: new RegExp(String.raw`\b(?:in|en)\s+${SINGULAR}[\s-]*(sentence|frase|oracion|linea|line)\b`), countGroup: 1 },
  { shape: 'words', re: new RegExp(String.raw`\b(?:in|en|de|under|max(?:imum|imo)?|at most|no more than|menos de|como maximo|hasta)?\s*(\d{1,4})[\s-]*(words?|palabras?)\b`), countGroup: 1 },
  { shape: 'bullets', re: new RegExp(String.raw`\b${PLURAL}[\s-]*(bullets?|bullet points?|puntos|vinetas)\b`), countGroup: 1 },
  { shape: 'paragraphs', re: new RegExp(String.raw`\b(?:in|en|de)?\s*${PLURAL}[\s-]*(paragraphs?|parrafos?)\b`), countGroup: 1 },
  { shape: 'paragraphs', re: new RegExp(String.raw`\b(?:in|en)\s+${SINGULAR}[\s-]*(paragraph|parrafo)\b`), countGroup: 1 },
  { shape: 'bullets', re: /\b(bullet(?:ed)? ?(?:list|points?)|as a list|in a list|lista de puntos|en (?:una )?lista|en vinetas|en puntos|con vinetas)\b/ },
  { shape: 'brief', re: /\b(briefly|in brief|in short|in a nutshell|tl;?dr|short answer|quick answer|concisely|brevemente|en breve|resumidamente|en pocas palabras|respuesta corta|respuesta breve|de forma breve|de forma concisa)\b/ },
];

const SOURCE_RULES: RegExp[] = [
  new RegExp(String.raw`\b(?:with|citing|cite|using|include|con|cita(?:ndo)?|incluye(?:ndo)?|usando)\s+(?:${PLURAL}|${SINGULAR})\s+(sources?|references?|citations?|links?|fuentes?|referencias?|citas?|enlaces?)\b`),
  /\b(?:with|citing|cite|include|con|cita(?:ndo)?|incluye(?:ndo)?)\s+(?:the\s+|its\s+|las?\s+|sus?\s+)?(sources?|references?|citations?|links?|fuentes?|referencias?|citas?|enlaces?)\b/,
];

/** Explicitly named target languages; anything else means "mirror the request". */
const LANGUAGE_RULES: Array<{ language: string; re: RegExp }> = [
  { language: 'English', re: /\b(in english|en ingles|in inglese|en anglais|auf englisch)\b/ },
  { language: 'Spanish', re: /\b(in spanish|en espanol|en castellano|in spagnolo|en espagnol|auf spanisch)\b/ },
  { language: 'French', re: /\b(in french|en frances|en francais|auf franzosisch)\b/ },
  { language: 'German', re: /\b(in german|en aleman|auf deutsch|in tedesco)\b/ },
  { language: 'Portuguese', re: /\b(in portuguese|en portugues|em portugues)\b/ },
  { language: 'Italian', re: /\b(in italian|en italiano|in italiano)\b/ },
  { language: 'Catalan', re: /\b(in catalan|en catalan|en catala)\b/ },
];

/**
 * Leading imperatives that frame HOW to answer rather than what to answer
 * about. Removed from the subject only at the very start of the request, so a
 * subject that legitimately contains "summary" in the middle survives.
 */
const LEADING_INSTRUCTION_RE =
  /^(?:(?:please|por favor|hey|hi|hola)[,\s]+)?(?:(?:can|could|would) you\s+|(?:puedes|podrias)\s+)?(?:summari[sz]e|sum up|resume|resumeme|resumir|haz(?:me)? un resumen de|hazme un resumen de|explain|explica(?:me)?|describe|tell me|dime|cuentame|give me|dame|write|escribe|research|investiga|find out|averigua)\s*(?:me\s+)?(?:briefly\s+|brevemente\s+)?(?:about|sobre|de|acerca de|what is|what are|que es|que son|cual es|cuales son)?\s*/;

/**
 * Detect the output contract carried by a research request.
 *
 * The return value is total: every request yields a contract, and one that
 * carries no instruction yields the `report` default with `subject` equal to
 * the request itself.
 */
export function parseOutputContract(query: string): OutputContract {
  const folded = fold(query);
  // Spans of the folded text that are instructions rather than subject. The
  // fold is length-preserving for the characters we care about (NFD strips
  // combining marks only), so indices are mapped back onto the original.
  const removed: Array<[number, number]> = [];

  let shape: OutputShape = 'report';
  let count: number | undefined;
  for (const rule of SHAPE_RULES) {
    const m = rule.re.exec(folded);
    if (!m) continue;
    shape = rule.shape;
    if (rule.countGroup !== undefined) count = toCount(m[rule.countGroup]);
    removed.push([m.index, m.index + m[0].length]);
    break;
  }
  // A count that parsed to nothing usable is a report of the default shape.
  if (shape !== 'report' && shape !== 'bullets' && shape !== 'brief' && (count === undefined || count <= 0)) {
    shape = 'report';
    count = undefined;
    removed.length = 0;
  }

  let wantsSources = false;
  let sourceCount: number | undefined;
  for (const [i, re] of SOURCE_RULES.entries()) {
    const m = re.exec(folded);
    if (!m) continue;
    wantsSources = true;
    if (i === 0) sourceCount = toCount(m[1] ?? m[2]);
    removed.push([m.index, m.index + m[0].length]);
    break;
  }

  let language: string | undefined;
  for (const rule of LANGUAGE_RULES) {
    const m = rule.re.exec(folded);
    if (!m) continue;
    language = rule.language;
    removed.push([m.index, m.index + m[0].length]);
    break;
  }

  const subject = buildSubject(query, removed);

  return {
    shape,
    ...(count !== undefined ? { count } : {}),
    ...(language ? { language } : {}),
    ...(sourceCount !== undefined ? { sourceCount } : {}),
    wantsSources,
    subject,
  };
}

/**
 * The request minus its instruction spans and its leading imperative, or the
 * whole request when that would leave nothing. `fold` is length-preserving,
 * which is what lets spans found in the folded text be cut from the original.
 */
function buildSubject(original: string, removed: Array<[number, number]>): string {
  let out = '';
  for (let i = 0; i < original.length; i += 1) {
    if (removed.some(([start, end]) => i >= start && i < end)) continue;
    out += original[i];
  }
  out = out.replace(/\s+/g, ' ').replace(/\s+([,.;:?!])/g, '$1').trim();

  const foldedOut = fold(out);
  const lead = LEADING_INSTRUCTION_RE.exec(foldedOut);
  if (lead && lead[0].length > 0 && lead[0].length < foldedOut.length) {
    out = out.slice(lead[0].length).trim();
  }
  out = out.replace(/^[,.;:\s]+|[,.;:\s?¿¡!]+$/g, '').trim();

  return out.length >= 3 ? out : original.trim();
}

/**
 * The synthesis instructions for a contract, as a system-prompt fragment.
 *
 * The `report` text is the original prompt, kept verbatim so the default
 * behaviour does not drift. Every other shape says three things the report
 * template contradicts: the exact length, no scaffolding, and that the
 * references section is appended by the engine and must not be written.
 */
export function describeOutputContract(contract: OutputContract): string {
  const language = contract.language
    ? `Write in ${contract.language}.`
    : 'Write in the same language as the original query.';

  if (contract.shape === 'report') {
    return `You are a senior research analyst producing a comprehensive, well-structured report. Requirements:
- Use clear headings and sections
- Include inline citations [1], [2], etc. referencing the source numbers from the findings
- Be thorough but concise — aim for 800-1500 words
- Highlight key takeaways
- Note any limitations or areas needing further research
- Use professional tone
- ${language}
Do NOT include a references section — it will be added automatically.`;
  }

  const sources = contract.sourceCount
    ? `Cite exactly ${contract.sourceCount} source${contract.sourceCount === 1 ? '' : 's'} inline as [n], using the source numbers from the findings.`
    : 'Cite inline as [n], using the source numbers from the findings; cite only what the answer actually rests on.';

  let length: string;
  switch (contract.shape) {
    case 'sentences':
      length = `Answer in EXACTLY ${contract.count} sentence${contract.count === 1 ? '' : 's'} of plain prose, as one paragraph.`;
      break;
    case 'words':
      length = `Answer in at most ${contract.count} words of plain prose.`;
      break;
    case 'paragraphs':
      length = `Answer in EXACTLY ${contract.count} paragraph${contract.count === 1 ? '' : 's'} of plain prose.`;
      break;
    case 'bullets':
      length = contract.count
        ? `Answer as a bullet list of EXACTLY ${contract.count} items, one line each, and nothing else.`
        : 'Answer as a short bullet list, one line per item, and nothing else.';
      break;
    default:
      length = 'Answer briefly: one short paragraph at most.';
  }

  return `You are a research analyst answering a specific request. The user asked for a SHORT answer, and the length they asked for is the contract:
- ${length}
- ${language}
- ${sources}
- Do NOT add headings, titles, tables, sections, bullet lists (unless asked), key takeaways, limitations, preambles such as "Research complete", meta-commentary, or instructions on how to write or cite.
- Do NOT describe the research process; answer the question directly.
Do NOT include a references section — it will be added automatically.`;
}

/**
 * Whether a sub-question is ABOUT the request's format rather than its subject.
 *
 * These are the angles that pulled "how to write summaries" and "citation
 * styles" into a question about React. Matched on the folded text so accents
 * and case do not matter.
 */
const META_SUBQUESTION_RES: RegExp[] = [
  // "how to …", "tips for …", "best practices for …" leading into a writing
  // verb. The lead-in is the infinitive/advice form on purpose: "how do
  // citation networks …" is a question ABOUT citations and stays.
  /\b(how to|how (?:do|can|should) (?:i|you|we|one)|ways? to|tips? (?:for|on|to)|best practices? (?:for|on)|guidelines? (?:for|on)|techniques? (?:for|on|to)|methods? (?:for|of|to)|steps? (?:for|to))\b[^.?!]{0,40}\b(summari[sz]e|summari[sz]ing|summary|summaries|paraphras\w*|condens\w*|cite|citing|citations?|reference|write|writing|structure|format|concise|brevity)\b/,
  /\b(summari[sz]ation|summary|citation|referencing|paraphrasing)\s+(techniques?|tips?|guidelines?|best practices?|styles?|formats?|methods?|skills?)\b/,
  /\b(two|one|three|\d+)[\s-]*(sentence|paragraph|word)s?\s+(summary|summaries|answer|explanation)\b/,
  /\b(como|formas?|consejos?|tecnicas?|pautas?|guia|metodos?|pasos?)\b[^.?!]{0,60}\b(resumir|resumen|resumenes|parafrasear|condensar|citar|cita|citas|referenciar|referencias?|redactar|escribir|estructurar|formatear|concis)/,
  /\b(tecnicas?|consejos?|pautas?|estilos?|formatos?|metodos?)\s+(de|para)\s+(resumir|resumen|citar|citas|referencias?|redaccion|escritura)\b/,
  /\b(en|de)\s+(una|dos|tres|\d+)\s+(frases?|oraciones?|parrafos?|palabras)\b/,
];

export function isMetaSubQuestion(subQuestion: string): boolean {
  const folded = fold(subQuestion);
  return META_SUBQUESTION_RES.some((re) => re.test(folded));
}
