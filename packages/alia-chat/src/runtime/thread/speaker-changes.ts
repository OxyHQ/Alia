/**
 * The turns where another agent comes into the conversation.
 *
 * Agent-authored replies carry `agentInfo`, including the lead's scheduled or proactive replies.
 * The conversation's members (the direct agent or the group's roster) distinguish those from
 * consultations with an outside agent. The thread marks the turn where a consulted agent starts
 * speaking, or starts again after the lead has spoken in between, with a line saying whom the person is now
 * chatting with. Consecutive replies of one agent get the line once; the lead resuming gets none
 * (it is the conversation's own voice) but does reset the run, so the same agent coming back is
 * announced again.
 *
 * Only an agent from OUTSIDE the conversation is announced. The members of a group chat are in
 * it: each speaks as itself, with its own name on its message, as in any group chat, and a line
 * saying whom the person is "now chatting with" at each change of speaker would be wrong.
 *
 * What a consulted agent said is not part of the person's conversation: the lead already answers
 * with it. The thread shows the line and nothing under it, and the line opens the exchange.
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
  /** The direct agent or group members: never announced. */
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

/**
 * The replies of agents from OUTSIDE the conversation, every one of them: what a consulted agent
 * said, which the thread leaves out under the line that announces it (the exchange it opens has
 * it). A group's members and the lead are never in it.
 */
export function consultedReplies(
  rows: readonly {
    readonly id: string;
    readonly role: string;
    readonly agentInfo?: { readonly id: string; readonly name: string } | null;
  }[],
  members?: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.role === 'assistant' && row.agentInfo && !members?.has(row.agentInfo.id)) {
      ids.add(row.id);
    }
  }
  return ids;
}
