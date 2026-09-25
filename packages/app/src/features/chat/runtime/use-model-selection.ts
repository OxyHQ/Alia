import { resolveSelection, useCatalogue, type ModelSelection } from '@/features/chat/runtime/use-catalogue';
import { useLocalModelOptions } from '@/features/local-models/runtime/use-local-runtimes';

/**
 * A stored model choice resolved against the catalogue AND this account's
 * connected devices — the one answer the picker draws and the request sends,
 * so the two cannot disagree. `null` is "no choice": the server's default.
 */
export function useModelSelection(requestedId: string | null): ModelSelection {
  const { data: catalogue } = useCatalogue();
  const { ids: localModelIds } = useLocalModelOptions();
  return resolveSelection(requestedId, catalogue, localModelIds);
}
