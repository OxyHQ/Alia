import "@expo/metro-runtime";
import { LoadSkiaWeb } from "@shopify/react-native-skia/lib/module/web";

LoadSkiaWeb({
  locateFile: (file: string) => `/${file}`,
}).then(() => {
  const { App } = require("expo-router/build/qualified-entry");
  const { renderRootComponent } = require("expo-router/build/renderRootComponent");
  renderRootComponent(App);
});
