/**
 * Narrow helpers for handling `unknown` caught errors without `any`.
 *
 * Supports both plain `Error` and Axios-style `{ response: { data, status } }` errors.
 */

/**
 * Body shape of an Axios-style error `response.data`.
 *
 * `error` is a STRING on some surfaces and an OBJECT on others: everything
 * under `/v1` answers `{ error: { message, type } }`, which is the OpenAI shape
 * it is compatible with. Typing it as a string was not a simplification, it was
 * a claim that is false half the time — and it is what let an object reach a
 * `<Text>` and crash the screen with React error #31.
 */
export interface ErrorResponseData {
  error?: string | { message?: string; type?: string };
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

/**
 * A string out of an API error body, whichever shape it came in.
 *
 * `/v1` answers `{ error: { message, type } }` — the OpenAI shape it is
 * compatible with — and everything else answers `{ error: "text" }`. Both are
 * correct for their surface, so the reader has to know both; the alternative is
 * every call site guessing, and the ones that guessed wrong put an object into
 * a `<Text>` and took the screen down with React error #31.
 *
 * Exported because some callers hold a parsed body rather than the error it
 * came from — a `fetch` that checked `res.ok` itself, for instance.
 */
export function errorBodyText(
  data: ErrorResponseData | undefined,
  fallback = 'Something went wrong',
): string {
  if (typeof data?.error === 'string' && data.error) return data.error;
  if (typeof data?.error === 'object' && data.error?.message) return data.error.message;
  if (data?.message) return data.message;
  return fallback;
}

/**
 * Best-effort human-readable message, preferring an API `response.data.error`.
 *
 * Returns a STRING, always. It used to return whatever `data.error` held while
 * declaring a string, so an `/v1` body — `{ error: { message, type } }` — came
 * out as an object, was stored as an error, and crashed the render that tried
 * to show it. A function whose return type is a promise the body does not keep
 * is worse than one that admits it might fail.
 */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  const e = asObject(err);
  const body = e.response?.data;
  if (body) {
    const fromBody = errorBodyText(body, '');
    if (fromBody) return fromBody;
  }
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
