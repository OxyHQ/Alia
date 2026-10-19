/**
 * The ask provider of `@alia.onl/sdk/ask`: its sheet is loaded lazily and mounted on the first
 * `ask`, so an app that mounts this provider at its root keeps the chat out of its entry bundle.
 * Signed in, the sheet's module is fetched in the background so the first `ask` does not wait on
 * the network.
 *
 * This `import()` is the ONE async boundary the SDK draws, and only for this entry: everything
 * behind it (`AliaAskSheet` and the chat) imports statically on web, so Metro emits one chunk for
 * the sheet and hoists nothing of it into `__common.js` (`scripts/check-entry-isolation.mjs`).
 */

import { lazy, Suspense } from 'react';
import { type AskSheetComponent, createAskProvider } from './AliaAskCore';

const loadSheet = () => import('./AliaAskSheet');
const LazyAskSheet = lazy(() => loadSheet().then((module) => ({ default: module.AliaAskSheet })));

const SuspendedAskSheet: AskSheetComponent = (props) => (
  <Suspense fallback={null}>
    <LazyAskSheet {...props} />
  </Suspense>
);

export type { AliaAsk, AliaAskAgents, AliaAskProviderProps } from './AliaAskCore';
export { useAskAgent } from './AliaAskCore';

export const AliaAskProvider = createAskProvider(SuspendedAskSheet, loadSheet);
