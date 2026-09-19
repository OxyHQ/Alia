/** Speech generation through the published Oxy client and exact product profile. */
import { OXY_KAANA_SPEECH_ROUTING_PROFILE_ID } from '../config/oxy-inference-routing-profile-ids.js';
import { getOxyInferenceClient } from './inference/oxy-inference.js';
import { kaanaCapabilityUnavailable } from './inference/hosted-capability-error.js';

export interface SynthesizeSpeechOptions {
  input: string;
  voice: string;
  format: string;
  userId: string;
  speed?: number;
  signal?: AbortSignal;
}
export interface SynthesizedSpeech { audio: Buffer; format: string; requestId: string }

export async function synthesizeSpeech(options: SynthesizeSpeechOptions): Promise<SynthesizedSpeech> {
  if (!options.userId || options.format !== 'mp3') throw new Error('Speech requires a user and MP3 output');
  const client = getOxyInferenceClient();
  if (client === null) throw kaanaCapabilityUnavailable('speech_synthesis');
  const timeout = AbortSignal.timeout(60_000);
  const result = await client.speech({
    routingProfileId: OXY_KAANA_SPEECH_ROUTING_PROFILE_ID,
    input: options.input,
    voice: options.voice,
    response_format: 'mp3',
    ...(options.speed === undefined ? {} : { speed: options.speed }),
  }, {
    delegatedUserId: options.userId,
    signal: options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]),
  });
  if (result.mediaType !== 'audio/mpeg') throw new Error('Speech returned an unexpected audio format');
  return { audio: Buffer.from(result.audio), format: 'mp3', requestId: result.requestId };
}
