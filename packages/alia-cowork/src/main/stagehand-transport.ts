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
  // The public AISdkClient export handles act/extract but does not expose
  // the optional model getter used by Stagehand's agent runner.
  class AliaStagehandClient extends AISdkClient {
    getLanguageModel() {
      return model;
    }
  }
  return new AliaStagehandClient({ model });
}
