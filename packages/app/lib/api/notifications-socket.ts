/**
 * THE Socket.IO connection to Alia, shared by everything that listens on it.
 *
 * ## Why this module exists
 *
 * There were two connections. `use-notification-setup.ts` opened one for the
 * `notification` event and `use-show-progress.ts` opened another for
 * `show:progress` — while its own header claimed the opposite, in these words:
 * *"the actual socket connection is managed by use-notification-setup. This hook
 * just registers the show:progress listener."* It did not; it built a second
 * refcounted singleton of its own, so a signed-in user on the shows screen held
 * two websockets to the same server, authenticated with the same token, joined
 * to the same room.
 *
 * That is not merely wasteful. Both sockets emit `subscribe-notifications` and
 * both are in `user:<id>`, so every server-side emit is delivered twice — once
 * per socket — and a listener registered on the wrong one of the two sees
 * nothing at all. Which one a hook got depended on mount order.
 *
 * ## Refcounted, because two hooks own it and neither may close it
 *
 * `acquire` returns the connection and a release function. The socket is
 * created on the first acquire and disconnected when the last holder releases,
 * so a screen unmounting does not disconnect the notification listener that the
 * app layout still needs.
 *
 * The count is module state rather than React state deliberately: the socket
 * outlives every component that uses it, and a hook re-rendering must not create
 * a second one. Nothing reads this state during render — the hooks subscribe in
 * an effect and read events through callbacks — so there is no memoized read of
 * external mutable state here.
 */

import { io as socketIO, type Socket } from 'socket.io-client';
import config from '@/lib/config';
import { getSocketToken } from '@/lib/api/client';

let socket: Socket | null = null;
let holders = 0;

/**
 * Take a reference to the shared socket, and get back the way to give it up.
 *
 * The caller registers its own listeners on the returned socket and removes
 * them itself; `release` only manages the CONNECTION. A release that also
 * removed listeners would remove another holder's.
 */
export function acquireNotificationsSocket(): { socket: Socket; release: () => void } {
  if (socket === null) {
    socket = socketIO(config.apiUrl, {
      transports: ['websocket'],
      // Function form so a fresh token is read on every (re)connect — an access
      // token is short-lived and a captured one reconnects with an expired
      // credential after the first refresh.
      auth: (cb) => cb({ token: getSocketToken() }),
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    // Joined here rather than by each holder: the room is derived server-side
    // from the authenticated user, so it is a property of the CONNECTION and
    // subscribing once per listener would emit the same join repeatedly.
    socket.on('connect', () => {
      socket?.emit('subscribe-notifications');
    });
  }

  const live = socket;
  holders += 1;

  // A holder that acquires while the socket is ALREADY connected never sees the
  // `connect` event, so it would sit in no room at all. Emitting here covers
  // that case; the server treats a repeated subscribe as idempotent.
  if (live.connected) live.emit('subscribe-notifications');

  let released = false;
  return {
    socket: live,
    release: () => {
      // Guarded, because React can run a cleanup twice in strict mode and a
      // double release would take the count negative and close a socket other
      // holders are still using.
      if (released) return;
      released = true;
      holders -= 1;
      if (holders <= 0) {
        holders = 0;
        socket?.disconnect();
        socket = null;
      }
    },
  };
}
