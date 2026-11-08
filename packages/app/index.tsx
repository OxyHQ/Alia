import { App } from 'expo-router/build/qualified-entry';
import { renderRootComponent } from 'expo-router/build/renderRootComponent';

renderRootComponent(
  process.env.EXPO_PUBLIC_ALIA_FIXTURES === '1' ? require('./fixtures/entry').FixtureApp : App,
);
