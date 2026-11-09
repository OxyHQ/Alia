import { useUIStore } from '@/features/chat/runtime/ui-store';
import { useEffect, useRef } from 'react';

/**
 * Keep the agent editor beside the chat on the agent the person is with.
 *
 * When the agent on screen CHANGES (another agent's thread, another agent's chat) while the editor
 * panel is open, the panel edits that agent; if the person leaves for a chat with no agent (Alia),
 * the panel closes, since it would be editing something the screen no longer shows. Opening the
 * editor on another participant of the same chat (the header's menu) changes nothing here: the
 * agent on screen did not change.
 */
export function useEditorFollowsAgent(agentId: string | undefined): void {
  const previous = useRef(agentId);
  useEffect(() => {
    if (previous.current === agentId) return;
    previous.current = agentId;
    const { rightPanel, openAgentEditor, setRightPanel } = useUIStore.getState();
    if (rightPanel !== 'editor') return;
    if (agentId === undefined) setRightPanel(null);
    else openAgentEditor(agentId);
  }, [agentId]);
}
