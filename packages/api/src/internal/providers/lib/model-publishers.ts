/**
 * Who RELEASED a model, as opposed to who serves it.
 *
 * ## The distinction, and why it needs its own vocabulary
 *
 * `PROVIDER_NAMES` answers "whose endpoint does this request go to". This
 * answers "whose work is the model". They are different questions with
 * different answers, and the routing table proves it in one line:
 * `createMapping('digitalocean', 'openai', 'openai-gpt-oss-20b', …)` — a model
 * OpenAI released, served by DigitalOcean. `llama-3.3-70b` is Meta's and
 * reaches users through cerebras, groq, novita, replicate, sambanova and
 * digitalocean under six different id spellings.
 *
 * Several names appear in BOTH lists — `openai`, `google`, `anthropic`,
 * `mistral`, `deepseek`, `cohere`, `xai`, `perplexity` all publish models and
 * also operate endpoints. That overlap is real and is why a leak census cannot
 * be "no provider name appears anywhere": it has to be scoped to the fields
 * permitted to carry a model's public identity.
 *
 * ## Why this is authored rather than derived
 *
 * Because it cannot be derived. Measured over the 115 mappings in
 * `generate-model-mappings.ts`: 97 of the model ids are bare names carrying no
 * publisher token at all (`gemini-2.5-flash`, `deepseek-chat`, `llama-3.3-70b`),
 * 10 carry a `<prefix>/<name>` shape, 5 carry other slashes and 3 are a
 * Fireworks account path. A parse would answer for about a sixth of the table
 * and guess the rest — which is the hand-maintained mapping epic #139 removed,
 * wearing a regex.
 *
 * And where a prefix IS present it is not always the publisher:
 * `fal-ai/fast-sdxl` names fal, an inference platform, for a model Stability AI
 * released. So the prefix is not even a reliable signal where it exists.
 *
 * ## The shape
 *
 * `publisher/model`, matching the identity vocabulary the Oxy inference control
 * plane uses, where the publisher is who released the weights and never who
 * serves them. Alia keeps the two halves as separate fields rather than one
 * joined string, because the serving side already keys on `modelId` verbatim
 * and a joined identity would have to be split again at every call.
 */

/**
 * Every organisation that publishes a model this service can route to.
 *
 * A closed, committed list, and deliberately NOT derived from the mapping table
 * it describes: derived from the table, it would accept whatever the table
 * happened to say, including a serving provider typed into the publisher slot.
 * `__tests__/model-publishers.test.ts` asserts the table uses exactly these and
 * that at least one mapping's publisher differs from its provider.
 */
export const MODEL_PUBLISHERS = [
  'alibaba',
  'anthropic',
  'black-forest-labs',
  'cohere',
  'deepseek',
  'elevenlabs',
  'google',
  'meta',
  'mistral',
  'openai',
  'perplexity',
  'stability',
  'xai',
] as const;

export type ModelPublisher = (typeof MODEL_PUBLISHERS)[number];

const PUBLISHER_SET: ReadonlySet<string> = new Set(MODEL_PUBLISHERS);

/** Whether a string names a publisher this service knows. */
export function isModelPublisher(value: string): value is ModelPublisher {
  return PUBLISHER_SET.has(value);
}

/**
 * How a publisher is written for a person to read.
 *
 * Only the names whose casing a reader would notice. Anything absent is
 * title-cased from the key, so a new publisher renders acceptably the moment it
 * is added to {@link MODEL_PUBLISHERS} rather than rendering as a slug until
 * someone remembers this map — the failure mode of a display table that has to
 * be kept in step with an identity table.
 */
const DISPLAY_NAME: Partial<Record<ModelPublisher, string>> = {
  'black-forest-labs': 'Black Forest Labs',
  deepseek: 'DeepSeek',
  elevenlabs: 'ElevenLabs',
  openai: 'OpenAI',
  xai: 'xAI',
};

export function publisherDisplayName(publisher: ModelPublisher): string {
  const explicit = DISPLAY_NAME[publisher];
  if (explicit !== undefined) return explicit;
  return publisher
    .split('-')
    .map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1))
    .join(' ');
}
