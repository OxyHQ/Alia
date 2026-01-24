/**
 * Client for communicating with Alia API
 */

const API_BASE_URL = process.env.API_BASE_URL!;
const BOT_SECRET = process.env.MASTODON_BOT_SECRET!;

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatOptions {
  messages: ChatMessage[];
  model?: string;
  stream?: boolean;
}

/**
 * Call Alia chat API and stream the response
 */
export async function callAliaChat(options: ChatOptions): Promise<string> {
  const { messages, model = 'alia-lite', stream = true } = options;

  try {
    const response = await fetch(`${API_BASE_URL}/alia/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mastodon-Bot-Secret': BOT_SECRET,
        'X-Source': 'mastodon',
      },
      body: JSON.stringify({
        messages,
        model,
        stream,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${errorText}`);
    }

    if (!stream) {
      const data = await response.json();
      return data.content || data.text || '';
    }

    // Process streaming response
    return await processStreamingResponse(response);
  } catch (error: any) {
    console.error('[Alia API] Error calling chat API:', error);
    throw error;
  }
}

/**
 * Process Server-Sent Events streaming response
 */
async function processStreamingResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Response body is not readable');
  }

  const decoder = new TextDecoder();
  let fullResponse = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();

          if (dataStr === '[DONE]') {
            return fullResponse;
          }

          try {
            const data = JSON.parse(dataStr);

            // Handle different response formats
            if (data.type === 'text-delta' && data.text) {
              fullResponse += data.text;
            } else if (data.choices && data.choices[0]?.delta?.content) {
              fullResponse += data.choices[0].delta.content;
            } else if (data.content) {
              fullResponse += data.content;
            }
          } catch (e) {
            // Skip non-JSON lines or parsing errors
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return fullResponse;
}
