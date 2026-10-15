import { useEffect } from 'react';
import { useOxy } from '@oxy.so/services/ui/client';
import type { AliaAvatarState } from '../components/AliaAvatar';
import { selectAliaActivity, useAliaActivityStore } from '../lib/activity-store';
import { acquireActivitySocket } from '../lib/activity-socket';
import { ALIA_API_URL } from '../lib/api-url';

export interface UseAliaActivityOptions {
  /** The API the activity socket connects to. Defaults to the runtime's `apiUrl`. */
  apiUrl?: string;
}

/**
 * What Alia is doing right now, for any surface that wants to show it — an "Ask Alia" button's
 * avatar, a status dot. It is the busiest of:
 *
 * - a turn running in this app (`useConversationThread`, so every chat drives every button), and
 * - her runs for the signed-in person elsewhere, reported by the server over one shared socket
 *   (background work, another device), connected only while someone is signed in AND using this.
 */
export function useAliaActivity(options: UseAliaActivityOptions = {}): AliaAvatarState {
  const { apiUrl = ALIA_API_URL } = options;
  const { oxyServices, isAuthenticated } = useOxy();

  useEffect(() => {
    if (!isAuthenticated) return;
    return acquireActivitySocket(apiUrl, () => oxyServices.session.accessToken);
  }, [apiUrl, isAuthenticated, oxyServices]);

  return useAliaActivityStore(selectAliaActivity);
}
