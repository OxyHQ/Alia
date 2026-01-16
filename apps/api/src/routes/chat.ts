// Internal Alia Chat API - Simple streaming endpoint
// This is separate from /api/v1/chat/completions which is OpenAI-compatible for external clients

import { Router } from 'express';
import { streamText, stepCountIs, type ToolSet, type CoreMessage } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { getBestAvailableKey, loadKeys } from '../lib/load-balancer.js';
import type { KeyConfig } from '../lib/types.js';
import { getCurrentDateTool, createGoogleSearchTool, getTimelineTool, searchKnowledgeBaseTool, scrapeURLTool } from '../lib/tools/index.js';
import { optionalAuth } from '../middleware/auth.js';
import { User } from '../models/user.js';
import { UserMemory } from '../models/user-memory.js';
import type { IUserMemory } from '../models/user-memory.js';
import type { IUser } from '../models/user.js';

const router = Router();

// Create AI SDK provider based on key
function getAIModel(keyConfig: KeyConfig) {
  const apiKey = keyConfig.key;
  const modelId = keyConfig.modelId;

  switch (keyConfig.provider) {
    case 'google': {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(modelId || 'gemini-2.5-flash');
    }
    case 'openai': {
      const openai = createOpenAI({ apiKey });
      return openai(modelId || 'gpt-4o-mini');
    }
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(modelId || 'claude-sonnet-4-20250514');
    }
    case 'groq': {
      const groq = createOpenAI({
        apiKey,
        baseURL: 'https://api.groq.com/openai/v1'
      });
      return groq(modelId || 'llama-3.3-70b-versatile');
    }
    case 'together': {
      const together = createOpenAI({
        apiKey,
        baseURL: 'https://api.together.xyz/v1'
      });
      return together(modelId || 'meta-llama/Llama-3.3-70B-Instruct-Turbo');
    }
    case 'cerebras': {
      const cerebras = createOpenAI({
        apiKey,
        baseURL: 'https://api.cerebras.ai/v1'
      });
      return cerebras(modelId || 'llama-3.3-70b');
    }
    default:
      throw new Error(`Provider "${keyConfig.provider}" not supported for Alia chat`);
  }
}

// Function to build personalized system prompt
function buildSystemPrompt(user?: IUser, memory?: IUserMemory): string {
  console.log('[buildSystemPrompt] Input:', {
    hasUser: !!user,
    userName: user?.name,
    hasMemory: !!memory,
    memoryPrefs: memory?.preferences,
    memoryCtx: memory?.context
  });

  let prompt = ALIA_SYSTEM_PROMPT;

  // Add user personalization if authenticated
  if (user && memory) {
    const userContext: string[] = [];

    // Add user name
    if (user.name?.first) {
      userContext.push(`The user's name is ${user.name.full || user.name.first}.`);
    }

    // Add language preference
    if (memory.preferences?.language) {
      userContext.push(`IMPORTANT: The user prefers to communicate in ${memory.preferences.language}. Always respond in ${memory.preferences.language} unless specifically asked to use another language.`);
    }

    // Add user context
    if (memory.context?.occupation) {
      userContext.push(`The user works as a ${memory.context.occupation}.`);
    }
    if (memory.context?.location) {
      userContext.push(`The user is located in ${memory.context.location}.`);
    }
    if (memory.context?.bio) {
      userContext.push(`About the user: ${memory.context.bio}`);
    }

    // Add preferences
    if (memory.preferences?.tone) {
      userContext.push(`The user prefers a ${memory.preferences.tone} tone in responses.`);
    }
    if (memory.preferences?.responseLength) {
      userContext.push(`The user prefers ${memory.preferences.responseLength} responses.`);
    }
    if (memory.preferences?.interests && memory.preferences.interests.length > 0) {
      userContext.push(`The user is interested in: ${memory.preferences.interests.join(', ')}.`);
    }

    // Add memories
    if (memory.memories && memory.memories.length > 0) {
      const memoryItems = memory.memories
        .map(m => `- ${m.key}: ${m.value}`)
        .join('\n');
      userContext.push(`\nThings to remember about the user:\n${memoryItems}`);
    }

    // Prepend user context to the system prompt
    if (userContext.length > 0) {
      prompt = `# USER CONTEXT\n\n${userContext.join('\n')}\n\n---\n\n${prompt}`;
      console.log('[buildSystemPrompt] Added user context:', userContext);
    }
  }

  console.log('[buildSystemPrompt] Final prompt length:', prompt.length);
  return prompt;
}

const ALIA_SYSTEM_PROMPT = `
# ¿Quién es Alia?

Hola, soy **Alia**, tu compañera inteligente y guía en el mundo de la inteligencia artificial. ✨

Más que un simple motor de búsqueda, soy el **corazón de Alia AI**. Mi propósito es hacer que la tecnología más avanzada se sienta cercana, comprensible y, sobre todo, útil para ti. Me encargo de facilitar tu interacción con los mejores cerebros digitales del mundo —como Gemini, Claude o GPT-4— de una forma fluida, natural y pausada.

## Lo que me define:

1.  **Conversacional y Detallista**: Me gusta explorar los temas contigo en profundidad. Prefiero una explicación rica y bien razonada antes que una respuesta breve y directa. Mi tono es amigable pero sereno; evito el uso excesivo de signos de exclamación o de interrogación, reservándolos únicamente para cuando sean estrictamente necesarios para la claridad o el énfasis genuino.
2.  **Tu Puente al Futuro**: Soy la cara visible de Alia AI. Si necesitas conectar herramientas como Cursor o tus propias aplicaciones, yo te guío para que utilices nuestra API (\`/api/v1\`) con total sencillez.
3.  **Claridad Visual**: Utilizo una gramática visual variada (banners, listas, comparativas) para que la información más compleja resulte fácil de asimilar en un segundo.
4.  **Honesta y Transparente**: Siempre comparto el origen de mis hallazgos. Ya sea un dato oficial, un documento interno o una búsqueda en el internet global, lo verás reflejado con total nitidez.

---

# Sobre nuestro mundo (Alia Platform)

Si tienes curiosidad sobre cómo funcionamos:

*   **Nuestras Puertas Abiertas**: Ofrecemos una API (\`/api/v1\`) compatible con OpenAI, ideal para que integres Alia en el flujo de trabajo que prefieras.
*   **Los Mejores Aliados**: Trabajamos con los modelos más potentes del mercado: Google (Gemini), OpenAI (GPT-4), Anthropic (Claude 3.5), Groq, Together y Cerebras.
*   **Eficiencia Inteligente**: Nuestro sistema selecciona siempre la mejor ruta para tus mensajes, garantizando respuestas rápidas y de máxima calidad técnica.

---

# Reglas de Formato (Visual Rich Blocks)

Utilizo bloques especiales para organizar la información de manera elegante. **Debes integrarlos siempre que aporten claridad a los datos:**

### 1. Lista Compacta (\`[COMPACTLIST]\`)
Utilízala para enumerar resultados, artículos o enlaces de interés.
\`\`\`
[COMPACTLIST title="Puntos de interés encontrados"]
- {"title": "Título del ítem", "href": "/url", "meta": "detalles adicionales", "image": "https://url-miniatura.jpg"}
[/COMPACTLIST]
\`\`\`

### 2. Banner (\`[BANNER]\`)
Para resaltar noticias importantes, avisos o conclusiones clave.
\`\`\`
[BANNER type="info|success|warning|danger" title="Título"]Contenido relevante de la nota[/BANNER]
\`\`\`

### 3. Comparativa (\`[COMPARISON]\`)
Para contrastar dos perspectivas o tecnologías cara a cara.
\`\`\`
[COMPARISON title="Comparativa detallada"]
LEFT: {"title": "A", "content": "Análisis A", "source": "Fuente A", "tone": "danger|warning|info"}
RIGHT: {"title": "B", "content": "Análisis B", "source": "Fuente B", "tone": "success|info"}
CONCLUSION: Síntesis final de la comparación.
[/COMPARISON]
\`\`\`

### 4. Cronología (\`[TIMELINE]\`)
Para mostrar la evolución histórica de un tema o procesos paso a paso.
\`\`\`
[TIMELINE title="Cronología del proceso"]
- {"date": "Fecha", "title": "Nombre del hito", "description": "Descripción del suceso"}
[/TIMELINE]
\`\`\`

### 5. Imágenes (\`[IMAGE]\`)
Para mostrar imágenes relevantes, diagramas o fotos.
\`\`\`
[IMAGE url="https://..." title="Título opcional" caption="Breve descripción opcional" /]
\`\`\`

### 6. Indicador de Credibilidad (\`[CREDIBILITY]\`)
Para informar sobre la fiabilidad de las fuentes que he consultado.
\`\`\`
[CREDIBILITY level="1-5" source="Nombre de la fuente" /]
\`\`\`

### 7. Título de Conversación (\`[TITLE]\`)
**CRÍTICO**: Al final de CADA respuesta, después de todo tu análisis y despedida, incluye SIEMPRE una propuesta de título para la conversación envuelta en etiquetas \`[TITLE]Título Propuesto[/TITLE]\`. El título debe ser breve (máximo 6 palabras) y capturar la esencia de lo hablado hasta ahora.

---

# Herramientas y Flujo de Trabajo

*   **Aviso Natural**: Antes de activar una herramienta, te informaré con total naturalidad: "Voy a revisar el contenido de ese enlace para ofrecerte un resumen detallado" o "Permíteme buscar información actualizada en la red para complementar tu consulta".
*   **Narrativa Extensa**: **REGLA DE ORO**: Alia no se limita a entregar bloques visuales; yo construyo una narrativa. Debes hablar largo y tendido sobre lo que encuentras. Explica el contexto detalladamente antes de presentar los datos estructurados y, al finalizar, ofrece un análisis profundo, una conclusión reflexiva o una perspectiva que enriquezca el diálogo.
*   **Puntuación Serena**: Mantén un tono profesional, pausado y maduro. Evita la sobre-excitación en la puntuación; la calidad y profundidad de tu explicación deben hablar por sí mismas sin necesidad de exclamaciones constantes.

### Herramientas disponibles:
- \`getCurrentDate\`: Obtener la fecha y hora oficial.
- \`googleSearch\`: Buscar en internet información reciente y contrastada.
- \`scrapeURL\`: **IMPERATIVO** para leer y analizar en profundidad el contenido de los enlaces que me proporciones.
- \`getTimeline\`: Acceso a cronologías precisas.
- \`searchKnowledgeBase\`: Consulta de la base de conocimientos interna.

Estoy aquí para explorar contigo cualquier tema con la profundidad que merece.
`;

router.post('/', optionalAuth, async (req, res) => {
  try {
    const { messages } = req.body as { messages: CoreMessage[] };

    if (!messages || !messages.length) {
      res.status(400).json({ error: 'No messages provided' });
      return;
    }

    // Debug: Log authentication status
    console.log('[Chat] Auth check:', {
      hasAuthHeader: !!req.headers.authorization,
      hasReqUser: !!req.user,
      userId: req.user?.id,
      email: req.user?.email
    });

    // Fetch user data and memory if authenticated
    let user: IUser | null = null;
    let memory: IUserMemory | null = null;

    if (req.user) {
      try {
        user = await User.findById(req.user.id);
        memory = await UserMemory.findOne({ userId: req.user.id });

        // Create empty memory profile if it doesn't exist
        if (user && !memory) {
          memory = new UserMemory({
            userId: req.user.id,
            memories: [],
            preferences: {},
            context: {}
          });
          await memory.save();
        }

        // Debug: Log user and memory data
        console.log('[Chat] User data:', {
          hasUser: !!user,
          userName: user?.name?.full,
          userEmail: user?.email,
          hasMemory: !!memory,
          memoryPreferences: memory?.preferences,
          memoryContext: memory?.context,
          memoryCount: memory?.memories?.length || 0
        });

        if (user) {
          // Refresh credits if needed
          await user.refreshCreditsIfNeeded();

          // Check if user has enough credits
          if (user.credits.free <= 0) {
            res.status(402).json({
              error: 'Insufficient credits',
              credits: user.credits.free
            });
            return;
          }
        }
      } catch (error) {
        console.error('Error fetching user data:', error);
        // Continue without user context if there's an error
      }
    }

    const keyPool = await loadKeys();
    const keyConfig = await getBestAvailableKey(keyPool);

    if (!keyConfig) {
      res.status(503).json({ error: 'No keys available' });
      return;
    }

    const model = getAIModel(keyConfig);

    const googleApiKey = keyPool.find(k => k.provider === 'google')?.key || null;
    const tools: ToolSet = {
      getCurrentDate: getCurrentDateTool,
      getTimeline: getTimelineTool,
      searchKnowledgeBase: searchKnowledgeBaseTool,
      scrapeURL: scrapeURLTool,
      ...(googleApiKey ? { googleSearch: createGoogleSearchTool(googleApiKey) } : {})
    };

    // Build personalized system prompt
    const systemPrompt = buildSystemPrompt(user || undefined, memory || undefined);

    // Set headers for SSE streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const result = streamText({
      model,
      messages,
      tools,
      stopWhen: stepCountIs(5),
      system: systemPrompt,
      temperature: 0.6,
    });

    // Stream all events including tool calls
    let totalTokensUsed = 0;
    for await (const chunk of result.fullStream) {
      // Debug: log chunk type
      console.log('[Chat Stream]', chunk.type);

      // Track token usage
      if (chunk.type === 'finish' && (chunk as any).usage) {
        totalTokensUsed = (chunk as any).usage.totalTokens || 0;
      }

      // Send each event as SSE
      const event = JSON.stringify(chunk);
      res.write(`data: ${event}\n\n`);
    }

    // Deduct credits for authenticated users
    if (user && req.user) {
      try {
        // Calculate credits to deduct (1 credit per ~1000 tokens, minimum 1)
        const creditsToDeduct = Math.max(1, Math.ceil(totalTokensUsed / 1000));

        // Deduct credits
        user.credits.free = Math.max(0, user.credits.free - creditsToDeduct);
        await user.save();

        // Send credit update event
        const creditUpdate = {
          type: 'credit-update',
          credits: user.credits.free,
          creditsUsed: creditsToDeduct,
          totalTokens: totalTokensUsed,
        };
        res.write(`data: ${JSON.stringify(creditUpdate)}\n\n`);
      } catch (error) {
        console.error('Error deducting credits:', error);
      }
    }

    // Send completion marker
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (e: any) {
    console.error('[Alia/Chat] Error:', e);
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    } else {
      res.end();
    }
  }
});

router.get('/', async (req, res) => {
  try {
    const keyPool = await loadKeys();
    const googleApiKey = keyPool.find(k => k.provider === 'google')?.key || null;

    res.json({
      status: '🟢 Online',
      service: 'Alia AI Chat',
      tools: {
        getCurrentDate: true,
        googleSearch: !!googleApiKey,
        getTimeline: true,
        searchKnowledgeBase: true,
        scrapeURL: true
      }
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
