import { createContext, useContext } from 'react';
import type { AvatarFlights, AvatarFlightSpec } from '@oxy.so/bloom/avatar-flight';

import type { AliaParticipant } from './participants';

/**
 * Where the conversation's avatars are: the lead's, large in the greeting; everybody's, small in
 * the header's participants; and a consulted agent's, beside the reply it is writing.
 */
export const ANCHORS = {
  welcome: 'lead:welcome',
  profile: 'participants',
  reply: (agentId: string) => `reply:${agentId}`,
} as const;

/** The greeting's avatar flies up into the header's participants as the conversation begins. */
export function leadToProfile(lead: AliaParticipant): AvatarFlightSpec {
  return {
    key: 'lead',
    character: lead.character,
    from: ANCHORS.welcome,
    to: ANCHORS.profile,
    duration: 800,
  };
}

const FlightsContext = createContext<AvatarFlights | null>(null);

/** The chat's avatar flights, for the greeting, the thread and the header that share them. */
export const AliaFlightsProvider = FlightsContext.Provider;

/** `null` outside a chat: the greeting, the replies and the header then draw their avatars without flying. */
export const useAliaFlights = () => useContext(FlightsContext);
