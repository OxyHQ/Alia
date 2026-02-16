# Alia AI - Developer API Documentation

## 🎯 Overview

Alia AI provides a unified API for accessing multiple AI models through a single interface. All requests use the Alia model namespace - you never need to worry about which underlying provider is being used.

**Base URL:** `https://api.alia.com` (or your deployment URL)

**Authentication:** Bearer token or API key

## 🔑 Authentication

```bash
# Using Bearer token (for logged-in users)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" https://api.alia.com/api/v1/models

# Using API key (for programmatic access)
curl -H "Authorization: Bearer YOUR_API_KEY" https://api.alia.com/api/v1/chat/completions
```

## 📚 Available Endpoints

### 1. List Available Models

Get models available for your application type.

```
GET /api/v1/models?app={app_type}
```

**Query Parameters:**
- `app` (required): Application type - `main`, `codea`, `cowork`, or `browser`
- `category` (optional): Filter by category - `general` or `coding`

**Response:**
```json
{
  "models": [
    {
      "id": "alia-lite",
      "name": "Alia Lite",
      "description": "Fast responses for simple tasks",
      "tier": "lite",
      "category": "general",
      "creditMultiplier": 0.5,
      "maxTokens": 4096,
      "supportsTools": true,
      "supportsVision": false
    },
    {
      "id": "alia-v1",
      "name": "Alia V1",
      "description": "Balanced performance for everyday tasks",
      "tier": "v1",
      "category": "general",
      "creditMultiplier": 1.0,
      "maxTokens": 8192,
      "supportsTools": true,
      "supportsVision": true
    }
  ],
  "app": "main",
  "count": 2
}
```

**Model Filtering by App:**

- **Main App** (`app=main`): General models + multimodal (vision, audio, voice)
  - Available: `alia-lite`, `alia-v1`, `alia-v1-vision`, `alia-v1-audio`, `alia-v1-multimodal`, `alia-v1-pro`, `alia-v1-pro-max`, `alia-v1-thinking`, `alia-v1-voice`, `alia-v1-voice-pro`

- **Codea** (`app=codea`): Coding-specialized models
  - Available: `alia-v1-codea`, `alia-v1-pro`, `alia-v1-thinking`

- **Cowork** (`app=cowork`): Desktop automation models
  - Available: `alia-v1-cowork`, `alia-v1-vision`, `alia-v1-pro`

- **Browser** (`app=browser`): Browser automation only
  - Available: `alia-v1-browser`

**Example (JavaScript):**
```javascript
async function getModels(appType) {
  const response = await fetch(`/api/v1/models?app=${appType}`, {
    headers: {
      'Authorization': `Bearer ${API_KEY}`
    }
  });

  const data = await response.json();
  return data.models;
}

// Usage
const models = await getModels('main');
console.log(models.map(m => m.id));
// Output: ['alia-lite', 'alia-v1', 'alia-v1-vision', ...]
```

**Example (Python):**
```python
import requests

def get_models(app_type: str):
    response = requests.get(
        f"https://api.alia.com/api/v1/models?app={app_type}",
        headers={"Authorization": f"Bearer {API_KEY}"}
    )
    return response.json()["models"]

models = get_models("codea")
print([m["id"] for m in models])
# Output: ['alia-v1-codea', 'alia-v1-pro', 'alia-v1-thinking']
```

### 2. Get Model Details

Get detailed information about a specific model.

```
GET /api/v1/models/{model_id}
```

**Response:**
```json
{
  "model": {
    "id": "alia-v1-pro",
    "name": "Alia Pro",
    "description": "Advanced reasoning for complex tasks",
    "tier": "v1-pro",
    "category": "coding",
    "creditMultiplier": 3.0,
    "maxTokens": 32768,
    "supportsTools": true,
    "supportsVision": true
  }
}
```

### 3. Chat Completions (Standard)

Send messages to an Alia model and get a complete response.

```
POST /api/v1/chat/completions
```

**Request Body:**
```json
{
  "model": "alia-v1",
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant."
    },
    {
      "role": "user",
      "content": "What is the capital of France?"
    }
  ],
  "temperature": 0.7,
  "max_tokens": 1000,
  "stream": false
}
```

**Response:**
```json
{
  "id": "chatcmpl-123456",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "alia-v1",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The capital of France is Paris."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 8,
    "total_tokens": 23
  },
  "cost": 0.000023,
  "cached": false
}
```

**Example (Node.js - OpenAI SDK) - Recommended:**
```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: 'alia_sk_your_key',
  baseURL: 'https://api.alia.onl/v1',
});

// Streaming
const stream = await openai.chat.completions.create({
  model: 'alia-v1',
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true,
});

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content;
  if (content) process.stdout.write(content);
}

// Non-streaming
const response = await openai.chat.completions.create({
  model: 'alia-v1',
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(response.choices[0].message.content);
```

**Example (JavaScript - Fetch API):**
```javascript
async function chat(messages, model = 'alia-v1') {
  const response = await fetch('https://api.alia.onl/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false
    })
  });

  return await response.json();
}

// Usage
const result = await chat([
  { role: 'user', content: 'Hello!' }
]);
console.log(result.choices[0].message.content);
```

**Example (Vercel AI SDK v5+):**

```typescript
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';

const alia = createOpenAI({
  apiKey: 'alia_sk_your_key',
  baseURL: 'https://api.alia.onl/v1',
});

const result = await streamText({
  model: alia('alia-v1'),
  messages: [{ role: 'user', content: 'Hello!' }],
});

for await (const chunk of result.textStream) {
  console.log(chunk);
}
```

> ✅ Both `/v1/chat/completions` and `/v1/responses` endpoints are supported. Works out of the box with Vercel AI SDK.

### 4. Chat Completions (Streaming with SSE)

Stream responses in real-time using Server-Sent Events. The stream uses **standard OpenAI-compatible format** — any OpenAI SDK or compatible client works out of the box.

```
POST /api/v1/chat/completions
Content-Type: application/json

{
  "model": "alia-v1",
  "messages": [...],
  "stream": true
}
```

**Wire Format:**

The response is a stream of `data:` lines, each containing a JSON chunk. The stream ends with `data: [DONE]`.

```
: keep-alive

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1234567890,"model":"alia-v1","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1234567890,"model":"alia-v1","choices":[{"index":0,"delta":{"content":"The"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1234567890,"model":"alia-v1","choices":[{"index":0,"delta":{"content":" capital"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1234567890,"model":"alia-v1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

> The initial `: keep-alive` comment is sent immediately before any processing begins. This prevents reverse-proxy first-byte timeouts (e.g., DigitalOcean's 60s limit) on longer requests.

**Chunk Shape:**

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion.chunk",
  "created": 1234567890,
  "model": "alia-v1",
  "choices": [{
    "index": 0,
    "delta": {
      "content": "text...",
      "reasoning": "thinking...",
      "tool_calls": [{ "id": "call_...", "type": "function", "function": { "name": "...", "arguments": "..." } }]
    },
    "finish_reason": null
  }]
}
```

- `delta.content` — text token (most common)
- `delta.reasoning` — chain-of-thought token (thinking models only)
- `delta.tool_calls` — tool call chunks (when tools are enabled)
- `finish_reason` — `null` during streaming, `"stop"` on final chunk

**Error Events:**

If an error occurs mid-stream, it's sent as a data line before the stream closes:

```
data: {"error":{"message":"All providers exhausted","code":"SERVICE_UNAVAILABLE"}}

data: [DONE]
```

> **Recommended:** Use the OpenAI SDK or Vercel AI SDK (shown in section 3 above) — they handle SSE parsing, buffering, and error handling automatically. The manual examples below are for custom implementations.

**Example (JavaScript - Manual Fetch):**
```javascript
async function chatStreaming(messages, model = 'alia-v1', onToken) {
  const response = await fetch('/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({ model, messages, stream: true })
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;

      const chunk = JSON.parse(line.slice(6));
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) onToken(content);
    }
  }
}

// Usage
let fullResponse = '';
await chatStreaming(
  [{ role: 'user', content: 'Tell me a story' }],
  'alia-v1',
  (token) => {
    fullResponse += token;
    process.stdout.write(token);
  }
);
console.log('\nFull response:', fullResponse);
```

**Example (React Hook):**
```typescript
import { useState, useCallback } from 'react';

function useAliaChat() {
  const [response, setResponse] = useState('');
  const [loading, setLoading] = useState(false);

  const sendMessage = useCallback(async (messages, model = 'alia-v1') => {
    setResponse('');
    setLoading(true);

    const res = await fetch('/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({ model, messages, stream: true })
    });

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;

        const chunk = JSON.parse(line.slice(6));
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) {
          setResponse(prev => prev + content);
        }
      }
    }

    setLoading(false);
  }, []);

  return { response, loading, sendMessage };
}

// Usage in component
function Chat() {
  const { response, loading, sendMessage } = useAliaChat();

  return (
    <div>
      <div>{response}</div>
      {loading && <div>Thinking...</div>}
      <button onClick={() => sendMessage([{ role: 'user', content: 'Hello!' }])}>
        Send
      </button>
    </div>
  );
}
```

### 5. User Dashboard

Get cost and usage statistics for the current user.

```
GET /api/user/dashboard
```

**Response:**
```json
{
  "summary": {
    "userId": "user_123",
    "totalSpent": 5.23,
    "totalTokens": 1250000,
    "totalRequests": 342,
    "costByModel": {
      "alia-v1": 2.10,
      "alia-v1-pro": 3.13
    },
    "tokensByModel": {
      "alia-v1": 750000,
      "alia-v1-pro": 500000
    },
    "avgCostPerRequest": 0.0153,
    "estimatedMonthlyCost": 15.69,
    "cacheSavings": 1.50,
    "freeTierSavings": 8.75
  },
  "recommendations": [
    "✅ Great! Cache hits saved you $1.50 this period.",
    "🎉 Excellent! Free tier usage saved you $8.75 compared to paid-only models."
  ],
  "recentActivity": [
    {
      "model": "alia-v1-pro",
      "tokens": 1234,
      "cost": 0.0123,
      "timestamp": "2026-01-27T10:30:00.000Z",
      "cached": false
    }
  ]
}
```

## 🎨 Model Selection Guide

### By Use Case:

**General Chat & Q&A:**
- `alia-lite` - Fast, economical
- `alia-v1` - Balanced quality/cost
- `alia-v1-pro` - High quality

**Coding:**
- `alia-v1-codea` - Fast code generation
- `alia-v1-pro` - Complex algorithms
- `alia-v1-thinking` - Deep reasoning

**Vision & Images:**
- `alia-v1-vision` - Image analysis
- `alia-v1-multimodal` - Images + text + audio

**Audio:**
- `alia-v1-audio` - Transcription, speech-to-text

**Voice (Real-time):**
- `alia-v1-voice` - Real-time voice conversations
- `alia-v1-voice-pro` - Premium voice with extended context

**Desktop Automation (Cowork):**
- `alia-v1-cowork` - Desktop control
- `alia-v1-vision` - Screen understanding

**Browser Automation:**
- `alia-v1-browser` - Web interactions

### Cost Optimization:

1. **Use caching**: Repeated queries are free!
2. **Choose appropriate tier**: Don't use Pro for simple tasks
3. **Monitor dashboard**: Track spending and follow recommendations
4. **Enable auto-caching**: Saves 70-80% on repeated patterns

## 🔒 Security & Best Practices

### 1. Never Hardcode API Keys
```javascript
// ❌ BAD
const API_KEY = 'sk_live_123456789';

// ✅ GOOD
const API_KEY = process.env.ALIA_API_KEY;
```

### 2. Handle Errors Gracefully
```javascript
async function sendMessage(messages) {
  try {
    const response = await fetch('/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'alia-v1', messages })
    });

    if (!response.ok) {
      const error = await response.json();

      // Check if retryable
      if (error.error.retryable) {
        // Wait and retry
        await new Promise(r => setTimeout(r, error.error.retryAfter * 1000));
        return sendMessage(messages); // Retry
      } else {
        // Show error to user
        showError(error.error.message);
      }
    }

    return await response.json();
  } catch (networkError) {
    showError('Connection error. Please check your internet.');
  }
}
```

### 3. Implement Rate Limiting Client-Side
```javascript
class AliaClient {
  constructor(apiKey, rateLimit = 100) {
    this.apiKey = apiKey;
    this.requestCount = 0;
    this.rateLimitPerMinute = rateLimit;

    setInterval(() => {
      this.requestCount = 0; // Reset every minute
    }, 60000);
  }

  async chat(messages, model = 'alia-v1') {
    if (this.requestCount >= this.rateLimitPerMinute) {
      throw new Error('Rate limit exceeded. Please wait.');
    }

    this.requestCount++;

    return fetch('/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model, messages })
    });
  }
}
```

### 4. Sanitize User Input
```javascript
function sanitizeMessage(content) {
  // Remove potential injection attempts
  return content
    .replace(/<script[^>]*>.*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

const userInput = sanitizeMessage(getUserInput());
await chat([{ role: 'user', content: userInput }]);
```

## ⚠️ Important Notes

### Model Names
- **Always use Alia model names** (`alia-v1`, `alia-v1-pro`, etc.)
- You will never see underlying provider names (OpenAI, Google, etc.)
- This is intentional - Alia handles provider routing automatically

### Error Messages
- All errors use generic Alia branding
- Example: "Alia is temporarily unavailable" (not "OpenAI rate limit exceeded")
- This provides a consistent user experience

### Caching
- Identical requests are automatically cached
- Cache hits are free and instant
- Cache duration: 1 hour (configurable)

### Costs
- Shown in USD
- Calculated per-token
- Includes savings tracking (cache + free tier)

## 📊 Rate Limits

| User Tier | alia-lite | alia-v1 | alia-v1-pro | alia-v1-pro-max |
|-----------|-----------|---------|-------------|-----------------|
| Free      | 200/day   | 100/day | 20/day      | 5/day           |
| Pro       | 1000/day  | 500/day | 200/day     | 50/day          |
| Enterprise| Unlimited | Unlimited | Unlimited  | Unlimited       |

## 🐛 Common Errors

### `RATE_LIMIT_EXCEEDED`
```json
{
  "code": "RATE_LIMIT_EXCEEDED",
  "message": "You've made too many requests. Please wait a moment.",
  "retryable": true,
  "retryAfter": 60
}
```
**Solution:** Wait `retryAfter` seconds and retry.

### `SERVICE_UNAVAILABLE`
```json
{
  "code": "SERVICE_UNAVAILABLE",
  "message": "Alia is temporarily unavailable. We're working on it!",
  "retryable": true,
  "retryAfter": 30
}
```
**Solution:** Automatic fallback to backup model. Retry after delay.

### `INVALID_MODEL`
```json
{
  "code": "INVALID_MODEL",
  "message": "The specified Alia model is not available.",
  "retryable": false
}
```
**Solution:** Check available models with `GET /api/v1/models`.

### `CONTEXT_LENGTH_EXCEEDED`
```json
{
  "code": "CONTEXT_LENGTH_EXCEEDED",
  "message": "Your message is too long. Please shorten it.",
  "retryable": false
}
```
**Solution:** Split message into smaller parts or use a Pro model with larger context.

## 🎓 Examples

See our [GitHub repository](https://github.com/alia-ai/examples) for complete examples in:
- React
- Vue
- Python
- Node.js
- cURL

## 💬 Support

- Documentation: https://docs.alia.com
- Discord: https://discord.gg/alia-ai
- Email: support@alia.com

---

**Last Updated:** February 15, 2026
**API Version:** v1
**Status:** Production Ready
