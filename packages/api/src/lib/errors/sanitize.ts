/**
 * Product-surface sanitisation — epic #139 workstream 20.
 *
 * This module used to open with "users must NEVER see provider names" and it
 * governed everything. It does not any more. ADR 0003 makes
 * `<publisher>/<model>` the canonical identifier form, so publisher identity is
 * part of the platform's vocabulary; a rule that forbade the words everywhere
 * would forbid the catalogue from telling the truth about what it serves.
 *
 * ## Two rules, two audiences, deliberately separate
 *
 * **Rule 1 — absolute, every surface, no exceptions.** No credential, no
 * internal endpoint, and no raw upstream error body reaches a user.
 * {@link redactUnsafeDetail} is this rule's expression here: credentials,
 * URLs and hostnames, and the upstream error-code vocabulary. It is a security
 * and privacy control and nothing may opt out of it.
 *
 * **Rule 2 — scoped, product surfaces only.** Which upstream operator and which
 * upstream model answered a request is route detail Alia's *product* chooses not
 * to show: a customer bought "kaana-v1", not a seat on a named operator, and the
 * routing table is commercially sensitive. {@link sanitizeMessage} is this
 * rule's expression. It is a product decision, best-effort by construction, and
 * **not a security control** — the same conclusion `lib/inference/kaana-error.ts`
 * reaches from the other side.
 *
 * ## Where each rule applies
 *
 * Rule 2 applies to these surfaces, and only these:
 *
 *  - product API error bodies (`routes/**`, and `formatErrorResponse` below);
 *  - SSE error events on a chat stream;
 *  - user-visible notifications;
 *  - customer-facing analytics and dashboard strings.
 *
 * Rule 2 must NOT run on these, because each of them is required to be
 * truthful and running it there destroys the truth:
 *
 *  - the model catalogue and model cards — a caller choosing a model has to
 *    know whose model it is (ADR 0003);
 *  - attribution required by an open-weight licence, which names the publisher
 *    as a condition of use;
 *  - operator and audit surfaces — logs and the admin console. An operator asking "which deployment
 *    failed" is asking the question the concealment would erase;
 *  - anything crossing the Kaana contract, whose `providerError.provider` field
 *    is REQUIRED to carry a real provider slug;
 *  - the caller's own input echoed back to them. It is theirs; it reveals
 *    nothing about Alia's routing. Such an echo takes {@link redactUnsafeDetail}
 *    alone, so a mistyped `gpt-4o` comes back readable instead of mangled;
 *  - engineering documentation, ADRs, schema comments, this file.
 *
 * ## What "best effort" means, stated rather than implied
 *
 * Concealment recognises the operators registered in `provider-names.ts` and the
 * model families that appear in the live routing table, and it recognises them
 * as IDENTIFIERS — a proper noun, or a token joined by `/`, `.`, `-`, `_`. It
 * deliberately leaves ordinary prose alone: `llama` is Spanish for a flame and
 * Alia answers in Spanish, `together`, `cohere`, `replicate`, `whisper` and
 * `command` are ordinary English words, and rewriting them to a redaction marker
 * corrupted messages far more often than it concealed anything. A lowercase
 * bare-word mention of an operator therefore survives. That is acceptable
 * precisely because rule 2 is not a security control; the things that are —
 * credentials, endpoints, upstream bodies — are handled by rule 1 and, for
 * upstream bodies, at the point they are born
 * (`internal/providers/lib/provider-error-body.ts`).
 */

import { PROVIDER_NAMES } from '../../internal/providers/lib/provider-names.js';
import { redactSecrets } from '../agent/secret-scanner.js';
import type { AliaError } from './error-codes.js';
import { AliaErrorCode } from './error-codes.js';

/** Stands in for a concealed upstream operator. */
const PROVIDER_MARKER = '[provider]';
/** Stands in for a concealed upstream model identifier. */
const MODEL_MARKER = '[model]';
/** Stands in for a concealed URL or hostname. */
const ENDPOINT_MARKER = '[endpoint]';
/** Stands in for a concealed upstream error code. */
const CODE_MARKER = '[code]';

/**
 * The upstream error-code vocabulary, which is route detail by another name: a
 * body carrying `overloaded_error` names Anthropic as surely as the word does,
 * and `insufficient_quota` names OpenAI.
 *
 * This is the corpus `failover-error.ts` classifies on. `sanitize.test.ts` parses
 * that file and fails on a code it reads that is not covered here, so the list
 * cannot fall behind the classifier.
 *
 * **`UNAVAILABLE` is deliberately absent**, and it is the only one. Google's
 * gRPC status is an ordinary English word in capitals, so it is indistinguishable
 * from prose — the same reason `together` and `command` are treated as words
 * rather than slugs. The test asserts that exemption by exact list.
 *
 * Node's own network codes (`ETIMEDOUT`, `ECONNRESET`) are NOT here. They name
 * no operator, and redacting them would cost a reader real diagnostic
 * information for no privacy gain.
 */
const UPSTREAM_ERROR_CODES = new Set<string>([
  'failed_precondition', 'resource_exhausted', 'permission_denied',
  'rate_limit_error', 'authentication_error', 'server_error',
  'billing_hard_limit_reached', 'insufficient_quota', 'overloaded_error',
  'tool_use_failed',
  // OpenAI-compatible providers use these for a model id they do not serve.
  // They name an operator as surely as the others: an id that 404s on one
  // deployment and answers on another is a route fingerprint.
  'model_not_found', 'model_decommissioned',
]);

/**
 * A snake_case or SCREAMING_SNAKE identifier. Membership in
 * {@link UPSTREAM_ERROR_CODES} is what decides, not the shape — otherwise
 * `request_id` and `user_id` would be redacted out of every message that
 * carries one.
 */
const ERROR_CODE_PATTERN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gi;

/**
 * Slugs that are ALSO ordinary words in a language Alia answers in, so they are
 * concealed only where they are written as route detail: capitalised as a brand,
 * or joined into an identifier.
 *
 * `sanitize.test.ts` pins the registered-operator half of this list to an exact
 * count, so a provider whose slug is an ordinary word cannot be added to the
 * registry without the classification being made deliberately.
 */
const WORD_SLUGS = new Set<string>([
  // Registered operators whose slug is an ordinary English or Spanish word.
  'google', 'together', 'replicate', 'cohere', 'fireworks', 'perplexity',
  'hyperbolic', 'mistral',
  // Model families and publishers in the same position.
  'claude', 'llama', 'whisper', 'command', 'meta', 'grok', 'tts', 'flux',
  'sonar',
  // ElevenLabs' own model ids are `eleven_<family>_<version>`, so the part that
  // names the route is the bare number word. Here rather than in
  // `EXTRA_OPAQUE_SLUGS` for exactly the reason this list exists: "eleven" in a
  // sentence is a quantity, and concealing it there would rewrite ordinary prose.
  'eleven',
]);

/**
 * Model families and publishers that appear in upstream identifiers but are not
 * registered operators.
 *
 * Derived from the `modelId` values in `GENERATED_TIER_MAPPINGS`;
 * `sanitize.test.ts` walks that table and fails on an identifier no slug here
 * covers, so the list cannot silently fall behind the routing it describes.
 */
const EXTRA_OPAQUE_SLUGS = [
  'gpt', 'gemini', 'qwen', 'mixtral', 'alibaba', 'elevenlabs', 'sdxl',
  'fal', 'dall', 'o1', 'o3', 'o4',
] as const;

/** Every slug concealed wherever it appears, ordinary-word slugs excepted. */
const OPAQUE_SLUGS = new Set<string>([
  ...PROVIDER_NAMES.filter((name) => !WORD_SLUGS.has(name)),
  ...EXTRA_OPAQUE_SLUGS,
]);

/** Slugs that name a registered operator, for choosing between the markers. */
const OPERATOR_SLUGS = new Set<string>(PROVIDER_NAMES);

/** `https://…`, including the credential some upstreams embed in a query. */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;

/**
 * A bare hostname. The TLD list is closed on purpose: an open `\.[a-z]{2,}$`
 * swallows `package.json`, `index.ts` and every `file.ext` an error message
 * quotes.
 */
const HOSTNAME_PATTERN =
  /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|ai|io|net|org|dev|cloud|app|run|xyz|sh|co)\b/gi;

/**
 * One identifier-shaped run of text: ends on an alphanumeric, and may be joined
 * internally by the characters upstream identifiers use. Ending on an
 * alphanumeric is what keeps a sentence's full stop out of the token, so
 * `…failed together.` is the bare word `together` and not the identifier
 * `together.`. The optional leading `@` is Cloudflare's `@cf/…` account prefix.
 */
const TOKEN_PATTERN = /@?[a-z0-9](?:[a-z0-9._/@:=-]*[a-z0-9])?/gi;

/** Splits an identifier into the parts a slug can be compared against. */
const JOINER_PATTERN = /[._/@:=-]+/;

/**
 * A part matches a slug when it IS the slug, or when it is the slug carrying a
 * version number — `qwen3`, `llama3`. `llamadas` is neither, which is the whole
 * reason this is not a substring test.
 */
function partMatches(part: string, slug: string): boolean {
  const lower = part.toLowerCase();
  if (lower === slug) return true;
  return lower.startsWith(slug) && /^[0-9]/.test(lower.slice(slug.length));
}

/**
 * A proper noun: a capital followed by a lowercase letter. `Anthropic` and
 * `Llama` qualify; `TTS`, `AI` and `OK` do not, so an acronym that happens to
 * collide with a slug is left alone.
 */
function isProperNoun(part: string): boolean {
  return /^[A-Z][a-z]/.test(part);
}

/**
 * Decide what one identifier-shaped token is, and what should replace it.
 *
 * Returns `null` for a token that is not upstream route detail — which is most
 * of them, and is what makes this safe to run over a whole sentence.
 */
function markerFor(token: string): string | null {
  const parts = token.split(JOINER_PATTERN).filter(Boolean);
  const isIdentifier = parts.length > 1 || /[0-9]/.test(token);

  let hit = false;
  let operatorOnly = true;

  for (const part of parts) {
    for (const slug of OPAQUE_SLUGS) {
      if (!partMatches(part, slug)) continue;
      hit = true;
      if (!OPERATOR_SLUGS.has(slug)) operatorOnly = false;
    }
    for (const slug of WORD_SLUGS) {
      if (!partMatches(part, slug)) continue;
      // An ordinary word is route detail only when it is written as one:
      // capitalised as a brand, or joined into an identifier.
      if (!isIdentifier && !isProperNoun(part)) continue;
      hit = true;
      if (!OPERATOR_SLUGS.has(slug)) operatorOnly = false;
    }
  }

  if (!hit) return null;
  return operatorOnly && !/[0-9]/.test(token) ? PROVIDER_MARKER : MODEL_MARKER;
}

/**
 * Rule 1. Strip what may never reach a user on ANY surface: credentials, the
 * URLs and hostnames that describe Alia's internal topology, and the upstream
 * error-code vocabulary that is a raw upstream body's fingerprint.
 *
 * The product-surface boundary is deliberately independent of transport: an
 * SDK, Oxy response or local integration may assemble an error string anywhere,
 * so every user-bound message is scrubbed here even though provider responses
 * and provider credentials no longer exist in the Alia runtime.
 *
 * Use this alone where the text is the caller's own and concealment would only
 * make the message unactionable.
 */
export function redactUnsafeDetail(text: string): string {
  return redactSecrets(text)
    .redacted.replace(URL_PATTERN, ENDPOINT_MARKER)
    .replace(HOSTNAME_PATTERN, ENDPOINT_MARKER)
    .replace(ERROR_CODE_PATTERN, (code) =>
      UPSTREAM_ERROR_CODES.has(code.toLowerCase()) ? CODE_MARKER : code,
    );
}

/**
 * Rule 1 plus rule 2: the exit point for error text bound for an Alia product
 * surface.
 *
 * Do not reach for this on a catalogue, an audit record, a log line or anything
 * crossing the Kaana contract. Those surfaces are required to name what they
 * are talking about; the module header lists them.
 */
export function sanitizeMessage(text: string): string {
  return redactUnsafeDetail(text).replace(TOKEN_PATTERN, (token) => markerFor(token) ?? token);
}

/**
 * Read a user-facing sentence off an unknown throw.
 *
 * The fallback is sanitised too. It is normally a developer-authored constant
 * where that is a no-op, but a caller may interpolate, and a sanitiser that
 * trusts one of its two inputs is a sanitiser with a hole in it.
 */
export function getSafeErrorMessage(error: unknown, fallback: string): string {
  return sanitizeMessage(error instanceof Error ? error.message : fallback);
}

/** Map an `AliaErrorCode` onto the OpenAI-compatible `error.type` strings. */
function openAIErrorType(code: string): string {
  switch (code) {
    case AliaErrorCode.RATE_LIMITED:
      return 'rate_limit_error';
    case AliaErrorCode.CREDITS_INSUFFICIENT:
    case AliaErrorCode.INVALID_REQUEST:
    case AliaErrorCode.CONTEXT_TOO_LONG:
    case AliaErrorCode.CONTENT_FILTERED:
    case AliaErrorCode.QUOTA_EXCEEDED:
      return 'invalid_request_error';
    case AliaErrorCode.AUTH_FAILED:
      return 'authentication_error';
    default:
      return 'server_error';
  }
}

/**
 * Format an `AliaError` for a product API response.
 *
 * `userMessage` is either a constant from `error-codes.ts` or already through
 * {@link sanitizeMessage} at construction; `error.message`, which may name the
 * deployment that failed, is for operators and is not in the response.
 */
export function formatErrorResponse(error: AliaError) {
  return {
    error: {
      message: error.userMessage,
      type: openAIErrorType(error.code),
      param: null,
      code: error.code,
    },
  };
}
