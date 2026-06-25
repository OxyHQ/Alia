/**
 * Narrow error helpers for handling `unknown` caught errors.
 *
 * Dockerode (and Node) errors expose `message` and frequently an HTTP-like
 * `statusCode`. These helpers read those fields safely without resorting to `any`.
 */

interface DockerLikeError {
  message?: string;
  statusCode?: number;
}

function asDockerLikeError(err: unknown): DockerLikeError {
  if (typeof err === 'object' && err !== null) {
    return err as DockerLikeError;
  }
  return {};
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  const { message } = asDockerLikeError(err);
  if (message) return message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}

export function errorStatusCode(err: unknown): number | undefined {
  return asDockerLikeError(err).statusCode;
}
