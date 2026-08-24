/**
 * Every local runtime this account has connected, from any of the person's devices.
 *
 * Read from the API rather than from the local store on purpose: a phone cannot
 * reach the laptop's `localhost`, so the only way it learns which models the
 * laptop can run is the announcement the laptop made when it connected. The
 * device serving the model and the device choosing it are frequently not the
 * same one, and this is what makes that work.
 */
import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import apiClient from '../api/client';

export interface LocalRuntimeModel {
  /** The identifier to send as `model`, spelled by the API so the two agree. */
  id: string;
  name: string;
}

export interface LocalRuntime {
  id: string;
  label: string;
  models: LocalRuntimeModel[];
}

/**
 * Short, because a runtime's lifetime is a browser tab's lifetime.
 *
 * A stale list offers a model that answers with a refusal, so this is refetched
 * often enough that the picker greys out a closed tab rather than pretending.
 */
const REFRESH_MS = 30_000;

export function useLocalRuntimes() {
  const { isAuthenticated } = useOxy();

  return useQuery({
    queryKey: ['local-runtimes'],
    queryFn: async (): Promise<LocalRuntime[]> => {
      const response = await apiClient.get<{ runtimes: LocalRuntime[] }>('/local-runtimes');
      return response.data.runtimes ?? [];
    },
    enabled: isAuthenticated,
    refetchInterval: REFRESH_MS,
    staleTime: REFRESH_MS,
    retry: false,
  });
}

export interface LocalModelOption {
  /** What a request carries as `model`. */
  id: string;
  /** The tag the person knows it by, e.g. `llama3.1:8b`. */
  name: string;
  /** Which of their devices is running it. */
  deviceLabel: string;
}

/**
 * The connected runtimes flattened into pickable entries.
 *
 * The device label travels with each entry because a model name alone is
 * ambiguous the moment two machines are connected — the same `llama3.1:8b` on a
 * laptop and on a desktop are two different answers with two different latencies.
 */
export function useLocalModelOptions(): { options: LocalModelOption[]; ids: string[] } {
  const { data } = useLocalRuntimes();
  const options = (data ?? []).flatMap((runtime) =>
    runtime.models.map((model) => ({ id: model.id, name: model.name, deviceLabel: runtime.label })),
  );
  return { options, ids: options.map((option) => option.id) };
}
