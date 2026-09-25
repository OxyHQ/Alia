/**
 * The app, plus the fixture routes the perf and visual harnesses drive.
 *
 * Mounted by `index.web.tsx` only when the bundle is built with
 * `EXPO_PUBLIC_ALIA_FIXTURES=1`. That condition is inlined at build time, so a
 * production export folds it to `false` and never collects this module, its
 * routes or the generated conversations — `scripts/perf/measure.mjs` greps the
 * production export to prove it on every fixtures run.
 *
 * It is the real app, not a copy: the route context is expo-router's own over
 * `app/`, with `fixtures/routes/` merged in beside it. So a fixture route sits
 * under the real `(app)` layout — the real shell, sidebar, providers and
 * stores — and only its own page is fixture code. The fixture routes live
 * outside `app/` because anything in `app/` is a route in every build.
 */
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import type { RequireContext } from 'expo-router/build/types';

// The exact string expo-router resolves specially; see its `qualified-entry`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ctx: appContext } = require('expo-router/_ctx') as { ctx: RequireContext };

/** Lazy, like `app/` on web (`asyncRoutes.web` in app.json). */
const fixtureContext = require.context('./routes', true, /\.tsx$/, 'lazy');
const fixtureKeys = new Set(fixtureContext.keys());

const merged = ((key: string) =>
  fixtureKeys.has(key) ? fixtureContext(key) : appContext(key)) as RequireContext;
merged.keys = () => [...appContext.keys(), ...fixtureKeys];
merged.resolve = (key: string) =>
  fixtureKeys.has(key) ? fixtureContext.resolve(key) : appContext.resolve(key);
merged.id = `${appContext.id}+fixtures`;

export function FixtureApp() {
  return (
    <Head.Provider>
      <ExpoRoot context={merged} />
    </Head.Provider>
  );
}
