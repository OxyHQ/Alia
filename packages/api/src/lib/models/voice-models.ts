/**
 * The voice and dictation models, computed from Kaana's catalogue (ADR 0017
 * §2 and §7). No model id is written anywhere: a model is a candidate because
 * of what the catalogue says it can do, and the order is its published price.
 *
 * The person's power level never picks these models (ADR 0017 §2): realtime
 * and transcription models carry no power class, and a call is not made
 * "smarter" by a level — the tools it runs are.
 */

import type {
  KaanaAudioInputMediaType,
  KaanaModel,
  KaanaPriceSnapshot,
  KaanaUsage,
  KaanaUsageUnit,
  KaanaVoice,
} from '../kaana/port.js';
import type { ProductVoice } from '../voice/protocol.js';

/* -------------------------------------------------------------------------- */
/*  Prices                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Audio tokens per minute, for ORDERING candidates priced by audio tokens
 * against ones priced by session time. OpenAI's realtime audio is about one
 * token per 100 ms heard and one per 50 ms spoken; a call minute is costed as
 * a full minute of each, the worst case. Only the order uses this: a call is
 * charged from the units Kaana measured, never from this estimate.
 */
const AUDIO_INPUT_TOKENS_PER_MINUTE = 600;
const AUDIO_OUTPUT_TOKENS_PER_MINUTE = 1_200;
const MS_PER_MINUTE = 60_000;

/** USD per one unit, or `null` when the snapshot does not price it in USD. */
export function usdPerUnit(
  pricing: KaanaPriceSnapshot | undefined,
  unit: KaanaUsageUnit,
): number | null {
  if (!pricing || pricing.currency !== 'USD') return null;
  const price = pricing.unitPrices.find((entry) => entry.unit === unit && entry.currency === 'USD');
  if (!price) return null;
  const amount = Number(price.amount);
  if (!Number.isFinite(amount) || amount < 0 || price.per <= 0) return null;
  return amount / price.per;
}

/**
 * What measured units cost at a price snapshot, in USD. Units the snapshot
 * does not price are listed, so the caller can say so in its log rather than
 * treat them as free silently.
 */
export function usdOfUnits(
  pricing: KaanaPriceSnapshot | undefined,
  units: KaanaUsage,
): { usd: number; unpriced: KaanaUsageUnit[] } {
  let usd = 0;
  const unpriced: KaanaUsageUnit[] = [];
  for (const { unit, quantity } of units) {
    if (quantity === 0) continue;
    const each = usdPerUnit(pricing, unit);
    if (each === null) unpriced.push(unit);
    else usd += quantity * each;
  }
  return { usd, unpriced };
}

/** An estimate of one call minute on a realtime model, or `null` with no audio price. */
export function estimatedUsdPerCallMinute(model: KaanaModel): number | null {
  const parts: Array<[KaanaUsageUnit, number]> = [
    ['session_milliseconds', MS_PER_MINUTE],
    ['audio_input_milliseconds', MS_PER_MINUTE],
    ['audio_output_milliseconds', MS_PER_MINUTE],
    ['audio_input_tokens', AUDIO_INPUT_TOKENS_PER_MINUTE],
    ['audio_output_tokens', AUDIO_OUTPUT_TOKENS_PER_MINUTE],
  ];
  let usd = 0;
  let priced = false;
  for (const [unit, perMinute] of parts) {
    const each = usdPerUnit(model.pricing, unit);
    if (each === null) continue;
    priced = true;
    usd += each * perMinute;
  }
  return priced ? usd : null;
}

/** Whether a model is billed for the wall-clock time of a session (silence included). */
export function billsSessionTime(model: KaanaModel): boolean {
  return usdPerUnit(model.pricing, 'session_milliseconds') !== null;
}

/* -------------------------------------------------------------------------- */
/*  Languages                                                                  */
/* -------------------------------------------------------------------------- */

function primary(tag: string): string {
  return tag.split('-')[0]!.toLowerCase();
}

/**
 * The model's tag that covers `locale`: the same tag, or — matched on the
 * primary subtag — a bare language for a regional locale (`es` covers
 * `es-ES`) or any region for a bare locale. A different region is not a match
 * (`es-MX` does not cover `es-ES`). The exact tag wins over a bare one.
 */
export function coveringLanguage(listed: readonly string[], locale: string): string | null {
  const wanted = locale.toLowerCase();
  const exact = listed.find((tag) => tag.toLowerCase() === wanted);
  if (exact) return exact;
  const language = primary(locale);
  const localeIsBare = !locale.includes('-');
  return (
    listed.find((tag) => primary(tag) === language && (localeIsBare || !tag.includes('-'))) ?? null
  );
}

/* -------------------------------------------------------------------------- */
/*  Realtime (voice calls)                                                     */
/* -------------------------------------------------------------------------- */

export interface RealtimeCandidate {
  readonly model: KaanaModel;
  /** The upstream voice id: sent to Kaana, never shown or returned. */
  readonly voiceId: string;
  /** The model's own tag for the session language. */
  readonly language: string;
  readonly usdPerMinute: number | null;
}

function holdsConversations(model: KaanaModel): boolean {
  const { capabilities } = model;
  const realtime = capabilities.realtime;
  return (
    realtime !== undefined &&
    realtime.sessionKinds.includes('conversation') &&
    realtime.transports.includes('websocket') &&
    realtime.inputAudioTranscription === true &&
    capabilities.tools === true &&
    capabilities.inputModalities.includes('audio') &&
    capabilities.outputModalities.includes('audio')
  );
}

function productVoiceOf(
  voices: readonly KaanaVoice[],
  gender: ProductVoice,
  language: string,
): KaanaVoice | null {
  return (
    voices.find(
      (voice) => voice.gender === gender && coveringLanguage(voice.languages, language) !== null,
    ) ?? null
  );
}

function releasedAtMs(model: KaanaModel): number {
  const time = model.releasedAt ? Date.parse(model.releasedAt) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

function byCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Every model that can hold this call, in the order the open tries them
 * (ADR 0017 §2): a `conversation` over `websocket` with tools, audio both
 * ways and its own input transcription; the session language; a voice of the
 * product's gender that speaks it; active (not deprecated or retired).
 * Cheapest estimated minute first, then the newest release, then the id.
 */
export function rankRealtimeCandidates(
  models: readonly KaanaModel[],
  wanted: { readonly locale: string; readonly voice: ProductVoice },
): RealtimeCandidate[] {
  const candidates: RealtimeCandidate[] = [];
  for (const model of models) {
    if (model.deprecation.status !== 'active' || !holdsConversations(model) || !model.audio)
      continue;
    const language = coveringLanguage(model.audio.languages, wanted.locale);
    if (language === null) continue;
    const voice = productVoiceOf(model.audio.voices, wanted.voice, language);
    if (voice === null) continue;
    candidates.push({
      model,
      voiceId: voice.id,
      language,
      usdPerMinute: estimatedUsdPerCallMinute(model),
    });
  }
  return candidates.sort((a, b) => {
    if (a.usdPerMinute !== null && b.usdPerMinute !== null && a.usdPerMinute !== b.usdPerMinute)
      return a.usdPerMinute - b.usdPerMinute;
    if (a.usdPerMinute === null && b.usdPerMinute !== null) return 1;
    if (a.usdPerMinute !== null && b.usdPerMinute === null) return -1;
    const newer = releasedAtMs(b.model) - releasedAtMs(a.model);
    if (newer !== 0) return newer;
    return byCodePoints(a.model.modelId, b.model.modelId);
  });
}

/* -------------------------------------------------------------------------- */
/*  Transcription (dictation)                                                  */
/* -------------------------------------------------------------------------- */

export interface TranscriptionCandidate {
  readonly model: KaanaModel;
  /** The model's own tag for the language, when one was asked for. */
  readonly language: string | undefined;
  readonly usdPerAudioMs: number | null;
}

/**
 * Every model that can transcribe this clip (ADR 0017 §7): it executes
 * `audio_transcriptions`, takes the clip's media type and covers the language;
 * cheapest per audio millisecond first, unpriced last, then the id.
 */
export function rankTranscriptionCandidates(
  models: readonly KaanaModel[],
  wanted: { readonly mediaType: KaanaAudioInputMediaType; readonly locale?: string },
): TranscriptionCandidate[] {
  const candidates: TranscriptionCandidate[] = [];
  for (const model of models) {
    if (model.deprecation.status !== 'active') continue;
    if (!model.capabilities.apiFormats?.includes('audio_transcriptions')) continue;
    if (!model.audio?.audioFormats.input.includes(wanted.mediaType)) continue;
    let language: string | undefined;
    if (wanted.locale !== undefined) {
      const covering = coveringLanguage(model.audio.languages, wanted.locale);
      if (covering === null) continue;
      language = covering;
    }
    candidates.push({
      model,
      language,
      usdPerAudioMs: usdPerUnit(model.pricing, 'audio_input_milliseconds'),
    });
  }
  return candidates.sort((a, b) => {
    if (a.usdPerAudioMs !== null && b.usdPerAudioMs !== null && a.usdPerAudioMs !== b.usdPerAudioMs)
      return a.usdPerAudioMs - b.usdPerAudioMs;
    if (a.usdPerAudioMs === null && b.usdPerAudioMs !== null) return 1;
    if (a.usdPerAudioMs !== null && b.usdPerAudioMs === null) return -1;
    return byCodePoints(a.model.modelId, b.model.modelId);
  });
}
