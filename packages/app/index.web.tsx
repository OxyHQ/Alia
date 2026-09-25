import "@expo/metro-runtime";
import { App } from "expo-router/build/qualified-entry";
import { renderRootComponent } from "expo-router/build/renderRootComponent";

// The perf and visual fixtures (`fixtures/`), in a build made with
// EXPO_PUBLIC_ALIA_FIXTURES=1 only. The variable is inlined at build time, so
// every other export folds this to `App` and never bundles the fixtures.
renderRootComponent(
  process.env.EXPO_PUBLIC_ALIA_FIXTURES === "1"
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./fixtures/entry").FixtureApp
    : App,
);
