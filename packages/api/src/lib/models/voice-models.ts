/**
 * The voice and dictation models, computed from Kaana's catalogue (ADR 0017
 * §2 and §7). No model id is written anywhere: a model is a candidate because
 * of what the catalogue says it can do, and the order is its published price
 * per minute.
 *
 * Kaana's API is one canonical contract (Kaana ADR 0003): it translates every
 * value the contract offers for every model, a language included, so a model
 * is chosen by product capability and price alone. The person's locale is
 * passed as it is; no model is excluded for its language.
 *
 * The person's power level never picks these models (ADR 0017 §2): realtime
 * and transcription models carry no power class, and a call is not made
 * "smarter" by a level — the tools it runs are.
 */

import type { AudioInputMediaType, Model } from '@kaana.ai/contracts';
import type { ProductVoice } from '../voice/protocol.js';

/** The model's published price of one minute in USD, or `null` when it states none in USD. */
export function usdPerMinute(model: Model): number | null {
  const price = model.pricePerMinute;
  if (!price || price.currency !== 'USD') return null;
  const amount = Number(price.amount);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

/** Cheapest first; a model with no USD price after every priced one; then the id. */
function byPriceThenId(
  a: { readonly model: Model; readonly usdPerMinute: number | null },
  b: { readonly model: Model; readonly usdPerMinute: number | null },
): number {
  if (a.usdPerMinute !== null && b.usdPerMinute !== null && a.usdPerMinute !== b.usdPerMinute)
    return a.usdPerMinute - b.usdPerMinute;
  if (a.usdPerMinute === null && b.usdPerMinute !== null) return 1;
  if (a.usdPerMinute !== null && b.usdPerMinute === null) return -1;
  if (a.model.modelId === b.model.modelId) return 0;
  return a.model.modelId < b.model.modelId ? -1 : 1;
}

/* -------------------------------------------------------------------------- */
/*  Realtime (voice calls)                                                     */
/* -------------------------------------------------------------------------- */

export interface RealtimeCandidate {
  readonly model: Model;
  /** The voice id: sent to Kaana, never shown or returned. */
  readonly voiceId: string;
  readonly usdPerMinute: number | null;
}

function holdsConversations(model: Model): boolean {
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

/**
 * Every model that can hold this call, in the order the open tries them
 * (ADR 0017 §2): an active `conversation` over `websocket` with tools, audio
 * both ways and its own input transcription, and a voice of the product's
 * gender. Cheapest minute first.
 */
export function rankRealtimeCandidates(
  models: readonly Model[],
  wanted: { readonly voice: ProductVoice },
): RealtimeCandidate[] {
  const candidates: RealtimeCandidate[] = [];
  for (const model of models) {
    if (model.deprecation.status !== 'active' || !holdsConversations(model)) continue;
    const voice = model.audio?.voices.find((entry) => entry.gender === wanted.voice);
    if (!voice) continue;
    candidates.push({ model, voiceId: voice.id, usdPerMinute: usdPerMinute(model) });
  }
  return candidates.sort(byPriceThenId);
}

/* -------------------------------------------------------------------------- */
/*  Transcription (dictation)                                                  */
/* -------------------------------------------------------------------------- */

export interface TranscriptionCandidate {
  readonly model: Model;
  readonly usdPerMinute: number | null;
}

/**
 * Every model that can transcribe this clip (ADR 0017 §7): active, it executes
 * `audio_transcriptions` and takes the clip's media type. Cheapest minute
 * first.
 */
export function rankTranscriptionCandidates(
  models: readonly Model[],
  wanted: { readonly mediaType: AudioInputMediaType },
): TranscriptionCandidate[] {
  const candidates: TranscriptionCandidate[] = [];
  for (const model of models) {
    if (model.deprecation.status !== 'active') continue;
    if (!model.capabilities.apiFormats?.includes('audio_transcriptions')) continue;
    if (!model.audio?.audioFormats.input.includes(wanted.mediaType)) continue;
    candidates.push({ model, usdPerMinute: usdPerMinute(model) });
  }
  return candidates.sort(byPriceThenId);
}

/* -------------------------------------------------------------------------- */
/*  Streaming transcription (dictation sessions)                               */
/* -------------------------------------------------------------------------- */

/**
 * Every model that can hold a streaming dictation (ADR 0024): active, a
 * `transcription` session over `websocket` that takes 24 kHz PCM16. Cheapest
 * minute first. No model is excluded for its language: Kaana gives every model
 * the language, or none for it to detect (Kaana ADR 0003).
 */
export function rankTranscriptionSessionCandidates(
  models: readonly Model[],
): TranscriptionCandidate[] {
  const candidates: TranscriptionCandidate[] = [];
  for (const model of models) {
    if (model.deprecation.status !== 'active') continue;
    const realtime = model.capabilities.realtime;
    if (
      realtime === undefined ||
      !realtime.sessionKinds.includes('transcription') ||
      !realtime.transports.includes('websocket')
    )
      continue;
    const formats = realtime.audioFormats?.input ?? [];
    if (formats.length > 0 && !formats.includes('pcm16_24khz')) continue;
    candidates.push({ model, usdPerMinute: usdPerMinute(model) });
  }
  return candidates.sort(byPriceThenId);
}
