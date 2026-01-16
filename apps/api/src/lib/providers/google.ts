import type { KeyConfig, OpenAIMessage, OpenAITool, Provider, ProviderConfig } from '../types';

// ============== GEMINI (Google) ==============
export const googleProvider: Provider = {
  name: 'Google Gemini',
  
  isEnabled: () => true,

  async proxy(key: KeyConfig, messages: OpenAIMessage[], tools?: OpenAITool[], config?: ProviderConfig): Promise<ReadableStream> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${key.modelId}:streamGenerateContent?alt=sse&key=${key.key}`;

    // Convertir mensajes OpenAI -> Gemini
    let systemText = '';
    const contents: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemText += (msg.content || '') + '\n';
      } 
      else if (msg.role === 'user') {
        const parts: any[] = [];
        if (typeof msg.content === 'string') {
          parts.push({ text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const c of msg.content) {
            if (c.type === 'text') parts.push({ text: c.text });
          }
        }
        if (parts.length) contents.push({ role: 'user', parts });
      }
      else if (msg.role === 'assistant') {
        const parts: any[] = [];
        if (msg.content) parts.push({ text: msg.content as string });
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let args = {};
            try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
            parts.push({ functionCall: { name: tc.function?.name, args } });
          }
        }
        if (parts.length) contents.push({ role: 'model', parts });
      }
      else if (msg.role === 'tool') {
        let response: any = msg.content;
        try { response = JSON.parse(msg.content as string); } catch { response = { result: msg.content }; }
        contents.push({ role: 'user', parts: [{ functionResponse: { name: msg.name || 'unknown', response } }] });
      }
    }

    // Convertir tools - filter out invalid tools
    const validTools = tools?.filter(t => t && t.function && t.function.name) || [];
    const geminiTools = validTools.length > 0 ? [{
      functionDeclarations: validTools.map(t => ({
        name: t.function.name,
        description: t.function.description || '',
        parameters: t.function.parameters || { type: 'object', properties: {} }
      }))
    }] : undefined;

    const body: any = {
      contents,
      generationConfig: {
        temperature: config?.temperature ?? 0.7,
        maxOutputTokens: config?.maxTokens ?? 8192
      }
    };

    if (systemText.trim()) {
      body.systemInstruction = { parts: [{ text: systemText.trim() }] };
    }
    if (geminiTools) body.tools = geminiTools;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      throw new Error(`Gemini ${res.status}: ${await res.text()}`);
    }

    return transformGeminiStream(res.body!, key.modelId);
  }
};

// Transforma stream de Gemini a formato OpenAI
function transformGeminiStream(body: ReadableStream<Uint8Array>, modelId: string): ReadableStream {
  const reader = body.getReader();
  const encoder = new TextEncoder();
  let toolIdx = 0;

  return new ReadableStream({
    async start(controller) {
      const decoder = new TextDecoder();
      let buffer = '';
      let isFirst = true;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const d = line.slice(6).trim();
            if (d === '[DONE]') continue;

            try {
              const data = JSON.parse(d);
              const parts = data.candidates?.[0]?.content?.parts;
              if (!parts) continue;

              for (const part of parts) {
                // Texto
                if (part.text) {
                  const chunk = {
                    id: 'chatcmpl-' + Date.now(),
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: modelId,
                    choices: [{
                      index: 0,
                      delta: isFirst ? { role: 'assistant', content: part.text } : { content: part.text },
                      finish_reason: null
                    }]
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  isFirst = false;
                }

                // Function call
                if (part.functionCall) {
                  const id = `call_${Date.now()}_${toolIdx}`;
                  const args = JSON.stringify(part.functionCall.args || {});

                  // Chunk con nombre
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                    id: 'chatcmpl-' + Date.now(),
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: modelId,
                    choices: [{
                      index: 0,
                      delta: {
                        tool_calls: [{
                          index: toolIdx,
                          id,
                          type: 'function',
                          function: { name: part.functionCall.name, arguments: '' }
                        }]
                      },
                      finish_reason: null
                    }]
                  })}\n\n`));

                  // Chunk con args
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                    id: 'chatcmpl-' + Date.now(),
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: modelId,
                    choices: [{
                      index: 0,
                      delta: {
                        tool_calls: [{
                          index: toolIdx,
                          function: { arguments: args }
                        }]
                      },
                      finish_reason: null
                    }]
                  })}\n\n`));

                  toolIdx++;
                  isFirst = false;
                }
              }
            } catch {}
          }
        }

        // Chunk final
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          id: 'chatcmpl-' + Date.now(),
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: toolIdx > 0 ? 'tool_calls' : 'stop'
          }]
        })}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    }
  });
}
