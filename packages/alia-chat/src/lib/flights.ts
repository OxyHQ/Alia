import { createContext, useContext } from 'react';
import type { AvatarFlights, AvatarFlightSpec } from '@oxy.so/bloom/avatar-flight';

import { ALIA_AVATAR } from '../components/AliaAvatar';

/** Where Alia's avatar is in the chat: large in the greeting, then small in the header's profile. */
export const ALIA_ANCHORS = { welcome: 'alia:welcome', profile: 'alia:profile' } as const;

/** The greeting's avatar flies up into the header's profile as the conversation begins. */
export const ALIA_TO_PROFILE: AvatarFlightSpec = {
  key: 'alia',
  character: ALIA_AVATAR,
  from: ALIA_ANCHORS.welcome,
  to: ALIA_ANCHORS.profile,
  duration: 800,
};

const FlightsContext = createContext<AvatarFlights | null>(null);

/** The chat's avatar flights, for the greeting and the header that share them. */
export const AliaFlightsProvider = FlightsContext.Provider;

/** `null` outside a chat: the greeting and the header then draw their avatars without flying. */
export const useAliaFlights = () => useContext(FlightsContext);
