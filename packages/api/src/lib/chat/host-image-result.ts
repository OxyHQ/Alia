/**
 * Image results of awaited host tools (`docs/agent-embedding.md` §2): a browser's screenshot of
 * the tab the agent is acting in.
 *
 * ## The contract
 *
 * An awaited host tool's `result` that is an object with `type: "image"` IS an image result, and
 * must be exactly `{ type: "image", mediaType, data, text? }`: `mediaType` one of
 * {@link HOST_IMAGE_MEDIA_TYPES}, `data` the image's bytes in standard base64 (no `data:`
 * prefix, no whitespace) whose first bytes are that format's signature, `text` an optional caption
 * of at most {@link HOST_IMAGE_TEXT_MAX_CHARS} characters. Anything else claiming `type: "image"`
 * is refused when the client answers (`invalid_host_result`), because the model would otherwise
 * receive bytes no provider can decode, and the provider's refusal would fail the whole turn. Its
 * size is bounded like every result: `HOST_RESULT_MAX_CHARS` of JSON.
 *
 * ## Only for the turn
 *
 * The model receives the image itself in the turn whose tool asked for it
 * ({@link hostToolModelOutput}). Everything that outlives the turn keeps a placeholder instead
 * ({@link withoutHostImageData}): the `alia.tool_result` frame the client receives (it sent the
 * image, it needs no echo), the stored conversation's tool result, and therefore every later turn
 * that replays it. A screenshot is a view of a moment: replaying a stale one costs the next
 * request up to 100 kB of base64 per call and shows the model a page that has moved on, and the
 * agent takes a fresh one when it needs to look again.
 */
import type { ToolResultPart } from 'ai';
import {
  HOST_IMAGE_MEDIA_TYPES,
  HOST_IMAGE_TEXT_MAX_CHARS,
  type HostImageMediaType,
} from '../../domain/chat-host-results.js';

export interface HostImageResult {
  type: 'image';
  mediaType: HostImageMediaType;
  data: string;
  text?: string;
}

/** What an image result becomes once its turn is over: everything but the bytes. */
export interface HostImagePlaceholder {
  type: 'image';
  mediaType: string;
  text?: string;
  omitted: true;
}

const IMAGE_KEYS = new Set(['type', 'mediaType', 'data', 'text']);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` claims to be an image result (`type: "image"`), valid or not. */
function claimsImage(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === 'image';
}

/** Whether the decoded head of `data` is the signature of `mediaType`. */
function signatureMatches(mediaType: HostImageMediaType, data: string): boolean {
  const head = Buffer.from(data.slice(0, 16), 'base64');
  switch (mediaType) {
    case 'image/png':
      return head
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'image/webp':
      return (
        head.subarray(0, 4).toString('latin1') === 'RIFF' &&
        head.subarray(8, 12).toString('latin1') === 'WEBP'
      );
  }
}

/**
 * Why `result` is not a valid image result, naming the field (`result.<key>`), or `null` when it
 * is valid or does not claim to be one. Size is not judged here: the caller bounds every result.
 */
export function hostImageResultProblem(result: unknown): { param: string; message: string } | null {
  if (!claimsImage(result)) return null;
  for (const key of Object.keys(result)) {
    if (!IMAGE_KEYS.has(key)) {
      return {
        param: `result.${key}`,
        message: `An image result has only type, mediaType, data and text; "${key}" is not one of them`,
      };
    }
  }
  const { mediaType, data, text } = result;
  if (
    typeof mediaType !== 'string' ||
    !(HOST_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)
  ) {
    return {
      param: 'result.mediaType',
      message: `mediaType must be one of ${HOST_IMAGE_MEDIA_TYPES.join(', ')}`,
    };
  }
  if (typeof data !== 'string' || data === '' || !BASE64.test(data)) {
    return {
      param: 'result.data',
      message: 'data must be the image in standard base64, with no data: prefix or whitespace',
    };
  }
  if (!signatureMatches(mediaType as HostImageMediaType, data)) {
    return { param: 'result.data', message: `data is not a ${mediaType} image` };
  }
  if (text !== undefined && (typeof text !== 'string' || text.length > HOST_IMAGE_TEXT_MAX_CHARS)) {
    return {
      param: 'result.text',
      message: `text must be a string of at most ${HOST_IMAGE_TEXT_MAX_CHARS} characters`,
    };
  }
  return null;
}

/**
 * The image result inside a host tool's output (`{ status, detail?, result }`), when it carries
 * one. Only answers that passed {@link hostImageResultProblem} at the route reach a tool, so this
 * reads the shape rather than judging it again.
 */
function imageOf(output: unknown): HostImageResult | null {
  if (!isRecord(output)) return null;
  const result = output.result;
  if (!claimsImage(result) || typeof result.data !== 'string') return null;
  return result as unknown as HostImageResult;
}

/** The output with its image's bytes left out, for what outlives the turn. */
export function withoutHostImageData<T>(output: T): T | Record<string, unknown> {
  const image = imageOf(output);
  if (image === null) return output;
  const placeholder: HostImagePlaceholder = {
    type: 'image',
    mediaType: image.mediaType,
    ...(image.text === undefined ? {} : { text: image.text }),
    omitted: true,
  };
  return { ...(output as Record<string, unknown>), result: placeholder };
}

/**
 * What the model reads for a host tool's output: an image result as the image itself, after a
 * text part carrying the rest of the answer (status, detail, caption); every other output exactly
 * as the AI SDK would have sent it without this function (a JSON value).
 */
export function hostToolModelOutput(output: unknown): ToolResultPart['output'] {
  const image = imageOf(output);
  if (image === null) {
    return typeof output === 'string'
      ? { type: 'text', value: output }
      : { type: 'json', value: (output ?? null) as never };
  }
  const { data: _bytes, ...described } = image;
  return {
    type: 'content',
    value: [
      {
        type: 'text',
        text: JSON.stringify({ ...(output as Record<string, unknown>), result: described }),
      },
      { type: 'image-data', data: image.data, mediaType: image.mediaType },
    ],
  };
}
