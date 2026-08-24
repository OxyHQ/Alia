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

interface LocalRuntimeState {
  /**
   * Whether this device offers its runtime to the account at all.
   *
   * On by DETECTION rather than by opt-in: the probe is one request to an
   * address on this machine, it fails in milliseconds when nothing is listening,
   * and a person who has installed Ollama has already decided to run models
   * locally. Nothing is announced and nothing is offered until a runtime
   * actually answers, so the common case — no local server — is silent.
   *
   * The switch exists for the case detection gets wrong in the other direction:
   * a person who runs a local model but does not want this browser answering
   * turns for their other devices.
   */
  enabled: boolean;
  endpoint: string;
  /** Stable across reconnects and app launches; how other devices name this one. */
  runtimeId: string;
  /** What this device calls itself in another device's model picker. */
  label: string;
  /** Last known model list, so the picker has something before the first probe. */
  models: string[];
  setEnabled: (enabled: boolean) => void;
  setEndpoint: (endpoint: string) => void;
  setLabel: (label: string) => void;
  setModels: (models: string[]) => void;
}

export const useLocalRuntimeStore = create<LocalRuntimeState>()(
  persist(
    (set) => ({
      enabled: true,
      endpoint: DEFAULT_LOCAL_ENDPOINT,
      runtimeId: randomUUID(),
      label: '',
      models: [],
      setEnabled: (enabled) => set({ enabled }),
      setEndpoint: (endpoint) => set({ endpoint }),
      setLabel: (label) => set({ label }),
      setModels: (models) => set({ models }),
    }),
    {
      name: 'alia-local-runtime',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
    },
  ),
);
