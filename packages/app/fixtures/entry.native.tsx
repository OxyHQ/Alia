import { ExpoRoot } from 'expo-router';
import type { RequireContext } from 'expo-router/build/types';

// The same real root/app layouts and fixture route as the browser harness.
// Native requires synchronous contexts; no alternate provider or composer tree.
const { ctx: appContext } = require('expo-router/_ctx') as { ctx: RequireContext };
const fixtureContext = require.context('./routes', true, /\.tsx$/, 'sync');
const fixtureKeys = new Set(fixtureContext.keys());
const merged = ((key: string) =>
  fixtureKeys.has(key) ? fixtureContext(key) : appContext(key)) as RequireContext;
merged.keys = () => [...appContext.keys(), ...fixtureKeys];
merged.resolve = (key: string) =>
  fixtureKeys.has(key) ? fixtureContext.resolve(key) : appContext.resolve(key);
merged.id = `${appContext.id}+native-fixtures`;
const linking = { getInitialURL: () => 'alia663:///__fixtures/a-10' };

export function FixtureApp() {
  return <ExpoRoot context={merged} linking={linking} />;
}
