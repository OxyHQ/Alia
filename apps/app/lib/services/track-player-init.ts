import TrackPlayer, { Capability, AppKilledPlaybackBehavior } from 'react-native-track-player';

let initialized = false;

export async function initTrackPlayer() {
  if (initialized) return;

  await TrackPlayer.setupPlayer({
    minBuffer: 5,
    maxBuffer: 30,
  });

  await TrackPlayer.updateOptions({
    capabilities: [
      Capability.Play,
      Capability.Pause,
      Capability.Stop,
    ],
    compactCapabilities: [Capability.Play, Capability.Pause],
    android: {
      appKilledPlaybackBehavior: AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
    },
  });

  initialized = true;
}
