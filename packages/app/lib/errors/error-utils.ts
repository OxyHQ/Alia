/**
 * Narrow helpers for handling `unknown` caught errors without `any`.
 *
 * Supports both plain `Error` and Axios-style `{ response: { data, status } }` errors.
 */

/** Body shape of an Axios-style error `response.data`. */
export interface ErrorResponseData {
  error?: string;
  message?: string;
  code?: string;
  creditsNeeded?: number;
  [key: string]: unknown;
}

interface MaybeHttpError {
  message?: string;
  name?: string;
  code?: number | string;
  status?: number;
  statusCode?: number;
  response?: {
    status?: number;
    data?: ErrorResponseData;
  };
}

function asObject(err: unknown): MaybeHttpError {
  return typeof err === 'object' && err !== null ? (err as MaybeHttpError) : {};
}

/** Best-effort human-readable message, preferring an API `response.data.error`. */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  const e = asObject(err);
  const responseError = e.response?.data?.error ?? e.response?.data?.message;
  if (responseError) return responseError;
  if (err instanceof Error) return err.message;
  if (e.message) return e.message;
  if (typeof err === 'string') return err;
  return fallback;
}

/** HTTP status from `response.status`, `status`, or `statusCode`. */
export function errorStatus(err: unknown): number | undefined {
  const e = asObject(err);
  return e.response?.status ?? e.status ?? e.statusCode;
}

/** Application/system error code (e.g. `'MODEL_NOT_IN_PLAN'`, `'ENOENT'`, `11000`). */
export function errorCode(err: unknown): number | string | undefined {
  return asObject(err).code;
}

/** Error `name` (e.g. `'AbortError'`). */
export function errorName(err: unknown): string | undefined {
  if (err instanceof Error) return err.name;
  return asObject(err).name;
}

/** The Axios-style `response.data` body of an error, if present. */
export function errorResponseData(err: unknown): ErrorResponseData | undefined {
  return asObject(err).response?.data;
}
