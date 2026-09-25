/**
 * An agent's kind, as stored and as read.
 *
 * The stored value is the English word — it is what the API's generator is
 * told to answer with (`routes/agents/generate.ts`) and what the catalogue
 * filters on — so it is a KEY here, never shown as it is. A category this list
 * does not know (an older row, a hand-edited one) is shown verbatim rather than
 * as a guessed key.
 */
export const AGENT_CATEGORIES = [
  'Assistant',
  'Creative',
  'Developer',
  'Research',
  'Business',
  'Education',
] as const;

type Translate = (key: string, params?: Record<string, unknown>) => string;

export function agentCategoryLabel(category: string, t: Translate): string {
  return (AGENT_CATEGORIES as readonly string[]).includes(category)
    ? t(`agents.categoryName.${category}`)
    : category;
}
