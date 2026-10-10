import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { persist, createJSONStorage } from 'zustand/middleware';
import { DEFAULT_POWER_LEVEL, type PowerLevel } from '@/features/chat/model/power-levels';
import { migrateModelState } from './model-store-migration';

/**
 * What the user last chose, across app launches.
 *
 * Two independent things, held separately because the request body models
 * them separately: HOW MUCH POWER a turn gets ({@link ModelState.selectedLevel})
 * and WHAT IT MAY REACH FOR ({@link ModelState.webSearch}).
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
  /**
   * Whether Alia may reach the open web. `true` by default, which is what the
   * backend does when the request says nothing.
   */
  webSearch: boolean;

  setSelectedLevel: (level: PowerLevel | string) => void;
  setWebSearch: (on: boolean) => void;
}

export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      selectedLevel: DEFAULT_POWER_LEVEL,
      webSearch: true,

      setSelectedLevel: (level) => set({ selectedLevel: level }),
      setWebSearch: (on) => set({ webSearch: on }),
    }),
    {
      name: 'chat-storage', // keep same key for backwards compat
      storage: createJSONStorage(() => AsyncStorage),
      version: 4,
      /**
       * v4 replaced the model picker with power levels. Every stored model
       * becomes `auto`; the old `instant` / `max` efforts become `instant` /
       * `ultra`; a device model survives (`model-store-migration.ts`).
       */
      migrate: (persisted, version) => migrateModelState(persisted, version) as ModelState,
    },
  ),
);
