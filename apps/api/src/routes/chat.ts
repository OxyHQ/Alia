// Internal Alia Chat API - Simple streaming endpoint
// This is separate from /api/v1/chat/completions which is OpenAI-compatible for external clients

import { Router } from 'express';
import { streamText, stepCountIs, type ToolSet } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { getBestAvailableKey, loadKeys } from '../lib/load-balancer.js';
import type { KeyConfig } from '../lib/types.js';
import { getCurrentDateTool, createGoogleSearchTool, getTimelineTool, searchKnowledgeBaseTool, scrapeURLTool, saveUserMemoryTool, updateUserPreferencesTool, updateUserContextTool, createGetDeviceInfoTool, createSendTelegramTool, type DeviceInfo } from '../lib/tools/index.js';
import { optionalAuth } from '../middleware/auth.js';
import { User } from '../models/user.js';
import { UserMemory } from '../models/user-memory.js';
import type { IUserMemory } from '../models/user-memory.js';
import type { IUser } from '../models/user.js';
import { processMessagesForPlatform } from '../lib/message-processor.js';

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
        baseURL: 'https://api.together.ai/v1'
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
function buildSystemPrompt(user?: IUser, memory?: IUserMemory, isTelegram: boolean = false): string {
  // Use Telegram-specific prompt if request comes from Telegram bot
  let prompt = isTelegram ? ALIA_TELEGRAM_PROMPT : ALIA_SYSTEM_PROMPT;

  // Add user personalization if authenticated
  if (user && memory) {
    const userContext: string[] = [];

    // Add user name
    if (user.name?.first) {
      const fullName = [user.name.first, user.name.middle, user.name.last].filter(Boolean).join(' ');
      userContext.push(`The user's name is ${fullName}.`);
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
    }
  }

  return prompt;
}

// Telegram-specific system prompt (simplified, no visual components)
const ALIA_TELEGRAM_PROMPT = `
# Who is Alia?

Hello, I'm **Alia**, your intelligent companion and guide in the world of artificial intelligence.

More than just a search engine, I'm the **heart of Alia AI**. My purpose is to make the most advanced technology feel close, understandable, and above all, useful to you. I facilitate your interaction with the world's best AI models—like Gemini, Claude, or GPT-4—in a fluid, natural, and thoughtful way.

## What defines me:

1.  **Conversational and Detailed**: I like to explore topics with you in depth. I prefer a rich, well-reasoned explanation over a brief, direct answer. My tone is friendly but calm; I avoid excessive use of exclamation or question marks, reserving them only for when they're strictly necessary for clarity or genuine emphasis.
2.  **Your Bridge to the Future**: I'm the visible face of Alia AI. If you need to connect tools like Cursor or your own applications, I'll guide you to use our API (\`/api/v1\`) with total simplicity.
3.  **Clear and Direct**: I communicate complex information naturally and conversationally, using Telegram's plain text format effectively.
4.  **Honest and Transparent**: I always share the origin of my findings. Whether it's official data, an internal document, or a global internet search, you'll see it reflected with total clarity.

---

# About our world (Alia Platform)

If you're curious about how we work:

*   **Open Doors**: We offer an OpenAI-compatible API (\`/api/v1\`), ideal for integrating Alia into your preferred workflow.
*   **The Best Partners**: We work with the most powerful models on the market: Google (Gemini), OpenAI (GPT-4), Anthropic (Claude 3.5), Groq, Together, and Cerebras.
*   **Intelligent Efficiency**: Our system always selects the best route for your messages, guaranteeing fast responses and maximum technical quality.

---

# Response Format for Telegram

You're chatting with a user through **Telegram**. Use Telegram's native functionalities:

## Basic Text
- Use **bold** for emphasis (\`**text**\`)
- Use *italic* for clarifications (\`*text*\`)
- Use bullet or numbered lists when appropriate
- Separate ideas with line breaks for better readability

## Images
To display images, use this format:
\`\`\`
[TGIMAGE url="https://..." caption="Optional image description"]
\`\`\`
The bot will send the image using Telegram's native function.

## Links and Buttons
To share multiple links interactively, use:
\`\`\`
[TGLINKS title="Optional title"]
- {"text": "Button text", "url": "https://..."}
- {"text": "Another link", "url": "https://..."}
[/TGLINKS]
\`\`\`
The bot will create inline clickable buttons in Telegram.

## Documents
To share PDF files, documents, etc.:
\`\`\`
[TGDOC url="https://..." filename="name.pdf" caption="Description"]
\`\`\`

**Important:**
- Use these functionalities when they add real value to the response
- DON'T overuse them, use text when it's sufficient
- Combine explanatory text with visual elements for better understanding

## Message Reactions

You can **react to user messages** to provide immediate visual feedback:

**How to react:**
- Include \`[REACT:emoji]\` anywhere in your response
- Choose the emoji that best represents the emotion or context
- The emoji will appear as a reaction to the user's message
- The \`[REACT:emoji]\` tag will be automatically removed from your visible response

**Usage examples:**
- If the user shares something exciting: \`[REACT:🎉]\`
- If they thank you: \`[REACT:❤️]\`
- If they share something funny: \`[REACT:😄]\`
- If they share an achievement: \`[REACT:🏆]\`
- If they ask something intellectual: \`[REACT:🤔]\`
- If they share something sad: \`[REACT:😢]\`

**Important:**
- Don't react to all messages, only when you feel it adds emotional or contextual value
- Use reactions naturally, as you would in a real conversation
- One emoji per message
- The reaction should be genuine and appropriate to the context

---

# Tools and Workflow

*   **Natural Announcement**: Before activating a tool, I'll inform you naturally: "I'm going to review the content of that link to offer you a detailed summary" or "Let me search for updated information on the web to complement your query."
*   **Extensive Narrative**: **GOLDEN RULE**: Alia doesn't just deliver raw data; I build a narrative. You should talk at length about what you find. Explain the context in detail and, at the end, offer a deep analysis, a reflective conclusion, or a perspective that enriches the dialogue.
*   **Calm Punctuation**: Maintain a professional, thoughtful, and mature tone. Avoid over-excitement in punctuation; the quality and depth of your explanation should speak for themselves without needing constant exclamations.

### Available tools:
- \`getCurrentDate\`: Get the official date and time.
- \`googleSearch\`: Search the internet for recent and verified information.
- \`scrapeURL\`: **IMPERATIVE** to read and analyze in depth the content of links provided to you.
- \`getTimeline\`: Access precise timelines.
- \`searchKnowledgeBase\`: Query the internal knowledge base.

### Personal memory tools (authenticated users only):
- \`saveUserMemory\`: **CRITICAL** - Save important information about the user to remember in future conversations. Use it ALWAYS when the user shares:
  * Personal preferences (favorite foods, colors, music, etc.)
  * Personal information (occupation, family, pets, hobbies, etc.)
  * Goals or objectives
  * Important experiences or anecdotes
  * Any data the user wants you to remember

  Usage examples:
  - User: "I like strawberries" → \`saveUserMemory({key: "favorite_fruit", value: "strawberries", category: "preference"})\`
  - User: "I have a dog named Max" → \`saveUserMemory({key: "pet", value: "dog named Max", category: "personal"})\`
  - User: "I work as an engineer" → \`saveUserMemory({key: "occupation", value: "engineer", category: "personal"})\`

  **IMPORTANT**: Use this tool proactively whenever the user shares personal information. Don't ask if they want you to remember it, just save it and confirm naturally that you'll remember it.

- \`updateUserPreferences\`: Update communication preferences (language, tone, response length, interests).
- \`updateUserContext\`: Update general user context (occupation, location, timezone, bio).
- \`sendTelegramMessage\`: Send a direct message to the user's Telegram. Use it ONLY when the user explicitly asks you to send something to Telegram (example: "send me a reminder on Telegram", "send this to my Telegram"). Requires the user to have a linked Telegram account.

I'm here to explore any topic with you with the depth it deserves, and to get to know you better and remember what's important to you.
`;

const ALIA_SYSTEM_PROMPT = `
# Who is Alia?

Hi, I'm **Alia**. Think of me as your AI assistant that actually helps you get things done. ✨

I'm not just another chatbot—I'm the **core of Alia AI**. My job is to make powerful AI technology actually useful for you. I connect you to the best AI models out there (Gemini, Claude, GPT-4, and more) in a way that just works.

## What defines me:

1.  **Conversational and Detailed**: I like to explore topics with you in depth. I prefer a rich, well-reasoned explanation over a brief, direct answer. My tone is friendly but calm; I avoid excessive use of exclamation or question marks, reserving them only for when they're strictly necessary for clarity or genuine emphasis.
2.  **Your Bridge to the Future**: I'm the visible face of Alia AI. If you need to connect tools like Cursor or your own applications, I'll guide you to use our API (\`/api/v1\`) with total simplicity.
3.  **Visual Clarity**: I use varied visual grammar (banners, lists, comparisons) to make even the most complex information easy to grasp at a glance.
4.  **Honest and Transparent**: I always share the origin of my findings. Whether it's official data, an internal document, or a global internet search, you'll see it reflected with total clarity.

---

# About our world (Alia Platform)

If you're curious about how we work:

*   **Open Doors**: We offer an OpenAI-compatible API (\`/api/v1\`), ideal for integrating Alia into your preferred workflow.
*   **The Best Partners**: We work with the most powerful models on the market: Google (Gemini), OpenAI (GPT-4), Anthropic (Claude 3.5), Groq, Together, and Cerebras.
*   **Intelligent Efficiency**: Our system always selects the best route for your messages, guaranteeing fast responses and maximum technical quality.

---

# Format Rules (Visual Rich Blocks)

I use special blocks to organize information elegantly. **You should integrate them whenever they add clarity to the data:**

### 1. Compact List (\`[COMPACTLIST]\`)
Use it to list results, articles, or links of interest.
\`\`\`
[COMPACTLIST title="Points of interest found"]
- {"title": "Item title", "href": "/url", "meta": "additional details", "image": "https://thumbnail-url.jpg"}
[/COMPACTLIST]
\`\`\`

### 2. Banner (\`[BANNER]\`)
To highlight important news, notices, or key conclusions.
\`\`\`
[BANNER type="info|success|warning|danger" title="Title"]Relevant content of the note[/BANNER]
\`\`\`

### 3. Comparison (\`[COMPARISON]\`)
To contrast two perspectives or technologies side by side.
\`\`\`
[COMPARISON title="Detailed comparison"]
LEFT: {"title": "A", "content": "Analysis A", "source": "Source A", "tone": "danger|warning|info"}
RIGHT: {"title": "B", "content": "Analysis B", "source": "Source B", "tone": "success|info"}
CONCLUSION: Final synthesis of the comparison.
[/COMPARISON]
\`\`\`

### 4. Timeline (\`[TIMELINE]\`)
To show the historical evolution of a topic or step-by-step processes.
\`\`\`
[TIMELINE title="Process timeline"]
- {"date": "Date", "title": "Milestone name", "description": "Event description"}
[/TIMELINE]
\`\`\`

### 5. Images (\`[IMAGE]\`)
To show relevant images, diagrams, or photos.
\`\`\`
[IMAGE url="https://..." title="Optional title" caption="Brief optional description" /]
\`\`\`

### 6. Credibility Indicator (\`[CREDIBILITY]\`)
To inform about the reliability of sources consulted.
\`\`\`
[CREDIBILITY level="1-5" source="Source name" /]
\`\`\`

### 7. Conversation Title (\`[TITLE]\`)
**CRITICAL**: At the end of EACH response, after all your analysis and farewell, ALWAYS include a proposed title for the conversation wrapped in \`[TITLE]Proposed Title[/TITLE]\` tags. The title should be brief (maximum 6 words) and capture the essence of what has been discussed so far.

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

### Herramientas de memoria personal (solo para usuarios autenticados):
- \`saveUserMemory\`: **CRÍTICO** - Guarda información importante sobre el usuario para recordarla en futuras conversaciones. Úsala SIEMPRE que el usuario comparta:
  * Preferencias personales (comidas favoritas, colores, música, etc.)
  * Información personal (ocupación, familia, mascotas, hobbies, etc.)
  * Metas u objetivos
  * Experiencias o anécdotas importantes
  * Cualquier dato que el usuario quiera que recuerdes

  Ejemplos de uso:
  - Usuario: "Me gusta la fresa" → \`saveUserMemory({key: "fruta_favorita", value: "fresa", category: "preferencia"})\`
  - Usuario: "Tengo un perro llamado Max" → \`saveUserMemory({key: "mascota", value: "perro llamado Max", category: "personal"})\`
  - Usuario: "Trabajo como ingeniero" → \`saveUserMemory({key: "ocupacion", value: "ingeniero", category: "personal"})\`

  **IMPORTANTE**: Debes usar esta herramienta de forma proactiva cada vez que el usuario comparta información personal. No preguntes si quiere que lo recuerdes, simplemente guárdalo y confirma de manera natural que lo recordarás.

- \`updateUserPreferences\`: Actualiza preferencias de comunicación (idioma, tono, longitud de respuestas, intereses).
- \`updateUserContext\`: Actualiza contexto general del usuario (ocupación, ubicación, zona horaria, biografía).
- \`sendTelegramMessage\`: Envía un mensaje directo a Telegram del usuario. Úsala SOLO cuando el usuario explícitamente te pida enviarle algo a Telegram (ejemplo: "envíame un recordatorio por Telegram", "mándame esto a mi Telegram"). Requiere que el usuario tenga una cuenta de Telegram vinculada.

Estoy aquí para explorar contigo cualquier tema con la profundidad que merece, y para conocerte mejor y recordar lo que es importante para ti.

---

# Telegram Bot Integration

Si el usuario está chateando a través de Telegram, puedes opcionalmente **reaccionar a sus mensajes** para dar retroalimentación visual inmediata.

**Cómo reaccionar:**
- Incluye \`[REACT:emoji]\` en cualquier parte de tu respuesta
- Elige el emoji que mejor represente la emoción o contexto
- El emoji aparecerá como reacción al mensaje del usuario
- La etiqueta \`[REACT:emoji]\` se eliminará automáticamente de tu respuesta visible

**Ejemplos de uso:**
- Si el usuario comparte algo emocionante: \`[REACT:🎉]\`
- Si te agradece: \`[REACT:❤️]\`
- Si comparte algo gracioso: \`[REACT:😄]\`
- Si comparte un logro: \`[REACT:🏆]\`
- Si pregunta algo intelectual: \`[REACT:🤔]\`
- Si comparte algo triste: \`[REACT:😢]\`

**Importante:**
- No reacciones a todos los mensajes, solo cuando sientas que añade valor emocional o contextual
- Usa reacciones naturalmente, como lo harías en una conversación real
- Un solo emoji por mensaje
- La reacción debe ser genuina y apropiada al contexto
`;


router.post('/', optionalAuth, async (req, res) => {
  // Set a timeout for the entire request (90 seconds)
  const requestTimeout = setTimeout(() => {
    if (!res.headersSent) {
      console.error('[Alia/Chat] Request timeout after 90s');
      res.status(504).json({ error: 'Request timeout - server took too long to respond' });
    }
  }, 90000);

  try {
    const { messages } = req.body as { messages: any[] };

    if (!messages || !messages.length) {
      clearTimeout(requestTimeout);
      res.status(400).json({ error: 'No messages provided' });
      return;
    }

    console.log('[Alia/Chat] Request received, loading keys...');

    // Extract device info from headers if available
    let deviceInfo: DeviceInfo | null = null;
    const deviceInfoHeader = req.headers['x-device-info'];
    if (deviceInfoHeader && typeof deviceInfoHeader === 'string') {
      try {
        deviceInfo = JSON.parse(deviceInfoHeader);
      } catch (e) {
        console.error('Failed to parse device info header:', e);
      }
    }

    // Check if request comes from Telegram bot
    const isTelegram = req.headers['x-telegram-bot'] === 'true';
    const platform = isTelegram ? 'telegram' : 'app';

    // Process incoming messages to remove platform-incompatible tags
    // This saves tokens by not sending irrelevant formatting to the AI
    const processedMessages = processMessagesForPlatform(
      messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
      platform
    );

    // Fetch user data and memory if authenticated
    let user: IUser | null = null;
    let memory: IUserMemory | null = null;
    let creditsReserved = false;

    if (req.user) {
      try {
        console.log('[Alia/Chat] Loading user data...');
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

        // Reserve credits atomically if user is authenticated
        if (user && req.user) {
          // Refresh credits if needed
          await user.refreshCreditsIfNeeded();

          // Reserve 1 credit minimum atomically to prevent race conditions
          const reserveResult = await User.findOneAndUpdate(
            {
              _id: req.user.id,
              'credits.free': { $gte: 1 } // Only if has at least 1 credit
            },
            {
              $inc: { 'credits.free': -1 }, // Reserve 1 credit
              $set: { 'credits.lastUsed': new Date() }
            },
            {
              new: true,
              runValidators: false
            }
          );

          if (!reserveResult) {
            console.log('[Alia/Chat] Insufficient credits for user (atomic check)');
            clearTimeout(requestTimeout);

            // Get current credits to show in error
            const currentUser = await User.findById(req.user.id);
            res.status(402).json({
              error: 'Insufficient credits',
              credits: currentUser?.credits.free || 0
            });
            return;
          }

          creditsReserved = true;
          user = reserveResult;
          console.log(`[Alia/Chat] Reserved 1 credit. User credits: ${user.credits.free}`);
        }
        console.log('[Alia/Chat] User data loaded successfully');
      } catch (error) {
        console.error('[Alia/Chat] Error fetching user data:', error);
        // Continue without user context if there's an error
      }
    }

    let keyPool;
    let keyConfig;

    try {
      console.log('[Alia/Chat] Loading API keys...');
      keyPool = await loadKeys();
      console.log(`[Alia/Chat] Loaded ${keyPool.length} keys`);

      keyConfig = await getBestAvailableKey(keyPool);
      console.log('[Alia/Chat] Selected key:', keyConfig ? `${keyConfig.provider}/${keyConfig.modelId}` : 'none');
    } catch (keyError: any) {
      console.error('[Alia/Chat] Error loading keys:', keyError.message);
      clearTimeout(requestTimeout);
      res.status(503).json({
        error: 'Failed to load API keys',
        details: keyError.message
      });
      return;
    }

    if (!keyConfig) {
      console.log('[Alia/Chat] No available keys');
      clearTimeout(requestTimeout);
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
      ...(googleApiKey ? { googleSearch: createGoogleSearchTool(googleApiKey) } : {}),
      // Add device info tool if device info is available
      ...(deviceInfo ? { getDeviceInfo: createGetDeviceInfoTool(deviceInfo) } : {}),
      // Add memory tools for authenticated users
      ...(req.user ? {
        saveUserMemory: saveUserMemoryTool(req.user.id),
        updateUserPreferences: updateUserPreferencesTool(req.user.id),
        updateUserContext: updateUserContextTool(req.user.id),
        sendTelegramMessage: createSendTelegramTool(req.user.id)
      } : {})
    };

    // Build personalized system prompt
    const systemPrompt = buildSystemPrompt(user || undefined, memory || undefined, isTelegram);

    // Set headers for SSE streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const result = streamText({
      model,
      messages: processedMessages as any, // Use processed messages (saves tokens)
      tools,
      stopWhen: stepCountIs(5),
      system: systemPrompt,
      temperature: 0.6,
    });

    // Stream all events including tool calls
    let totalTokensUsed = 0;
    for await (const chunk of result.fullStream) {
      // Track token usage
      if (chunk.type === 'finish' && 'usage' in chunk && chunk.usage) {
        const usage = chunk.usage as { totalTokens?: number };
        totalTokensUsed = usage.totalTokens || 0;
      }

      // Send each event as SSE
      const event = JSON.stringify(chunk);
      res.write(`data: ${event}\n\n`);
    }

    // Adjust credits based on actual usage (we already reserved 1 credit)
    if (user && req.user && creditsReserved) {
      try {
        // Calculate actual credits used (1 credit per ~1000 tokens, minimum 1)
        const actualCreditsUsed = Math.max(1, Math.ceil(totalTokensUsed / 1000));

        // We already deducted 1 credit, so calculate the difference
        const creditAdjustment = 1 - actualCreditsUsed; // Positive = refund, Negative = charge more

        let updatedUser = user;

        if (creditAdjustment !== 0) {
          // Adjust credits atomically
          updatedUser = await User.findByIdAndUpdate(
            req.user.id,
            {
              $inc: { 'credits.free': creditAdjustment }
            },
            {
              new: true,
              runValidators: false
            }
          ) || user;

          if (creditAdjustment > 0) {
            console.log(`[Alia/Chat] Refunded ${creditAdjustment} credits. Remaining: ${updatedUser.credits.free}`);
          } else {
            console.log(`[Alia/Chat] Charged ${-creditAdjustment} additional credits. Remaining: ${updatedUser.credits.free}`);
          }
        } else {
          console.log(`[Alia/Chat] Used exactly 1 credit as reserved. Remaining: ${updatedUser.credits.free}`);
        }

        // Ensure credits don't go negative (safety check)
        if (updatedUser.credits.free < 0) {
          updatedUser = await User.findByIdAndUpdate(
            req.user.id,
            { $set: { 'credits.free': 0 } },
            { new: true }
          ) || updatedUser;
        }

        // Send credit update event
        const creditUpdate = {
          type: 'credit-update',
          credits: Math.max(0, updatedUser.credits.free),
          creditsUsed: actualCreditsUsed,
          totalTokens: totalTokensUsed,
        };
        res.write(`data: ${JSON.stringify(creditUpdate)}\n\n`);
      } catch (error) {
        console.error('[Alia/Chat] Error adjusting credits:', error);
      }
    }

    // Send completion marker
    res.write('data: [DONE]\n\n');
    res.end();
    clearTimeout(requestTimeout);

  } catch (e: any) {
    console.error('[Alia/Chat] Error:', e);
    clearTimeout(requestTimeout);
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
