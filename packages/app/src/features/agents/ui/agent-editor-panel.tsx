import { AgentEditorLoader } from '@/features/agents/ui/edit/agent-editor-loader';
import { useUIStore } from '@/features/chat/runtime/ui-store';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

/**
 * The agent editor: the right panel, beside the conversation, as Bloom's multi-agent chat shows
 * it. It is the ONLY editor (there is no editor route): the panel loads the agent, then hands it
 * to a form that owns the draft.
 *
 * ## The split is what stopped the write loop
 *
 * There was one component, and it copied the fetched agent into eighteen `useState`s from an
 * effect that listed the fetched agent in its dependencies. `useUpdateAgent` writes the
 * mutation's answer into `agents.detail`, so every save handed that effect a new record;
 * re-seeding assigned fresh references to the very state a second effect watched in order to
 * decide to save; and that effect saved. One keystroke wrote for as long as the editor stayed
 * open — a PATCH every two seconds, plus an `updateAccount` to Oxy, each with its own toast.
 *
 * A `key` on the form is the whole cure. The draft is seeded ONCE, from props, in `useState`
 * initialisers; a newer record arriving in the cache re-renders this component and changes
 * nothing inside the form. And a save is an EDIT's consequence: `editDraft` and `editIdentity`
 * (`runtime/use-agent-autosave.ts`) are the only ways the draft changes, each schedules its own
 * write, and nothing observes state in order to write
 * (`__tests__/autosave-writes-once.test.tsx` pins it).
 */
export function AgentEditorPanel() {
  const router = useRouter();
  const agentId = useUIStore((s) => s.editedAgentId);
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  // The creator draws its own header, with the close button: the panel adds none.
  return (
    <View className="flex-1" testID="agent-editor-panel">
      <AgentEditorLoader
        agentId={agentId ?? undefined}
        onClose={() => setRightPanel(null)}
        onBackToList={() => {
          setRightPanel(null);
          router.replace('/(app)/agents');
        }}
      />
    </View>
  );
}
