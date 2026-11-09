/**
 * The turns where another agent comes into the conversation.
 *
 * A reply from an agent the lead consulted carries that agent's identity (`agentInfo`); the lead's
 * own replies carry none. The thread marks the turn where a consulted agent starts speaking, or
 * starts again after the lead has spoken in between, with a line saying whom the person is now
 * chatting with. Consecutive replies of one agent get the line once; the lead resuming gets none
 * (it is the conversation's own voice) but does reset the run, so the same agent coming back is
 * announced again.
 *
 * Only an agent from OUTSIDE the conversation is announced. The members of a group chat are in
 * it: each speaks as itself, with its own name on its message, as in any group chat, and a line
 * saying whom the person is "now chatting with" at each change of speaker would be wrong.
 */
export interface SpeakerChange {
  /** The agent that starts speaking here. */
  readonly agentName: string;
}

export function speakerChanges(
  rows: readonly {
    readonly id: string;
    readonly role: string;
    readonly agentInfo?: { readonly id: string; readonly name: string } | null;
  }[],
  /** The agents that are part of this conversation (a group's members): never announced. */
  members?: ReadonlySet<string>,
): Map<string, SpeakerChange> {
  const changes = new Map<string, SpeakerChange>();
  let current: string | null = null;
  for (const row of rows) {
    if (row.role !== 'assistant') continue;
    const speaker = row.agentInfo?.id ?? null;
    if (speaker !== null && speaker !== current && row.agentInfo && !members?.has(speaker)) {
      changes.set(row.id, { agentName: row.agentInfo.name });
    }
    current = speaker;
  }
  return changes;
}
