import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { persist, createJSONStorage } from 'zustand/middleware';
import { DEFAULT_POWER_LEVEL, type PowerLevel } from '@gemies/sdk/model';
import { migrateModelState } from './model-store-migration';

/**
 * What the user last chose, across app launches.
 *
 * HOW MUCH POWER a turn gets ({@link ModelState.selectedLevel}). Whether Alia may search the web is
 * not a choice held here: she can always search, and the server decides when it is worth it.
 *
 * The store holds the REQUESTED value and never validates it:
 * `resolveModeSelection` (`src/features/chat/model/power-levels.ts`) is where a
 * choice the app cannot send right now is answered for.
 */
interface ModelState {
  /**
   * A power level (`auto`, `instant`, `medium`, `high`, `xhigh`, `pro`,
   * `ultra`), or a model on one of the person's own devices (`local/…`).
   * `auto` is where everyone starts: Oxy picks the level each turn needs.
   * Never a hosted model: Alia's users choose power, not models.
   */
  selectedLevel: PowerLevel | string;

  setSelectedLevel: (level: PowerLevel | string) => void;
}

export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      selectedLevel: DEFAULT_POWER_LEVEL,

      setSelectedLevel: (level) => set({ selectedLevel: level }),
    }),
    {
      name: 'chat-storage', // keep same key for backwards compat
      storage: createJSONStorage(() => AsyncStorage),
      version: 5,
      /**
       * v4 replaced the model picker with power levels. Every stored model
       * becomes `auto`; the old `instant` / `max` efforts become `instant` /
       * `ultra`; a device model survives (`model-store-migration.ts`). v5 dropped the web
       * search switch: a stored `webSearch` is not carried over.
       */
      migrate: (persisted, version) => migrateModelState(persisted, version) as ModelState,
    },
  ),
);
