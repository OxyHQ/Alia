/**
 * The one error type the control API turns into a response.
 *
 * `code` is a stable machine word the Alia API branches on; `message` is a
 * sentence an agent can act on. Neither ever carries a command, a path the
 * caller did not send, or Docker's own output — Docker's stderr names host
 * paths and container ids, which are this machine's business.
 */
export class HostError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'HostError';
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}
