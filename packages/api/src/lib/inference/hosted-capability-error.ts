export type KaanaUnavailableCapability =
  | 'audio_generation'
  | 'image_generation'
  | 'speech_synthesis'
  | 'speech_transcription'
  | 'voice_session'
  | 'embedding';

/** Fail-closed, provider-neutral refusal for a modality Kaana does not expose. */
export class KaanaCapabilityUnavailableError extends Error {
  readonly code = 'KAANA_CAPABILITY_UNAVAILABLE';
  readonly httpStatus = 503;

  constructor(readonly capability: KaanaUnavailableCapability) {
    super(`The ${capability.replaceAll('_', ' ')} capability is not available through Kaana.`);
    this.name = 'KaanaCapabilityUnavailableError';
  }
}

export function kaanaCapabilityUnavailable(
  capability: KaanaUnavailableCapability,
): KaanaCapabilityUnavailableError {
  return new KaanaCapabilityUnavailableError(capability);
}
