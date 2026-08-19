import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { persist, createJSONStorage } from 'zustand/middleware';
import { DEFAULT_MODEL_ID } from '@/lib/config';
import type { EffortLevel } from '@/lib/hooks/use-catalogue';

/**
 * What the user last chose, across app launches.
 *
 * The store holds the REQUESTED identifier and never validates it: the
 * catalogue is the authority on what exists, it is fetched rather than
 * persisted, and `resolveSelection` (`lib/hooks/use-catalogue.ts`) is where a
 * selection the product no longer offers is answered for. A stored `alia-*`
 * identifier is therefore fine and stays fine — the backend still resolves
 * every one of them, and the catalogue simply does not list them any more.
 *
 * ## Three axes, and they are not the same axis
 *
 * `baseModel` used to live beside `selectedModel` for one reason: the composer's
 * thinking toggle SWAPPED the selected model to `alia-v1-thinking` and needed
 * somewhere to remember what to swap back to. ADR 0002 calls that "a reasoning
 * setting wearing a model's name", and the routing table proves it —
 * `alia-v1-thinking` and `alia-v1-pro-max` are two aliases of ONE profile
 * (`profile:v1-pro-max`, `lib/routing/presets.ts`), so the swap never changed
 * where a request routed.
 *
 * What a person picks is therefore three independent things, and this store
 * holds each separately because the request body has always modelled them
 * separately: WHICH model answers ({@link ModelState.selectedModel}), HOW HARD
 * it thinks ({@link ModelState.reasoningEffort}), and WHAT IT MAY REACH FOR
 * ({@link ModelState.webSearch}). Collapsing any two of them into one list is
 * the mistake that produced `alia-v1-thinking` in the first place.
 */
interface ModelState {
  selectedModel: string;
  /**
   * How hard the next turn should think, or `null` for the model's own default.
   *
   * ## This was a boolean, and the boolean was a lie
   *
   * The comment that stood here explained, at length, why a graded control
   * could not honestly be shipped: `thinkingMode` was a boolean, and its ONLY
   * live effect anywhere was a paragraph in the system prompt. The two provider
   * hooks meant to carry it — `experimental_thinking` and
   * `experimental_providerMetadata` — are AI SDK **v4** option names against an
   * `ai@6` install, so even the second state reached no provider at all.
   *
   * It named the two things that had to land first. Both have:
   *
   *  1. the options go out under `providerOptions`, with a real budget per
   *     level — `reasoningEffort` for OpenAI, `thinking.budgetTokens` for
   *     Anthropic, `thinkingConfig` for Google;
   *  2. the request carries a LEVEL, and `GET /catalogue` publishes per entry
   *     which levels EVERY candidate route can honour.
   *
   * ## Which is why this is not persisted per model
   *
   * The level a person picked is remembered across launches, but the CATALOGUE
   * decides whether it can be offered at all: `capabilities.reasoningLevels` is
   * an intersection over an entry's routes, and it is empty for every routing
   * profile. A stored `max` on an entry that offers nothing simply does not
   * reach the request — `effortFor` is where that is answered, once, rather
   * than in each screen that reads the store.
   */
  reasoningEffort: EffortLevel | null;
  /**
   * Whether Alia may reach the open web.
   *
   * `true` by default, which is the behaviour every request has had: the
   * backend put `webSearch`, `webScraper` and `browse` in the always-on tool
   * set. What is new is that turning it OFF now does something — the composer's
   * old "Web search" switch toggled a local `Set` that reached no request field
   * and no backend read.
   */
  webSearch: boolean;

  setSelectedModel: (model: string) => void;
  setReasoningEffort: (level: EffortLevel | null) => void;
  setWebSearch: (on: boolean) => void;
}

/**
 * The level to actually SEND, given what the chosen entry can honour.
 *
 * Pure, and the single place a stored preference meets a catalogue: a level the
 * entry does not offer becomes `null` rather than being sent and dropped
 * server-side. Exported because the composer renders from the same answer it
 * sends, so the control cannot show `high` while the request carries nothing.
 */
export function effortFor(
  stored: EffortLevel | null,
  offered: readonly EffortLevel[],
): EffortLevel | null {
  if (stored === null) return null;
  return offered.includes(stored) ? stored : null;
}

/** The alias whose whole meaning was "this profile, with reasoning on". */
const LEGACY_THINKING_ALIAS = 'alia-v1-thinking';

export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      selectedModel: DEFAULT_MODEL_ID,
      reasoningEffort: null,
      webSearch: true,

      setSelectedModel: (model) => set({ selectedModel: model }),
      setReasoningEffort: (level) => set({ reasoningEffort: level }),
      setWebSearch: (on) => set({ webSearch: on }),
    }),
    {
      name: 'chat-storage', // keep same key for backwards compat
      storage: createJSONStorage(() => AsyncStorage),
      version: 2,
      /**
       * Split the one alias whose meaning was two things.
       *
       * A device that stored `alia-v1-thinking` chose a profile AND a reasoning
       * setting in a single identifier. Left alone, that user would keep getting
       * reasoning — the alias still resolves — while the new toggle read `off`,
       * which is the picker lying about the request it is about to send.
       *
       * Only that one identifier is rewritten. Every other stored `alia-*` id is
       * left exactly as it was: it still resolves server-side, and
       * `resolveSelection` answers for it against the catalogue on the next
       * render. Rewriting them here would duplicate the alias→profile table the
       * API already owns, which is the drift this epic exists to remove.
       */
      migrate: (persisted, version) => {
        const state = persisted as Partial<ModelState> & {
          baseModel?: string;
          thinkingMode?: boolean;
        };

        /**
         * v0 → v1 split the one alias whose meaning was two things.
         *
         * A device that stored `alia-v1-thinking` chose a profile AND a
         * reasoning setting in a single identifier. Left alone, that user would
         * keep getting reasoning — the alias still resolves — while the toggle
         * read `off`, which is the picker lying about the request it is about
         * to send.
         *
         * Only that one identifier is rewritten. Every other stored `alia-*` id
         * is left exactly as it was: it still resolves server-side, and
         * `resolveSelection` answers for it against the catalogue on the next
         * render. Rewriting them here would duplicate the alias→profile table
         * the API already owns.
         */
        const wasThinking = version < 1 && state.selectedModel === LEGACY_THINKING_ALIAS;
        const selectedModel =
          version < 1 && wasThinking
            ? (state.baseModel ?? DEFAULT_MODEL_ID)
            : (state.selectedModel ?? DEFAULT_MODEL_ID);

        /**
         * v1 → v2 turns the boolean into a level.
         *
         * `true` becomes `medium`, the SMALLEST budget the product offers, and
         * not a higher one. The boolean meant "reason" against a code path that
         * sent no budget at all, so anything above the smallest would silently
         * raise the bill of every person who had left the old toggle on — a
         * spend decision made on their behalf by a migration, which is the one
         * place it must never be made.
         */
        const hadThinkingOn = wasThinking || state.thinkingMode === true;

        return {
          ...state,
          selectedModel,
          reasoningEffort: hadThinkingOn ? ('medium' as EffortLevel) : (state.reasoningEffort ?? null),
          // Absent in every stored state before v2, and ON is what the backend
          // has always done.
          webSearch: state.webSearch ?? true,
        } as ModelState;
      },
    }
  )
);
