import "@expo/metro-runtime";
import { LoadSkiaWeb } from "@shopify/react-native-skia/lib/module/web";

LoadSkiaWeb({
  locateFile: (file: string) => `/${file}`,
}).then(async () => {
  const { App } = await import("expo-router/build/qualified-entry");
  const { renderRootComponent } = await import(
    "expo-router/build/renderRootComponent"
  );
  renderRootComponent(App);
});
