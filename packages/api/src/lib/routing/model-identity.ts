/**
 * A model's identity — `<publisher>/<model>` — and the words a person reads for
 * it (ADR 0003).
 *
 * ADR 0003 makes `<publisher>/<model>` the canonical form of a model reference:
 * who released the weights, and what they called them. Neither half is ever the
 * operator that serves a deployment — *the provider is a property of the
 * deployment, not of the model* — so nothing on this page can name one, and
 * nothing on it is derived from a deployment id.
 *
 * ## Both halves are AUTHORED, and this module never parses one out of an id
 *
 * `internal/providers/lib/model-publishers.ts` records why: 97 of the mappings
 * carry a bare model name with no publisher token, and where a prefix does
 * exist it is sometimes the inference platform rather than the publisher
 * (`fal-ai/fast-sdxl` is Stability's). So `publisher` and `model` are columns on
 * the routing table, hand-written beside each route, and this module's job is
 * only to JOIN and SPLIT them — the join for an identifier a client can send,
 * the split for one it did send.
 *
 * {@link parseModelIdentity} therefore validates SHAPE and nothing else. Whether
 * the pair it returns names a model this service can route to is a question
 * about the routing table, and `model-selection.ts` is what asks it.
 */

/**
 * One named body of work published by an organisation.
 *
 * Two fields rather than one joined string, matching `ModelMapping`: the
 * serving side keys on its own deployment id verbatim, so a joined identity
 * would have to be split again at every call.
 */
export interface ModelIdentity {
  /** Who released the weights. A member of `MODEL_PUBLISHERS`, never an operator. */
  readonly publisher: string;
  /** The publisher's own name for the model, never what an operator calls its deployment. */
  readonly model: string;
}

/** The identifier a client sends and the catalogue publishes. */
export function formatModelIdentity(identity: ModelIdentity): string {
  return `${identity.publisher}/${identity.model}`;
}

export function sameModelIdentity(a: ModelIdentity, b: ModelIdentity): boolean {
  return a.publisher === b.publisher && a.model === b.model;
}

/**
 * Split an identifier into its two halves, or `null` when it is not one.
 *
 * The split is on the FIRST slash and the remainder is the model, so a model
 * name containing a slash survives a round trip through
 * {@link formatModelIdentity}. No name in the routing table has one today; the
 * rule is here so that the day one does, it does not silently become a
 * different model.
 *
 * Both halves must be non-empty, and there is no trimming and no case folding.
 * A normalising parser would accept several spellings of one identity, and the
 * catalogue publishes exactly one — so the extra spellings would be identifiers
 * that work without ever being advertised, which is how the thirteen aliases
 * became thirteen.
 */
export function parseModelIdentity(identifier: string): ModelIdentity | null {
  const slash = identifier.indexOf('/');
  if (slash <= 0 || slash === identifier.length - 1) return null;
  return { publisher: identifier.slice(0, slash), model: identifier.slice(slash + 1) };
}

/**
 * How a model's name is written for a person to read.
 *
 * Keyed by the full identity rather than by the model half, because two
 * publishers may use one name and the pair is what is unique.
 *
 * ## Why this is a table and not a transformation
 *
 * Title-casing `deepseek-v3` produces "Deepseek V3" and `gpt-4o-mini` produces
 * "Gpt 4o Mini": both are WRONG, and a wrong name is worse than a raw one
 * because a reader cannot tell it is wrong. So there is no derivation — a model
 * missing from this table renders as the name its publisher gave it, which is a
 * real name that ages without maintenance.
 *
 * The table is allowed to be incomplete and is NOT allowed to be wrong: every
 * key must name an identity the routing table carries, which
 * `__tests__/model-selection.test.ts` asserts, so a model that leaves the table
 * cannot leave a name behind for a model that never arrives.
 */
const MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  'alibaba/qwen3-32b': 'Qwen3 32B',
  'anthropic/claude-opus-4': 'Claude Opus 4',
  'anthropic/claude-opus-4.6': 'Claude Opus 4.6',
  'anthropic/claude-sonnet-4': 'Claude Sonnet 4',
  'anthropic/claude-sonnet-4.6': 'Claude Sonnet 4.6',
  'black-forest-labs/flux-schnell': 'FLUX.1 [schnell]',
  'cohere/command-a-03-2025': 'Command A',
  'cohere/command-a-reasoning-08-2025': 'Command A Reasoning',
  'cohere/command-a-vision-07-2025': 'Command A Vision',
  'cohere/command-r-08-2024': 'Command R',
  'cohere/command-r7b-12-2024': 'Command R7B',
  'deepseek/deepseek-chat': 'DeepSeek Chat',
  'deepseek/deepseek-reasoner': 'DeepSeek Reasoner',
  'deepseek/deepseek-v3': 'DeepSeek V3',
  'elevenlabs/eleven-multilingual-v2': 'Eleven Multilingual v2',
  'google/gemini-2.5-flash': 'Gemini 2.5 Flash',
  'google/gemini-2.5-flash-preview-tts': 'Gemini 2.5 Flash TTS',
  'google/gemini-2.5-pro': 'Gemini 2.5 Pro',
  'google/gemini-3-flash-preview': 'Gemini 3 Flash',
  'google/gemini-3-pro-preview': 'Gemini 3 Pro',
  'meta/llama-3.1-405b': 'Llama 3.1 405B',
  'meta/llama-3.2-11b-vision': 'Llama 3.2 11B Vision',
  'meta/llama-3.3-70b': 'Llama 3.3 70B',
  'mistral/mistral-small-3.1': 'Mistral Small 3.1',
  'openai/dall-e-3': 'DALL·E 3',
  'openai/gpt-4o': 'GPT-4o',
  'openai/gpt-4o-mini': 'GPT-4o mini',
  'openai/gpt-4o-realtime-preview': 'GPT-4o Realtime',
  'openai/gpt-5': 'GPT-5',
  'openai/gpt-5-mini': 'GPT-5 mini',
  'openai/gpt-5-nano': 'GPT-5 nano',
  'openai/gpt-5.1-codex-max': 'GPT-5.1 Codex Max',
  'openai/gpt-5.2': 'GPT-5.2',
  'openai/gpt-5.2-pro': 'GPT-5.2 Pro',
  'openai/gpt-image-1': 'GPT Image 1',
  'openai/gpt-oss-20b': 'gpt-oss-20b',
  'openai/o1': 'o1',
  'openai/o3': 'o3',
  'openai/tts-1': 'TTS-1',
  'openai/tts-1-hd': 'TTS-1 HD',
  'openai/whisper-1': 'Whisper',
  'openai/whisper-large-v3': 'Whisper large-v3',
  'openai/whisper-large-v3-turbo': 'Whisper large-v3 turbo',
  'perplexity/sonar-pro': 'Sonar Pro',
  'perplexity/sonar-reasoning-pro': 'Sonar Reasoning Pro',
  'stability/sdxl': 'SDXL',
  'xai/grok-4.3': 'Grok 4.3',
  'xai/grok-4.6': 'Grok 4.6',
  'xai/grok-realtime': 'Grok Realtime',
};

/** Every key of the display table, so a census can treat them as one vocabulary. */
export const MODEL_DISPLAY_NAMED_IDENTITIES: readonly string[] = Object.keys(MODEL_DISPLAY_NAMES);

/**
 * The name a person reads, falling back to the publisher's own.
 *
 * `Object.hasOwn`, not a truthy read: the argument is built from a caller's
 * identifier on the request path, and an object literal inherits `constructor`,
 * `toString` and three more from `Object.prototype` — each of which is truthy
 * and none of which is a display name.
 */
export function modelDisplayName(identity: ModelIdentity): string {
  const key = formatModelIdentity(identity);
  return Object.hasOwn(MODEL_DISPLAY_NAMES, key) ? MODEL_DISPLAY_NAMES[key] : identity.model;
}
