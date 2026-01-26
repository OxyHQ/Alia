# Reasoning Standardization for Alia API

## Current Architecture

Your API currently:
- Proxies requests to multiple providers (Google, Anthropic, OpenAI, etc.)
- Streams back OpenAI-compatible chunks
- Clients only know about "alia-v1", "alia-v1-pro" model names

## Goal

Add standardized reasoning/chain-of-thought extraction so:
1. All providers' reasoning is exposed uniformly
2. Clients receive reasoning chunks in OpenAI-compatible format
3. No client-side provider detection needed

## Implementation Plan

### 1. Add AI SDK Reasoning Middleware

```typescript
import { extractReasoningMiddleware } from 'ai';

// In chat-completions.ts, wrap model with middleware:
const modelWithReasoning = resolved.provider === 'google'
  ? model.with({
      experimental_providerMetadata: {
        google: { includeThoughts: true }
      }
    })
  : model;

const wrappedModel = extractReasoningMiddleware({
  tagName: 'thinking', // Standard tag for all providers
  includeRawReasoning: false
})(modelWithReasoning);
```

### 2. Stream Reasoning Chunks

Add reasoning chunk handling to the streaming loop:

```typescript
for await (const chunk of result.fullStream) {
  if (chunk.type === 'text-delta') {
    // Regular content...
  } else if (chunk.type === 'reasoning-delta' || chunk.type === 'thought-delta') {
    // Send reasoning as separate chunk type
    const reasoningChunk = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: aliasModelId,
      choices: [{
        index: 0,
        delta: {
          reasoning: chunk.text || chunk.reasoningDelta,
          role: 'assistant'
        },
        finish_reason: null
      }]
    };
    res.write(`data: ${JSON.stringify(reasoningChunk)}\n\n`);
  }
  // ... tool-call handling
}
```

### 3. Provider-Specific Configuration

Different providers expose reasoning differently:

**Gemini/Google:**
```typescript
experimental_providerMetadata: {
  google: { includeThoughts: true }
}
```

**Anthropic:** Already includes `<thinking>` tags in text

**DeepSeek R1 (via Groq/Together):**
```typescript
extractReasoningMiddleware({
  tagName: 'think',
  startWithReasoning: true // R1 specific
})
```

### 4. Client Changes

Clients update to use `/v1/chat/completions` instead of `/v1/resolve-model`:

**Before (alia-cowork):**
```typescript
// Get provider key, connect directly
const resolved = await fetch('/v1/resolve-model', {...});
const model = createGoogleGenerativeAI(resolved.providerKey);
```

**After:**
```typescript
// Stream from alia.onl API
const response = await fetch('/v1/chat/completions', {
  method: 'POST',
  body: JSON.stringify({
    model: 'alia-v1-cowork',
    messages: [...],
    stream: true
  })
});
```

## Benefits

1. **Provider abstraction**: Users never know/care if they're using Gemini or Claude
2. **Unified reasoning**: All providers' chain-of-thought in same format
3. **Centralized control**: Add new providers without client changes
4. **Easier debugging**: All logic in one place
5. **Better caching**: Server-side caching benefits all clients

## Migration Path

1. Keep `/v1/resolve-model` for backward compatibility
2. Add reasoning to `/v1/chat/completions`
3. Update clients one by one to new endpoint
4. Eventually deprecate `/v1/resolve-model`

## References

- [AI SDK extractReasoningMiddleware](https://ai-sdk.dev/docs/reference/ai-sdk-core/extract-reasoning-middleware)
- [OpenAI Chat Completion Chunks](https://platform.openai.com/docs/api-reference/chat/streaming)
- [Gemini Thinking Mode](https://ai.google.dev/gemini-api/docs/thinking)
