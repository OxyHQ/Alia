import { App } from "expo-router/build/qualified-entry";
import { renderRootComponent } from "expo-router/build/renderRootComponent";
import TrackPlayer from "react-native-track-player";
import { PlaybackService } from "./lib/services/playback-service";

TrackPlayer.registerPlaybackService(() => PlaybackService);

renderRootComponent(App);
