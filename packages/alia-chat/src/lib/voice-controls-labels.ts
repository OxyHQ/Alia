// The call bar's words, apart from the component so the chat's labels can hold them without
// reaching React Native.

/** Every word the bar shows or announces. An app in another language passes its own. */
export interface VoiceControlsLabels {
  connecting: string;
  reconnecting: string;
  connected: string;
  listening: string;
  muted: string;
  thinking: string;
  usingTool: string;
  speaking: string;
  mute: string;
  unmute: string;
  end: string;
}

export const VOICE_CONTROLS_LABELS: VoiceControlsLabels = {
  connecting: 'Connecting...',
  reconnecting: 'Reconnecting...',
  connected: 'Connected',
  listening: 'Listening...',
  muted: 'Muted',
  thinking: 'Thinking...',
  usingTool: 'Working on it...',
  speaking: 'Speaking...',
  mute: 'Mute',
  unmute: 'Unmute',
  end: 'End',
};
