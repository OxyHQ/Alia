import { AgentEditor } from '@/components/agents/edit/agent-editor';
import {
  AgentEditorLoadFailed,
  AgentEditorLoading,
} from '@/components/agents/edit/agent-editor-load-states';
import { useAgent } from '@/lib/hooks/use-agents';
import { useLocalSearchParams, useRouter } from 'expo-router';

/**
 * The agent editor: load the agent, then hand it to a form that owns the draft.
 *
 * ## The split is what stopped the write loop
 *
 * There was one component, and it copied the fetched agent into eighteen
 * `useState`s from an effect that listed the fetched agent in its dependencies.
 * `useUpdateAgent` writes the mutation's answer into `agents.detail`, so every
 * save handed that effect a new record; re-seeding assigned fresh references
 * (`agent.skills || []`) to the very state a second effect watched in order to
 * decide to save; and that effect saved. **One keystroke wrote for as long as
 * the screen stayed open** — measured at a PATCH every two seconds, plus an
 * `updateAccount` to Oxy alongside it, each with its own toast. That is what
 * "no para de mostrar toasts que pone saving" was.
 *
 * A `key` on the form is the whole cure. The draft is seeded ONCE, from props,
 * in `useState` initialisers; a newer record arriving in the cache re-renders
 * this component and changes nothing inside the form. Two effects, a
 * `isInitialLoad` ref and a 500ms timer that existed only to stop the seeding
 * from tripping the saving all went with it.
 *
 * ## And a save is now an EDIT's consequence
 *
 * `editDraft` and `editIdentity` (`lib/hooks/agents/use-agent-autosave.ts`)
 * are the only ways the draft changes, and each schedules its own write.
 * Nothing observes state in order to write, so no amount of re-rendering can
 * produce a request — which is the property
 * `__tests__/autosave-writes-once.test.tsx` pins.
 */
export default function EditAgentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data: agent, isError, error, refetch } = useAgent(id);

  // Keyed on the agent, so opening a DIFFERENT one starts a different draft
  // and opening the same one again never restarts this one.
  if (agent !== undefined) {
    return <AgentEditor key={agent._id} agent={agent} />;
  }

  /**
   * A query that FAILED is not one that is loading.
   *
   * This screen used to render "Loading…" for `isPending || agent === undefined`,
   * and an errored query satisfies the second half forever — `isPending` is
   * false and `data` stays `undefined` — so a 404 was indistinguishable from a
   * fetch in flight and the screen never left it (#530).
   */
  if (isError) {
    return (
      <AgentEditorLoadFailed
        error={error}
        onRetry={() => void refetch()}
        onBackToList={() => router.replace('/(app)/agents')}
      />
    );
  }

  return <AgentEditorLoading />;
}
