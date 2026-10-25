import { AISdkClient } from '@browserbasehq/stagehand';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

/** Stagehand's public model adapter delegates all HTTP authority to Oxy. */
export function stagehandClientForTransport(
  transport: { fetch: typeof fetch },
  baseURL: string,
  modelId: string,
) {
  const provider = createOpenAICompatible({
    name: 'alia',
    baseURL: `${baseURL.replace(/\/$/, '')}/v1`,
    fetch: transport.fetch,
  });
  const model = provider.chatModel(modelId);
  // AISdkClient implements act/extract; its documented optional LLMClient
  // method also supplies the model to Stagehand's multi-step agent runner.
  class AliaStagehandClient extends AISdkClient {
    getLanguageModel() {
      return model;
    }
  }
  return new AliaStagehandClient({ model });
}
