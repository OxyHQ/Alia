import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { persist, createJSONStorage } from 'zustand/middleware';
import { DEFAULT_MODEL_ID } from '@/lib/config';

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
 * ## Extended thinking is a flag here, not a model
 *
 * `baseModel` used to live beside `selectedModel` for one reason: the composer's
 * thinking toggle SWAPPED the selected model to `alia-v1-thinking` and needed
 * somewhere to remember what to swap back to. ADR 0002 calls that "a reasoning
 * setting wearing a model's name", and the routing table proves it —
 * `alia-v1-thinking` and `alia-v1-pro-max` are two aliases of ONE profile
 * (`profile:v1-pro-max`, `lib/routing/presets.ts`), so the swap never changed
 * where a request routed. All it changed was the prompt, via the `thinkingMode`
 * request flag the composer already sends.
 *
 * So thinking is its own boolean, orthogonal to the profile, exactly as the
 * request body has always modelled it. `baseModel` goes with the swap.
 */
interface ModelState {
  selectedModel: string;
  /**
   * The `thinkingMode` request flag.
   *
   * Independent of {@link selectedModel} on purpose: the backend applies the
   * reasoning prompt on ANY profile (`system-prompt-builder.ts`), so a person
   * can ask for extended thinking on the cheap profile or the dear one. It is a
   * boolean rather than a level because the backend supports two states and a
   * `low | medium | high` control would be three labels for two behaviours.
   *
   * ## A third level would promise something the request does not carry
   *
   * Measured rather than assumed, and it is worse than "the backend supports
   * two states": as of this writing the second state does not reach a provider
   * either. `lib/chat/model-config.ts` wrote the reasoning options under
   * `experimental_thinking` and `experimental_providerMetadata`, which are AI
   * SDK **v4** names against an `ai@6` install — neither string occurs anywhere
   * in the installed package. So `thinkingMode`'s only live effect anywhere is
   * a sentence in the system prompt.
   *
   * Two things therefore have to land before a `normal | thinking | high`
   * control can mean anything, and neither is a UI change:
   *
   *  1. the options have to be sent under `providerOptions`, which is a spend
   *     decision because thinking tokens bill as output;
   *  2. the request has to carry a LEVEL rather than a boolean, and the
   *     catalogue has to say which models offer which levels — there is no
   *     per-model reasoning capability today, in either the routing table's
   *     `ModelCapabilities` or anywhere the router can read.
   *
   * Shipping three labels first would be an interface promising a reasoning
   * budget that is never transmitted.
   */
  thinkingMode: boolean;

  setSelectedModel: (model: string) => void;
  setThinkingMode: (on: boolean) => void;
}

/** The alias whose whole meaning was "this profile, with reasoning on". */
const LEGACY_THINKING_ALIAS = 'alia-v1-thinking';

export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      selectedModel: DEFAULT_MODEL_ID,
      thinkingMode: false,

      setSelectedModel: (model) => set({ selectedModel: model }),
      setThinkingMode: (on) => set({ thinkingMode: on }),
    }),
    {
      name: 'chat-storage', // keep same key for backwards compat
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
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
        const state = persisted as Partial<ModelState> & { baseModel?: string };
        if (version >= 1) return state as ModelState;

        const wasThinking = state.selectedModel === LEGACY_THINKING_ALIAS;
        return {
          ...state,
          // `baseModel` was what the toggle swapped back to, so it is the
          // profile the user actually wanted. Nothing else consulted it.
          selectedModel: wasThinking
            ? (state.baseModel ?? DEFAULT_MODEL_ID)
            : (state.selectedModel ?? DEFAULT_MODEL_ID),
          thinkingMode: wasThinking,
        } as ModelState;
      },
    }
  )
);
