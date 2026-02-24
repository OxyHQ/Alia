/**
 * Web shim for react-native-track-player.
 * On web the app uses expo-speech for TTS instead, so every export here is a
 * no-op stub that satisfies Metro's bundler without pulling in shaka-player.
 */

const noop = () => {};
const asyncNoop = async () => {};

const TrackPlayer = {
  setupPlayer: asyncNoop,
  updateOptions: asyncNoop,
  registerPlaybackService: noop,
  addEventListener: () => ({ remove: noop }),
  reset: asyncNoop,
  add: asyncNoop,
  play: asyncNoop,
  pause: asyncNoop,
  stop: asyncNoop,
};

export default TrackPlayer;

export const Event = {
  PlaybackQueueEnded: 'playback-queue-ended',
  PlaybackState: 'playback-state',
  RemotePause: 'remote-pause',
  RemotePlay: 'remote-play',
  RemoteStop: 'remote-stop',
};

export const Capability = {
  Play: 'play',
  Pause: 'pause',
  Stop: 'stop',
};

export const AppKilledPlaybackBehavior = {
  StopPlaybackAndRemoveNotification: 'stop',
};
