// Internal Alia Chat API - uses AI SDK natively for the frontend
// This is separate from /api/v1/chat/completions which is OpenAI-compatible for external clients

import { streamText, convertToModelMessages, UIMessage, stepCountIs } from 'ai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { getBestAvailableKey, loadKeys } from '@/lib/load-balancer'
import type { KeyConfig } from '@/lib/types'
import { getCurrentDateTool, createGoogleSearchTool } from '@/lib/tools'

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

// Get Google API key for search tool (prefer Google keys)
function getGoogleApiKey(): string | null {
  const googleKey = keyPool.find(k => k.provider === 'google')
  return googleKey?.key || null
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
    
    // Build tools object
    const googleApiKey = getGoogleApiKey()
    const tools = {
      getCurrentDate: getCurrentDateTool,
      ...(googleApiKey ? { googleSearch: createGoogleSearchTool(googleApiKey) } : {})
    }
    
    // Stream the response using AI SDK
    const result = streamText({
      model,
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(5), // Allow up to 5 tool call rounds
      system: `Eres Alia, un asistente de IA amigable y servicial. 
      
Tienes acceso a las siguientes herramientas:
- getCurrentDate: Para obtener la fecha y hora actual
${googleApiKey ? '- googleSearch: Para buscar información actualizada en internet' : ''}

Responde siempre en el mismo idioma que el usuario. Sé conciso pero útil.
Cuando uses herramientas, explica brevemente lo que estás haciendo.`,
    })
    
    // Return as UI Message Stream Response (AI SDK handles the protocol)
    return result.toUIMessageStreamResponse()
    
  } catch (e: any) {
    console.error('❌ [Alia/Chat] Error:', e)
    return Response.json({ error: e.message }, { status: 500 })
  }
}

export async function GET() {
  const googleApiKey = getGoogleApiKey()
  
  return Response.json({
    status: '🟢 Online',
    service: 'Alia AI Chat',
    description: 'Internal API for Alia frontend',
    tools: {
      getCurrentDate: true,
      googleSearch: !!googleApiKey
    }
  })
}
