// Internal Alia Chat API - uses AI SDK natively for the frontend
// This is separate from /api/v1/chat/completions which is OpenAI-compatible for external clients

import { streamText, convertToModelMessages, UIMessage } from 'ai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { getBestAvailableKey, loadKeys } from '@/lib/load-balancer'
import type { KeyConfig } from '@/lib/types'

const keyPool = loadKeys()

// Create AI SDK provider based on key
function getAIModel(keyConfig: KeyConfig) {
  const apiKey = keyConfig.key
  const modelId = keyConfig.modelId
  
  switch (keyConfig.provider) {
    case 'google': {
      const google = createGoogleGenerativeAI({ apiKey })
      return google(modelId || 'gemini-2.5-flash')
    }
    case 'openai': {
      const openai = createOpenAI({ apiKey })
      return openai(modelId || 'gpt-4o-mini')
    }
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey })
      return anthropic(modelId || 'claude-sonnet-4-20250514')
    }
    case 'groq': {
      // Groq uses OpenAI-compatible API
      const groq = createOpenAI({ 
        apiKey,
        baseURL: 'https://api.groq.com/openai/v1'
      })
      return groq(modelId || 'llama-3.3-70b-versatile')
    }
    case 'together': {
      const together = createOpenAI({
        apiKey,
        baseURL: 'https://api.together.xyz/v1'
      })
      return together(modelId || 'meta-llama/Llama-3.3-70B-Instruct-Turbo')
    }
    case 'cerebras': {
      const cerebras = createOpenAI({
        apiKey,
        baseURL: 'https://api.cerebras.ai/v1'
      })
      return cerebras(modelId || 'llama-3.3-70b')
    }
    default:
      throw new Error(`Provider "${keyConfig.provider}" not supported for Alia chat`)
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { messages } = body as { messages: UIMessage[] }
    
    if (!messages || !messages.length) {
      return Response.json({ error: 'No messages provided' }, { status: 400 })
    }
    
    // Get best available key from pool
    const keyConfig = getBestAvailableKey(keyPool)
    if (!keyConfig) {
      return Response.json({ error: 'All providers are rate limited. Please try again later.' }, { status: 503 })
    }
    
    const keyPreview = keyConfig.key.slice(0, 8) + '...'
    console.log(`🔹 [Alia/Chat] Using ${keyConfig.provider}/${keyConfig.modelId} [${keyPreview}]`)
    
    // Get the AI model
    const model = getAIModel(keyConfig)
    
    // Convert UI messages to model format
    const modelMessages = await convertToModelMessages(messages)
    
    // Stream the response using AI SDK
    const result = streamText({
      model,
      messages: modelMessages,
      // Default system prompt for Alia
      system: 'Eres Alia, un asistente de IA amigable y servicial. Responde en el mismo idioma que el usuario.',
    })
    
    // Return as UI Message Stream Response (AI SDK handles the protocol)
    return result.toUIMessageStreamResponse()
    
  } catch (e: any) {
    console.error('❌ [Alia/Chat] Error:', e)
    return Response.json({ error: e.message }, { status: 500 })
  }
}

export async function GET() {
  return Response.json({
    status: '🟢 Online',
    service: 'Alia AI Chat',
    description: 'Internal API for Alia frontend. For OpenAI-compatible API, use /api/v1/chat/completions'
  })
}
