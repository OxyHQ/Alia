import { registerGlobals } from "@livekit/react-native";
import { App } from "expo-router/build/qualified-entry";
import { renderRootComponent } from "expo-router/build/renderRootComponent";

registerGlobals();

renderRootComponent(App);
