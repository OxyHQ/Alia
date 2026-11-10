/**
 * Tool-call markup a model wrote as TEXT, and the guard that keeps it from the person.
 *
 * Some models, on some hosts, write a tool call in their own native syntax into the message
 * instead of the structured tool-call part: DeepSeek's `<｜DSML｜invoke name="…">` blocks, a
 * `<function(name)>{json}</function>` tag, a `<tool_call>` block. It is not an answer: shown, it
 * is gibberish, and stored, it poisons the thread. The normal fix is the provider adapter parsing
 * it (Kaana's); until a host does, nothing of it may reach a client or the stored message.
 *
 * {@link createToolMarkupGuard} sits in front of every streamed text delta. It lets text through
 * until a marker begins (holding back a tail that might be the start of one, since a chunk can
 * split a marker anywhere) and from then on keeps everything for the post-stream fallback
 * (`text-tool-fallback.ts`), which runs the calls it can read and drops the rest.
 */

/** What starts a tool call written as text, in every spelling seen. */
const MARKERS = ['<｜DSML｜', '<|DSML|', '<｜tool▁call', '<function(', '<tool_call>'] as const;

export interface ToolMarkupGuard {
  /** The part of `chunk` that may be shown: nothing once markup has begun. */
  push(chunk: string): string;
  /** The end of the stream: a held tail that never became a marker is plain text after all. */
  flush(): string;
  /** Everything from the first marker on, for the fallback. Empty when no markup was written. */
  readonly withheld: string;
  /** Hands over what was withheld and starts clean, so the next step of a turn can speak. */
  take(): string;
}

/** The length of the longest suffix of `text` that is a proper prefix of some marker. */
function partialMarkerLength(text: string): number {
  let longest = 0;
  for (const marker of MARKERS) {
    const max = Math.min(marker.length - 1, text.length);
    for (let length = max; length > longest; length--) {
      if (marker.startsWith(text.slice(text.length - length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

export function createToolMarkupGuard(): ToolMarkupGuard {
  let pending = '';
  let withheld = '';
  let tripped = false;
  return {
    push(chunk) {
      if (tripped) {
        withheld += chunk;
        return '';
      }
      const text = pending + chunk;
      let start = -1;
      for (const marker of MARKERS) {
        const at = text.indexOf(marker);
        if (at !== -1 && (start === -1 || at < start)) start = at;
      }
      if (start !== -1) {
        tripped = true;
        pending = '';
        withheld = text.slice(start);
        return text.slice(0, start);
      }
      const held = partialMarkerLength(text);
      pending = text.slice(text.length - held);
      return text.slice(0, text.length - held);
    },
    flush() {
      if (tripped) return '';
      const rest = pending;
      pending = '';
      return rest;
    },
    get withheld() {
      return withheld;
    },
    take() {
      const taken = withheld;
      withheld = '';
      pending = '';
      tripped = false;
      return taken;
    },
  };
}

export interface TextToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

const BAR = '[｜|]';
const DSML_INVOKE = new RegExp(
  `<${BAR}DSML${BAR}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)</${BAR}DSML${BAR}invoke>`,
  'g',
);
const DSML_PARAMETER = new RegExp(
  `<${BAR}DSML${BAR}parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)</${BAR}DSML${BAR}parameter>`,
  'g',
);
/** Every DSML tag, opening or closing, whole blocks or not. */
const DSML_ANY_TAG = new RegExp(`</?${BAR}DSML${BAR}[^>]*>`, 'g');

/** A parameter's value: `string="true"` is the text as written, anything else is JSON. */
function parameterValue(raw: string, isString: string | undefined): unknown {
  if (isString === 'true') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * The calls written in DeepSeek's DSML syntax. An `invoke` block that never closed (a stream cut
 * mid-call) is not a call and is not returned.
 */
export function parseDsmlToolCalls(text: string): TextToolCall[] {
  const calls: TextToolCall[] = [];
  for (const invoke of text.matchAll(DSML_INVOKE)) {
    const args: Record<string, unknown> = {};
    for (const parameter of invoke[2]!.matchAll(DSML_PARAMETER))
      args[parameter[1]!] = parameterValue(parameter[3]!, parameter[2]);
    calls.push({ name: invoke[1]!, args });
  }
  return calls;
}

/** `text` without DSML calls (closed or not): what is left, if anything, is the model's own words. */
export function stripDsmlToolMarkup(text: string): string {
  const closed = text.replace(DSML_INVOKE, '');
  const start = closed.search(new RegExp(`<${BAR}DSML${BAR}`));
  const kept = start === -1 ? closed : closed.slice(0, start);
  return kept.replace(DSML_ANY_TAG, '').trim();
}

/** A whole message without the tool call written in it (the non-streaming path's one-shot guard). */
export function withoutToolMarkup(text: string): string {
  const guard = createToolMarkupGuard();
  return guard.push(text) + guard.flush();
}
