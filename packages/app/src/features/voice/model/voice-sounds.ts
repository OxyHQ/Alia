import type { SoundSources } from '@alia.onl/sdk/voice';

/**
 * The cues a voice call plays — thinking, a tool call, connecting, ending — as the app bundles
 * them. The SDK's call plays whatever sources the host hands it (`AliaVoiceOptions.sounds`), so it
 * hardcodes no asset and stays portable across bundlers.
 */
// Static require() calls — Metro needs these to be static literals
export const VOICE_SOUNDS: SoundSources = {
  thinking: require('../../../../assets/sounds/thinking.mp3'),
  toolCall: require('../../../../assets/sounds/tool-call.mp3'),
  voiceConnect: require('../../../../assets/sounds/voice-connect.mp3'),
  voiceDisconnect: require('../../../../assets/sounds/voice-disconnect.mp3'),
};
