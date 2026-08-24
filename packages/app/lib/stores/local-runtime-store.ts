/**
 * The inference runtime running on THIS device, if the person has one.
 *
 * Ollama, LM Studio, llama.cpp's server, vLLM — anything answering the OpenAI
 * shape at an address only this device can reach. Alia's backend still runs the
 * whole turn (prompt, tools, memory, persistence); this device only carries the
 * bytes, because `localhost` is not a place a server in another datacentre can
 * dial.
 *
 * ## Why the address lives here and nowhere else
 *
 * `endpoint` is never sent to the API. A server that accepted a URL and fetched
 * it would be a server-side-request-forgery primitive with a settings screen in
 * front of it; keeping the address client-side means the only thing that can
 * reach it is the browser that already could.
 *
 * `runtimeId` is minted once and kept, because a model selection has to survive
 * a reconnect — a socket id would not — and because the person's OTHER devices
 * address this one by that id.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';

/** Ollama's own OpenAI-compatible surface, which is the common case. */
export const DEFAULT_LOCAL_ENDPOINT = 'http://localhost:11434/v1';

/**
 * Whether the person has been asked, and what they said.
 *
 * Three states rather than a boolean, because "not yet asked" and "asked and
 * said no" must not look the same: the first should still be offered, the
 * second must never be offered again.
 */
export type LocalRuntimeConsent = 'unasked' | 'granted' | 'declined';

interface LocalRuntimeState {
  /**
   * Nothing touches `localhost` until this is `granted`.
   *
   * The probe is one request from the person's own browser to their own
   * machine, which is cheap and reveals nothing to anyone else — but it is
   * still their machine, and Chrome is moving toward prompting for local
   * network access itself. A browser permission dialog arriving with no
   * context is worse than being asked in the product first, so the product
   * asks first and the probe waits.
   */
  consent: LocalRuntimeConsent;
  endpoint: string;
  /** Stable across reconnects and app launches; how other devices name this one. */
  runtimeId: string;
  /** What this device calls itself in another device's model picker. */
  label: string;
  /** Last known model list, so the picker has something before the first probe. */
  models: string[];
  setConsent: (consent: LocalRuntimeConsent) => void;
  setEndpoint: (endpoint: string) => void;
  setLabel: (label: string) => void;
  setModels: (models: string[]) => void;
}

export const useLocalRuntimeStore = create<LocalRuntimeState>()(
  persist(
    (set) => ({
      consent: 'unasked',
      endpoint: DEFAULT_LOCAL_ENDPOINT,
      runtimeId: randomUUID(),
      label: '',
      models: [],
      setConsent: (consent) => set({ consent }),
      setEndpoint: (endpoint) => set({ endpoint }),
      setLabel: (label) => set({ label }),
      setModels: (models) => set({ models }),
    }),
    {
      name: 'alia-local-runtime',
      storage: createJSONStorage(() => AsyncStorage),
      version: 2,
      /**
       * v1's `enabled` was a DEFAULT, not a decision.
       *
       * It shipped as `true` so detection was automatic, which means a stored
       * `true` records that nobody ever asked — not that anybody agreed. Every
       * v1 device therefore arrives at `unasked` and gets the question once,
       * including the ones that were already probing.
       */
      migrate: (persisted) => {
        const state = persisted as Partial<LocalRuntimeState> & { enabled?: boolean };
        delete state.enabled;
        return { ...state, consent: 'unasked' as const };
      },
    },
  ),
);
