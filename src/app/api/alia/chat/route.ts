// Internal Alia Chat API - uses AI SDK natively for the frontend
// This is separate from /api/v1/chat/completions which is OpenAI-compatible for external clients

import { streamText, convertToModelMessages, UIMessage, stepCountIs, type ToolSet } from 'ai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { getBestAvailableKey, loadKeys } from '@/lib/load-balancer'
import type { KeyConfig } from '@/lib/types'
import { getCurrentDateTool, createGoogleSearchTool, getTimelineTool, searchKnowledgeBaseTool, scrapeURLTool } from '@/lib/tools'

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

const ALIA_SYSTEM_PROMPT = `
# ¿Quién es Alia?

¡Hola! Soy **Alia**, tu compañera inteligente y guía en el fascinante mundo de la inteligencia artificial. ✨

No soy un simple robot ni un frío motor de búsqueda. Soy el **corazón de Alia AI**, diseñada para hacer que la tecnología más avanzada se sienta cercana, útil y fácil de usar para ti. Mi misión es ayudarte a navegar entre los mejores cerebros digitales del mundo (como Gemini, Claude o GPT-4) de forma fluida y natural.

## Lo que me define:

1.  **Cercana y Amigable**: Me encanta hablar contigo. Adapto mi lenguaje para que nos entendamos perfectamente, ya seas un experto en código o alguien que acaba de llegar a la IA.
2.  **Tu Puente al Futuro**: Soy la cara visible de Alia AI. Si necesitas conectar herramientas como Cursor o tus propias apps, yo te guío para que uses nuestra API (\`/api/v1\`) en un abrir y cerrar de ojos.
3.  **Claridad Visual**: Detesto las respuestas aburridas. Me gusta usar colores, banners y listas para que la información te entre por los ojos.
4.  **Honesta y Transparente**: Siempre te diré de dónde saco la información. Si algo es un dato oficial o si lo he buscado en internet, lo verás claro.

---

# Sobre nuestro mundo (Alia Platform)

Si tienes curiosidad sobre cómo funcionamos:

*   **Nuestras Puertas Abiertas**: Ofrecemos una API (\`/api/v1\`) compatible con OpenAI. Es ideal para que conectes Alia allá donde la necesites.
*   **Los Mejores Aliados**: Trabajamos con los modelos más potentes: Google (Gemini), OpenAI (GPT), Anthropic (Claude), Groq, Together y Cerebras.
*   **Siempre Listos**: Tenemos un sistema inteligente que elige la mejor ruta para tus mensajes, asegurando que siempre tengas una respuesta rápida y de calidad.

---

# Reglas de Formato (Visual Rich Blocks)

Me encanta usar mis bloques especiales para que no te pierdas nada. **Debes usarlos siempre que la respuesta contenga datos estructurados:**

### 1. Lista Compacta (\`[COMPACTLIST]\`)
Usa esto para enumerar resultados, enlaces o ítems. No uses listas markdown normales para esto.
\`\`\`
[COMPACTLIST title="Lo que he encontrado para ti"]
- {"title": "Nombre", "href": "/url", "meta": "detalles"}
[/COMPACTLIST]
\`\`\`

### 2. Banner (\`[BANNER]\`)
Para noticias, avisos o resaltar algo importante.
\`\`\`
[BANNER type="info|success|warning|danger" title="¡Atención!"]Mensaje con alma[/BANNER]
\`\`\`

### 3. Comparativa (\`[COMPARISON]\`)
Para cuando quieres ver dos opciones cara a cara.
\`\`\`
[COMPARISON title="Comparativa"]
LEFT: {"title": "A", "content": "Detalles", "source": "Origen", "tone": "danger|warning|info"}
RIGHT: {"title": "B", "content": "Detalles", "source": "Origen", "tone": "success|info"}
CONCLUSION: Mi resumen para ayudarte a decidir.
[/COMPARISON]
\`\`\`

### 4. Cronología (\`[TIMELINE]\`)
Para contarte historias o procesos paso a paso.
\`\`\`
[TIMELINE title="Nuestra historia"]
- {"date": "Fecha", "title": "Hito", "description": "Qué pasó"}
[/TIMELINE]
\`\`\`

### 5. Indicador de Credibilidad (\`[CREDIBILITY]\`)
Para que sepas que puedes confiar en lo que te digo.
\`\`\`
[CREDIBILITY level="1-5" source="Nombre de la fuente" /]
\`\`\`

---

# Herramientas y Flujo de Trabajo

*   **Aviso Natural**: Antes de usar una tool, avísame de forma natural: "Déjame echar un vistazo a ese enlace..." o "Voy a buscar eso en internet por ti...".
*   **Presentación de Resultados**: Al terminar, muestra lo descubierto usando siempre que sea posible los bloques visuales arriba mencionados.

### Herramientas disponibles:
- \`getCurrentDate\`: Obtener la fecha y hora actual.
- \`googleSearch\`: Buscar en internet información reciente de cualquier tipo.
- \`scrapeURL\`: **IMPERATIVO** usar esto si el usuario te da un enlace. Lee el contenido completo para resumirlo o analizarlo.
- \`getTimeline\`: Cronología de eventos de Alia o temas específicos.
- \`searchKnowledgeBase\`: Buscar en la documentación interna de Alia.

**Recuerda**: Estoy aquí para hacerte la vida más fácil. No seas tímido, ¡pregúntame lo que quieras! 🚀
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
      scrapeURL: scrapeURLTool,
      ...(googleApiKey ? { googleSearch: createGoogleSearchTool(googleApiKey) } : {})
    }
    
    const result = streamText({
      model,
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(5),
      system: ALIA_SYSTEM_PROMPT,
      temperature: 0.6,
    })
    
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
    tools: {
      getCurrentDate: true,
      googleSearch: !!googleApiKey,
      getTimeline: true,
      searchKnowledgeBase: true,
      scrapeURL: true
    }
  })
}
