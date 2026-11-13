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
import { useOxy } from '@oxy.so/services/ui/client';
import apiClient from '@/shared/api/client';

interface LocalRuntimeModel {
  /** The identifier to send as `model`, spelled by the API so the two agree. */
  id: string;
  name: string;
}

interface LocalRuntime {
  id: string;
  label: string;
  models: LocalRuntimeModel[];
}

function useLocalRuntimes() {
  const { isAuthenticated } = useOxy();

  return useQuery({
    queryKey: ['local-runtimes'],
    queryFn: async (): Promise<LocalRuntime[]> => {
      const response = await apiClient.get<{ runtimes: LocalRuntime[] }>('/local-runtimes');
      return response.data.runtimes ?? [];
    },
    enabled: isAuthenticated,
    // Kept by the account's realtime connection: a device offering or withdrawing its models is a
    // `runtimes` signal that re-reads this once, and so is a reconnect (`useAppRealtime`). No timer.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
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
export function useLocalModelOptions(): {
  options: LocalModelOption[];
  ids: string[];
  loading: boolean;
} {
  const { data, isLoading } = useLocalRuntimes();
  const options = (data ?? []).flatMap((runtime) =>
    runtime.models.map((model) => ({ id: model.id, name: model.name, deviceLabel: runtime.label })),
  );
  // `loading` is the first fetch only: a device choice is not judged against a
  // list that has not arrived yet.
  return { options, ids: options.map((option) => option.id), loading: isLoading };
}
