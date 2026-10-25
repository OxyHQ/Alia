import type { Socket } from 'socket.io-client';
import { onApiSessionContextChange, socketAccessToken } from './client';

/** Alia Socket.IO handshakes use the bound Oxy session; never retain a bearer. */
export function createApiSocketSession() {
  const controller = new AbortController();
  let disconnect: (() => void) | undefined;
  const unsubscribe = onApiSessionContextChange(() => {
    controller.abort();
    disconnect?.();
  });
  return {
    signal: controller.signal,
    auth(callback: (value: { token?: string }) => void) {
      void socketAccessToken(controller.signal).then(
        (token) => {
          if (!controller.signal.aborted) callback({ token });
        },
        () => {
          if (!controller.signal.aborted) callback({});
        },
      );
    },
    bind(socket: Socket, onContextEnd?: () => void) {
      disconnect = () => {
        socket.disconnect();
        onContextEnd?.();
      };
      if (controller.signal.aborted) disconnect();
    },
    dispose() {
      controller.abort();
      unsubscribe();
    },
  };
}
