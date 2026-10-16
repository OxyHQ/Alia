/**
 * The conversation's participants: Bloom's `AgentProfile` with `[lead, ...joined]`, and the
 * choreography by which a consulted agent joins it (ADR 0020 §7).
 *
 * When the lead consults another agent (`alia.agent_start`), the agent's reply appears in the
 * thread under its own identity (anchor `reply:<agentId>`), and that avatar flies into the header
 * — Bloom's multi-agent join: `centeredLanding`, merging into the profile, staggered when several
 * join at once. The header gains the agent only when its flight lands; with reduced motion, or
 * when there is nothing to measure, it gains it at once. An agent already in the conversation
 * when the chat opens is simply there.
 *
 * This is the ONLY file that draws `AgentProfile` or builds a join flight
 * (`one-thread.test.tsx` holds it), so the header of the sheet, the screen and the Alia app are
 * one header.
 */

import { AgentProfile } from '@oxy.so/bloom/agent-reply';
import { type AvatarFlights, centeredLanding } from '@oxy.so/bloom/avatar-flight';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ANCHORS, useAliaFlights } from '../lib/flights';
import {
  type AliaChatParticipants,
  type AliaLead,
  type AliaParticipant,
  consultedAgents,
} from '../lib/participants';
import type { Message } from '../runtime/types';

/** As Bloom's multi-agent chat flies a waiting agent into its profile. */
const JOIN_DURATION = 950;
const JOIN_STAGGER = 120;
const JOIN_LANDING_SIZE = 14;

/** The flights of agents joining the header: from each one's reply, merging into the profile. */
export function joinFlights(agents: readonly AliaParticipant[]) {
  return agents.map((agent, index) => ({
    key: `join:${agent.id}`,
    character: agent.character,
    from: ANCHORS.reply(agent.id),
    to: ANCHORS.profile,
    landing: centeredLanding(JOIN_LANDING_SIZE),
    duration: JOIN_DURATION,
    delay: index * JOIN_STAGGER,
    merge: true,
  }));
}

/** Two frames: the reply that carries the avatar mounts, then lays out, before it is measured. */
function afterLayout(run: () => void): () => void {
  const raf =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (callback: () => void) => setTimeout(callback, 16) as unknown as number;
  const cancelRaf =
    typeof cancelAnimationFrame === 'function'
      ? cancelAnimationFrame
      : (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  let second: number | undefined;
  const first = raf(() => {
    second = raf(run);
  });
  return () => {
    cancelRaf(first);
    if (second !== undefined) cancelRaf(second);
  };
}

export interface UseParticipantsOptions {
  lead: AliaLead;
  messages: readonly Message[];
  /** The chat's flights; `null` draws everybody in place without flying. */
  flights: AvatarFlights | null;
}

/**
 * Who the header shows, and the joins under way.
 *
 * One batch flies at a time: agents that start answering while a batch (or the lead's own
 * welcome flight) is in the air wait for it to land, then fly together, staggered.
 */
export function useParticipants({
  lead,
  messages,
  flights,
}: UseParticipantsOptions): AliaChatParticipants {
  const consulted = useMemo(() => consultedAgents(messages, lead.id), [messages, lead.id]);
  const [joined, setJoined] = useState<AliaParticipant[]>([]);
  /** Agents waiting for a flight, and the batch in the air (`launched` once it took off). */
  const queue = useRef<AliaParticipant[]>([]);
  const [batch, setBatch] = useState<{ agents: AliaParticipant[]; launched: boolean } | null>(null);
  const [queued, setQueued] = useState(0);
  const flightsRef = useRef(flights);
  flightsRef.current = flights;

  // A new lead is a new conversation: nobody has joined it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the lead alone
  useEffect(() => {
    queue.current = [];
    setJoined([]);
    setBatch(null);
  }, [lead.id]);

  // Everybody who answered is in the header, or on the way to it.
  useEffect(() => {
    const known = new Set([
      ...joined.map((agent) => agent.id),
      ...queue.current.map((agent) => agent.id),
      ...(batch?.agents.map((agent) => agent.id) ?? []),
    ]);
    const already: AliaParticipant[] = [];
    let waiting = false;
    for (const { participant, live } of consulted) {
      if (known.has(participant.id)) continue;
      if (live && flightsRef.current !== null) {
        queue.current = [...queue.current, participant];
        waiting = true;
      } else {
        already.push(participant);
      }
    }
    if (already.length > 0) setJoined((current) => [...current, ...already]);
    if (waiting) setQueued((count) => count + 1);
  }, [consulted, joined, batch]);

  // A batch takes off once nothing else is landing on the header.
  const landing = flights?.isLanding(ANCHORS.profile) ?? false;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `queued` signals the queue (a ref) grew
  useEffect(() => {
    if (batch !== null || landing || queue.current.length === 0) return;
    const agents = queue.current;
    queue.current = [];
    setBatch({ agents, launched: false });
  }, [batch, landing, queued]);

  useEffect(() => {
    if (batch === null || batch.launched) return;
    let live = true;
    const cancel = afterLayout(() => {
      const current = flightsRef.current;
      void (current ? current.launch(joinFlights(batch.agents)) : Promise.resolve(false)).then(
        (flying) => {
          if (!live) return;
          if (flying) setBatch({ agents: batch.agents, launched: true });
          else {
            // Reduced motion, nothing measurable, or superseded: they join without flying.
            setJoined((current) => [...current, ...batch.agents]);
            setBatch(null);
          }
        },
      );
    });
    return () => {
      live = false;
      cancel();
    };
  }, [batch]);

  // The batch is in: the header gains its agents as their avatars land.
  useEffect(() => {
    if (batch === null || !batch.launched || landing) return;
    setJoined((current) => [...current, ...batch.agents]);
    setBatch(null);
  }, [batch, landing]);

  return useMemo(() => ({ lead, joined }), [lead, joined]);
}

export interface AliaParticipantsProps {
  participants: AliaChatParticipants;
  /** Pressing the profile. Omitted, every avatar in it waves. */
  onPress?: () => void;
}

const noop = () => undefined;

/**
 * The header's participants: the lead's avatar above its name, joined by the agents it consulted
 * ("Alia + Sindi"). Place it in the chat's chrome; it is the conversation's title.
 */
export const AliaParticipants = memo(function AliaParticipants({
  participants,
  onPress,
}: AliaParticipantsProps) {
  const flights = useAliaFlights();
  const agents = useMemo(
    () =>
      [participants.lead, ...participants.joined].map((agent) => ({
        id: agent.id,
        name: agent.name,
        avatar: agent.character,
      })),
    [participants],
  );
  return (
    <AgentProfile
      agents={agents}
      onPress={onPress ?? noop}
      avatarRef={flights?.anchor(ANCHORS.profile)}
      avatarHidden={flights?.isLanding(ANCHORS.profile)}
    />
  );
});
