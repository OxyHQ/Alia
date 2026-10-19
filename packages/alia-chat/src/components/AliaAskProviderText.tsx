/**
 * The ask provider of `@alia.onl/sdk/ask/text`: `AliaAskProviderLazy` without the voice call. Its
 * sheet is loaded lazily, with the first `ask`, and neither the provider nor the sheet reaches the
 * call's modules, so a text-only app bundles none of them.
 *
 * Its `import()` is the one async boundary of this entry, as in `AliaAskProviderLazy`: behind it
 * everything imports statically on web (`scripts/check-entry-isolation.mjs`).
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
