import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { EffortLevel } from '@/lib/hooks/use-catalogue';
import { migrateModelState } from './model-store-migration';

/**
 * What the user last chose, across app launches.
 *
 * The store holds the REQUESTED identifier and never validates it: the
 * catalogue is the authority on what exists, it is fetched rather than
 * persisted, and `resolveSelection` (`lib/hooks/use-catalogue.ts`) is where a
 * choice the product no longer offers is answered for.
 *
 * What a person picks is three independent things, and this store holds each
 * separately because the request body models them separately: WHICH model
 * answers ({@link ModelState.selectedModel}), HOW HARD it thinks
 * ({@link ModelState.reasoningEffort}), and WHAT IT MAY REACH FOR
 * ({@link ModelState.webSearch}). Plus the models the person pinned to the top
 * of the picker ({@link ModelState.pinnedModels}).
 */
interface ModelState {
  /**
   * A real model (`publisher/model`, or a device model `local/…`), or `null`
   * for "no choice": the request carries no `model` and the server's default
   * answers. The app ships no model identifier, so `null` is where everyone
   * starts.
   */
  selectedModel: string | null;
  /**
   * How hard the next turn should think, or `null` for the model's own default.
   *
   * Remembered across launches, but the CATALOGUE decides whether it can be
   * offered: a stored `high` on a model whose `reasoningEfforts` does not list
   * it simply does not reach the request — `effortFor` answers that, once.
   */
  reasoningEffort: EffortLevel | null;
  /**
   * Whether Alia may reach the open web. `true` by default, which is what the
   * backend does when the request says nothing.
   */
  webSearch: boolean;
  /**
   * Models the person pinned to the picker's first group, most recent last.
   *
   * Kept on this device: Alia's API has no per-user favourites endpoint yet, so
   * pins do not follow the account to another device.
   */
  pinnedModels: string[];

  setSelectedModel: (model: string | null) => void;
  setReasoningEffort: (level: EffortLevel | null) => void;
  setWebSearch: (on: boolean) => void;
  togglePinnedModel: (model: string) => void;
}

/**
 * The level to actually SEND, given what the chosen model accepts.
 *
 * Pure, and the single place a stored preference meets a catalogue: a level the
 * model does not list becomes `null` rather than being sent and refused.
 * Exported because the composer renders from the same answer it sends.
 */
export function effortFor(
  stored: EffortLevel | null,
  offered: readonly EffortLevel[],
): EffortLevel | null {
  if (stored === null) return null;
  return offered.includes(stored) ? stored : null;
}

export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      selectedModel: null,
      reasoningEffort: null,
      webSearch: true,
      pinnedModels: [],

      setSelectedModel: (model) => set({ selectedModel: model }),
      setReasoningEffort: (level) => set({ reasoningEffort: level }),
      setWebSearch: (on) => set({ webSearch: on }),
      togglePinnedModel: (model) =>
        set((state) => ({
          pinnedModels: state.pinnedModels.includes(model)
            ? state.pinnedModels.filter((id) => id !== model)
            : [...state.pinnedModels, model],
        })),
    }),
    {
      name: 'chat-storage', // keep same key for backwards compat
      storage: createJSONStorage(() => AsyncStorage),
      version: 3,
      /**
       * Every stored state before v3 names one of Alia's invented modes or
       * routing profiles (`mode:*`, `route:*`) or a retired `alia-*`
       * alias. None is a model any more, so each becomes `null` — the server's
       * default — rather than a guess at which real model it "meant".
       */
      migrate: (persisted, version) => migrateModelState(persisted, version) as ModelState,
    }
  )
);
