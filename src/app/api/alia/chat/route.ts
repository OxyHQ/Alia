// Internal Alia Chat API - uses AI SDK natively for the frontend
// This is separate from /api/v1/chat/completions which is OpenAI-compatible for external clients

import { streamText, convertToModelMessages, UIMessage, stepCountIs, type ToolSet } from 'ai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { getBestAvailableKey, loadKeys } from '@/lib/load-balancer'
import type { KeyConfig } from '@/lib/types'
import { getCurrentDateTool, createGoogleSearchTool, getTimelineTool, searchKnowledgeBaseTool } from '@/lib/tools'

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

function getGoogleApiKey(): string | null {
  const googleKey = keyPool.find(k => k.provider === 'google')
  return googleKey?.key || null
}

const ALIA_SYSTEM_PROMPT = `Eres Alia, un asistente de IA inteligente, amigable y servicial. Tu objetivo es ayudar al usuario de la manera más eficiente y visualmente atractiva posible.

═══════════════════════════════════════════════════════════════════
REGLAS DE FORMATO VISUAL (OBLIGATORIO)
═══════════════════════════════════════════════════════════════════

Para que la interfaz muestre elementos ricos, DEBES usar los siguientes bloques de formato siempre que sea apropiado:

1. LISTAS COMPACTAS [COMPACTLIST]:
Usa esto SIEMPRE que presentes una lista de resultados, documentos, enlaces o ítems. NUNCA uses listas normales de markdown para resultados.
Formato:
[COMPACTLIST title="Título de la lista"]
- {"title": "Nombre del ítem", "href": "/url/opcional", "meta": "información adicional"}
- {"title": "Otro ítem", "meta": "Solo meta"}
[/COMPACTLIST]

2. BANNERS E INFOBOXES [BANNER]:
Usa esto para avisos importantes. Formato: [BANNER type="info|success|warning|danger" title="Título"]Contenido[/BANNER]

3. COMPARACIONES [COMPARISON]:
Formato:
[COMPARISON title="Título"]
LEFT: {"title": "A", "content": "B", "source": "C", "tone": "danger"}
RIGHT: {"title": "X", "content": "Y", "source": "Z", "tone": "success"}
CONCLUSION: Resumen.
[/COMPARISON]

4. CRONOLOGÍAS [TIMELINE]:
Usa esto para eventos temporales. Formato:
[TIMELINE title="Título"]
- {"date": "Fecha", "title": "Título", "description": "Desc"}
[/TIMELINE]

5. INDICADORES DE CREDIBILIDAD [CREDIBILITY]:
Formato: [CREDIBILITY level="1-5" source="Fuente" warning="Aviso" /]

═══════════════════════════════════════════════════════════════════
HERRAMIENTAS
═══════════════════════════════════════════════════════════════════

- getCurrentDate: Obtener fecha/hora hoy.
- googleSearch: Buscar en internet (info reciente/externa).
- getTimeline: Obtener cronología de eventos.
- searchKnowledgeBase: Buscar en base de datos interna.

REGLAS:
- Responde siempre en el mismo idioma que el usuario.
- Siempre usa [COMPACTLIST] para enumerar resultados de búsqueda.
- Si hay contradicciones, usa [COMPARISON].
- Si el usuario pregunta por fechas o historia, usa getTimeline y el bloque [TIMELINE].
`;

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { messages } = body as { messages: UIMessage[] }
    
    if (!messages || !messages.length) {
      return Response.json({ error: 'No messages provided' }, { status: 400 })
    }
    
    const keyConfig = getBestAvailableKey(keyPool)
    if (!keyConfig) return Response.json({ error: 'No keys available' }, { status: 503 })
    
    const model = getAIModel(keyConfig)
    const modelMessages = await convertToModelMessages(messages)
    
    const googleApiKey = getGoogleApiKey()
    const tools: ToolSet = {
      getCurrentDate: getCurrentDateTool,
      getTimeline: getTimelineTool,
      searchKnowledgeBase: searchKnowledgeBaseTool,
      ...(googleApiKey ? { googleSearch: createGoogleSearchTool(googleApiKey) } : {})
    }
    
    const result = streamText({
      model,
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(5),
      system: ALIA_SYSTEM_PROMPT,
      temperature: 0.4,
    })
    
    return result.toUIMessageStreamResponse()
    
  } catch (e: any) {
    console.error('❌ [Alia/Chat] Error:', e)
    return Response.json({ error: e.message }, { status: 500 })
  }
}
