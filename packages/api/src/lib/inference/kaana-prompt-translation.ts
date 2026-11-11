/**
 * The AI SDK call, translated to the public Oxy inference request: prompt
 * messages, tool definitions and results (with the images tools return),
 * documents and the response format, plus the warnings for what the contract
 * cannot carry. Pure; fitting the result to a request's limits and sending it
 * are `kaana-language-model.ts`.
 */
import type {
  InferenceMessage,
  InferenceContentPart,
  ResponseFormat,
  ToolChoice,
  ToolDefinition,
} from '@oxy.so/contracts';
import type {
  SharedV3Warning,
  LanguageModelV3CallOptions,
  LanguageModelV3FilePart,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
} from '@ai-sdk/provider';

/**
 * The request, in the contract's shape, plus what could not be carried.
 *
 * The pieces travel together because a caller needs all of them: the request to
 * send and the warnings to attach to the answer. Returning only the first is how
 * a dropped image becomes invisible.
 */
export interface Translation {
  readonly messages: InferenceMessage[];
  /** The user messages that carry tool-result images, which the fit treats as tool results. */
  readonly toolImageMessages: ReadonlySet<InferenceMessage>;
  readonly tools: ToolDefinition[];
  readonly toolChoice?: ToolChoice;
  readonly warnings: SharedV3Warning[];
}

/** An image a tool returned (`image-data`, or `file-data` of an image type), base64. */
interface ToolResultImage {
  readonly mediaType: string;
  readonly data: string;
}

/** What a tool result's text says when its image is sent in the message after it. */
export const TOOL_IMAGE_FOLLOWS_NOTE = '[The image this call returned is in the next message.]';

/** What a tool result's text says once the step that returned its image is over. */
export const PAST_TOOL_IMAGE_NOTE =
  '[The image this call returned was shown in its own step and is not repeated; call the tool again to look again.]';

/**
 * A tool's output as the contract's tool message carries it: text, and the images it returned.
 *
 * The contract's message content is text, image, audio or file — it has no
 * `json` part, because a tool result is not a modality. Every provider dialect
 * resolves this the same way, by serialising, and doing it here rather than
 * further down keeps the choice visible: `JSON.stringify` is what the model
 * will actually read, so a result that stringifies to `{}` is a result the model
 * cannot use, and that is worth being able to see in one place.
 *
 * Images (an awaited host tool's screenshot, `lib/chat/host-image-result.ts`) are returned apart
 * from the text, because they cannot ride the tool message itself on every dialect: OpenAI-style
 * chat completions refuse an image outside a user message, and Kaana forwards a tool message's
 * parts as they are. {@link translatePrompt} decides where they go.
 *
 * `execution-denied` is rendered as a sentence rather than dropped. The model
 * asked for something and the answer is that it was refused; an empty result
 * would read as a tool that ran and returned nothing, which invites it to try
 * again.
 */
function toolResultText(output: LanguageModelV3ToolResultOutput): {
  readonly text: string;
  readonly images: readonly ToolResultImage[];
  readonly unsupported?: string;
} {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return { text: output.value, images: [] };
    case 'json':
    case 'error-json':
      return { text: JSON.stringify(output.value), images: [] };
    case 'execution-denied':
      return {
        text:
          output.reason === undefined
            ? 'The tool call was denied and did not run.'
            : `The tool call was denied and did not run: ${output.reason}`,
        images: [],
      };
    case 'content': {
      const texts: string[] = [];
      const images: ToolResultImage[] = [];
      let others = 0;
      for (const part of output.value) {
        if (part.type === 'text') texts.push(part.text);
        else if (
          part.type === 'image-data' ||
          (part.type === 'file-data' && part.mediaType.startsWith('image/'))
        ) {
          images.push({ mediaType: part.mediaType, data: part.data });
        } else others += 1;
      }
      return {
        text: texts.join('\n'),
        images,
        ...(others > 0 ? { unsupported: `${others} non-text part(s) of a tool result` } : {}),
      };
    }
  }
}

/**
 * An image as the contract carries it.
 *
 * It is SENT, never dropped: whether the model can see is the edge's call, and
 * it answers a model that cannot with a typed `unsupported_modality`, which
 * reaches the person as an error they can act on (pick a model that sees)
 * rather than as an answer about a picture the model never received.
 */
function imagePart(
  part: LanguageModelV3FilePart & { data: string | Uint8Array },
): InferenceContentPart {
  return {
    type: 'image',
    source: {
      kind: 'inline',
      mediaType: part.mediaType,
      data: typeof part.data === 'string' ? part.data : Buffer.from(part.data).toString('base64'),
    },
  };
}

/** A document as the contract carries it: inline base64, or the URL it lives at. */
function documentPart(part: LanguageModelV3FilePart): InferenceContentPart {
  const source =
    part.data instanceof URL
      ? { kind: 'url' as const, url: part.data.href }
      : {
          kind: 'inline' as const,
          mediaType: part.mediaType,
          data:
            typeof part.data === 'string' ? part.data : Buffer.from(part.data).toString('base64'),
        };
  return {
    type: 'file',
    source,
    ...(part.filename === undefined ? {} : { filename: part.filename.slice(0, 255) }),
  };
}

/**
 * The prompt, message by message.
 *
 * Two structural mismatches are resolved here, and both are the kind that would
 * otherwise be discovered as a model that ignores its tools:
 *
 *  - The AI SDK carries an assistant's tool calls as CONTENT PARTS; the contract
 *    carries them as a field on the message (`toolCalls`), OpenAI-style. An
 *    assistant turn that only calls tools therefore becomes a message with empty
 *    content and a populated `toolCalls`, which the contract's own schema
 *    accepts — verified against it rather than assumed.
 *  - The AI SDK groups SEVERAL tool results into one `tool` message; the
 *    contract's `toolCallId` is per-message and required on exactly that role.
 *    So one SDK message becomes one contract message per result. Folding them
 *    into a single message would need one `toolCallId` for several answers, and
 *    the schema rejects the message that omits it — correctly, since the model
 *    would have no way to tell which answer belongs to which call.
 *
 * A third is a choice. Images a tool returned (a host's screenshot) go in ONE
 * user message right after the step's tool messages, each labelled with its
 * call, while each tool message says the image follows: an image in a tool
 * message is refused by OpenAI-style chat completions, and a user message
 * carries one on every dialect that sees. Only the step the prompt ends with
 * sends its images. An earlier step's result keeps its text and says its image
 * is not repeated, so a sixteen-step browsing turn sends one screenshot per
 * request rather than all of them, and the model, having already looked, takes
 * a new one when it needs to. The image message is returned in
 * `toolImageMessages`, so the request fit (`request-budget.ts`) shrinks it as
 * a tool result rather than protecting it as the person's latest message.
 */
function translatePrompt(
  prompt: LanguageModelV3Prompt,
  warn: (message: string) => void,
): { messages: InferenceMessage[]; toolImageMessages: Set<InferenceMessage> } {
  const messages: InferenceMessage[] = [];
  const toolImageMessages = new Set<InferenceMessage>();
  /** The images of the step the prompt ends with, sent after its tool messages. */
  const latestImages: Array<{ toolCallId: string; toolName: string; image: ToolResultImage }> = [];
  const latestStep = prompt.length - 1;

  const textOf = (
    parts: readonly { readonly type: string; readonly text?: string }[],
  ): InferenceContentPart[] =>
    parts.flatMap((part) => {
      if (part.type === 'text' && part.text !== undefined) {
        return [{ type: 'text' as const, text: part.text }];
      }
      warn(
        `Kaana serves text today; a ${part.type} part was not sent rather than silently dropped.`,
      );
      return [];
    });

  const pushToolResult = (
    part: {
      readonly toolCallId: string;
      readonly toolName: string;
      readonly output: LanguageModelV3ToolResultOutput;
    },
    inLatestStep: boolean,
  ): void => {
    const rendered = toolResultText(part.output);
    if (rendered.unsupported !== undefined) {
      warn(
        `Kaana serves text today; ${rendered.unsupported} was not sent rather than silently dropped.`,
      );
    }
    let text = rendered.text;
    if (rendered.images.length > 0) {
      text = `${text}\n${inLatestStep ? TOOL_IMAGE_FOLLOWS_NOTE : PAST_TOOL_IMAGE_NOTE}`;
      if (inLatestStep) {
        for (const image of rendered.images) {
          latestImages.push({ toolCallId: part.toolCallId, toolName: part.toolName, image });
        }
      }
    }
    messages.push({
      role: 'tool',
      content: [{ type: 'text', text }],
      toolCallId: part.toolCallId,
    });
  };

  for (const [index, message] of prompt.entries()) {
    switch (message.role) {
      case 'system':
        // The one role whose content is a bare string in this interface.
        messages.push({ role: 'system', content: [{ type: 'text', text: message.content }] });
        break;

      case 'user':
        messages.push({
          role: 'user',
          content: message.content.flatMap((part) => {
            if (part.type !== 'file') return textOf([part]);
            if (!part.mediaType.startsWith('image/')) return [documentPart(part)];
            if (part.data instanceof URL) {
              warn('An image by URL was not sent: Oxy and Kaana take images inline only.');
              return [];
            }
            return [imagePart({ ...part, data: part.data })];
          }),
        });
        break;

      case 'assistant': {
        const content: InferenceContentPart[] = [];
        const toolCalls: { id: string; name: string; arguments: string }[] = [];
        const nested: {
          toolCallId: string;
          toolName: string;
          output: LanguageModelV3ToolResultOutput;
        }[] = [];
        for (const part of message.content) {
          if (part.type === 'text') {
            content.push({ type: 'text', text: part.text });
          } else if (part.type === 'tool-call') {
            // `input` is asymmetric across this interface on purpose: on a
            // PROMPT part it is the parsed value (`unknown`), while on a
            // RESPONSE it is the stringified JSON. The contract carries the
            // string, which is what every provider sends, so this serialises —
            // as the AI SDK's own providers do at the same seam.
            toolCalls.push({
              id: part.toolCallId,
              name: part.toolName,
              arguments: JSON.stringify(part.input) ?? '{}',
            });
          } else if (part.type === 'tool-result') {
            // A provider-executed tool answered inside the assistant turn. It is
            // still an answer to a call, so it becomes the message the contract
            // has for one — held back until the assistant turn it belongs to has
            // been pushed, because a result cannot precede its call.
            nested.push(part);
          } else if (part.type === 'reasoning') {
            // Not sent, and not warned about. Reasoning is an OUTPUT; no dialect
            // accepts a previous turn's thinking back as input, so carrying it
            // would be an error and warning about it would be noise on every
            // single turn of a reasoning model.
          } else {
            warn(
              `Kaana serves text today; a ${part.type} part was not sent rather than silently dropped.`,
            );
          }
        }
        messages.push({
          role: 'assistant',
          content,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        });
        for (const result of nested) pushToolResult(result, false);
        break;
      }

      case 'tool':
        for (const part of message.content) {
          if (part.type === 'tool-result') {
            pushToolResult(part, index === latestStep);
          } else {
            // A tool-approval response. Kaana has no approval protocol, so
            // pretending it was delivered would be worse than saying it was not.
            warn(`Kaana has no tool-approval protocol; a ${part.type} part was not sent.`);
          }
        }
        break;
    }
  }

  if (latestImages.length > 0) {
    const imageMessage: InferenceMessage = {
      role: 'user',
      content: latestImages.flatMap(({ toolCallId, toolName, image }) => [
        { type: 'text' as const, text: `The image ${toolName} returned (call ${toolCallId}):` },
        {
          type: 'image' as const,
          source: { kind: 'inline' as const, mediaType: image.mediaType, data: image.data },
        },
      ]),
    };
    messages.push(imageMessage);
    toolImageMessages.add(imageMessage);
  }

  return { messages, toolImageMessages };
}

/**
 * A tool's parameter schema as it goes on the wire.
 *
 * The AI SDK stamps every schema with `$schema` (the JSON-Schema dialect). No
 * provider needs it, and it is re-sent in every tool of every request.
 */
export function wireToolParameters(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = schema;
  return rest;
}

/**
 * Tool definitions and the choice, in the contract's vocabulary.
 *
 * The AI SDK's `inputSchema` is JSON Schema and the contract's `parameters` is
 * JSON Schema, so the schema itself passes through untouched — the difference is
 * only in the field name. A PROVIDER-DEFINED tool has no schema to pass and no
 * meaning outside the provider that defines it, so it is refused with a warning
 * rather than sent as a function the model would then try to call.
 */
function translateTools(
  call: LanguageModelV3CallOptions,
  warn: (message: string) => void,
): { tools: ToolDefinition[]; toolChoice?: ToolChoice } {
  const tools: ToolDefinition[] = [];
  for (const tool of call.tools ?? []) {
    if (tool.type !== 'function') {
      warn(
        `Kaana routes across providers, so the provider-defined tool "${tool.name}" was not sent.`,
      );
      continue;
    }
    tools.push({
      type: 'function',
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: wireToolParameters(tool.inputSchema as Record<string, unknown>),
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    });
  }

  const choice = call.toolChoice;
  if (choice === undefined) return { tools };
  if (choice.type === 'tool') {
    return { tools, toolChoice: { type: 'function', name: choice.toolName } };
  }
  return { tools, toolChoice: choice.type };
}

/**
 * The AI SDK's response format, in the contract's vocabulary.
 *
 * `generateObject` asks for a shape through this field and through nothing
 * else. Dropping it is not a smaller request, it is a different one: the model
 * is then free to answer in prose, the schema is checked only after the answer
 * has been paid for, and the caller discovers the mismatch by catching. Three
 * modules in this repository already call `generateObject` against a model this
 * factory returns, so the field was being lost on every one of them.
 *
 * `strict: false`, and the contract requires an answer rather than allowing
 * silence. The AI SDK carries no strict flag, and the schemas it derives from
 * Zod have optional properties — the OpenAI dialect's strict mode requires
 * every property to be listed as required, so `true` would have upstreams
 * refuse exactly the schemas this exists to send.
 */
export function toResponseFormat(
  format: LanguageModelV3CallOptions['responseFormat'],
): ResponseFormat | undefined {
  if (format === undefined || format.type === 'text') return undefined;
  // Asking for JSON without saying which JSON. The contract keeps the two
  // apart because a model can be able to answer in valid JSON without being
  // able to honour a schema, and collapsing them would ask for the stricter
  // thing on every call that wanted the looser one.
  if (format.schema === undefined) return { type: 'json_object' };
  return {
    type: 'json_schema',
    // The contract requires a name and the AI SDK treats it as optional, so
    // this is the one value invented here. It names the OUTPUT, which is what
    // the field means in every dialect that carries it.
    name: format.name ?? 'response',
    schema: format.schema as Record<string, unknown>,
    strict: false,
  };
}

export function translate(call: LanguageModelV3CallOptions): Translation {
  const warnings: SharedV3Warning[] = [];
  const warn = (message: string): void => {
    warnings.push({ type: 'other', message });
  };
  const { messages, toolImageMessages } = translatePrompt(call.prompt, warn);
  const { tools, toolChoice } = translateTools(call, warn);
  return {
    messages,
    toolImageMessages,
    tools,
    ...(toolChoice === undefined ? {} : { toolChoice }),
    warnings,
  };
}
