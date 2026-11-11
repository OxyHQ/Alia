# Reglas del repo para agentes

Reglas que rompen en silencio, con su porqué. `AGENTS.md` lleva el resumen
comprobable; aquí está el texto completo. Antes de tocar un área lee su doc
(índice en [`index.mdx`](./index.mdx)).

- **Tres papeles (ADR 0010):** Kaana = API de inferencia (solo modelos; las
  credenciales de proveedor viven allí). Oxy = plataforma + Oxy Console (TODAS
  las claves de API: Alia, Kaana, Mention). Alia = asistente con API de producto
  **permanente** (`/alia/chat` y `/v1/*`, un solo handler) que usan sus propias
  superficies (app, Cowork), otras apps Oxy y terceros vía SDK.
- **Texto: `Alia -> Oxy -> Kaana`** con `OxyInferenceClient` de `@oxy.so/core`
  — `adr/0001-*.md`. **Voz y dictado** (ADR 0017): `@kaana.ai/sdk` contra
  `https://kaana.ai/v1`, construido SOLO en `lib/kaana/transport.ts`, con el
  token de servicio de Oxy de audiencia `kaana.ai`. Nunca credenciales de
  proveedor ni claves de Kaana; los límites son de Oxy Console.
- **Alia no emite ni acepta claves propias.** `alia_sk_*` está retirado: la API
  lo rechaza (`credential_retired`) y sus tablas no existen. La clave de Oxy
  Console usa el contrato app-only de core4.4 publicado/adoptado con scopes
  explícitos; aceptación positiva Console pendiente — `machine-chat-contract.md`.
- **La gente elige niveles de potencia, no modelos (ADR 0014; ADR 0012):** Alia no tiene
  modelos propios. En la UI el usuario elige un nivel de potencia de Oxy —
  `auto` (por defecto), `instant`, `medium`, `high`, `xhigh`, `pro`, `ultra` —
  y Oxy escoge el modelo disponible; nunca una lista de modelos por nombre.
  Por API, un `model` exacto `publisher/model` del catálogo de Oxy (o
  `local/...`) sigue valiendo para agentes fijados y llamadas de fondo. Sin
  perfiles `route:*` ni alias propios. Cero ids de modelo en código o env y
  cero listas curadas: destacados, por defecto, utilitario y voz se calculan —
  `model-abstraction.mdx`.
- **Nombres de modelo y publisher sí se muestran.** El operador que lo sirve
  (Groq, Cerebras, OpenRouter…) y los ids de deployment siguen ocultos en la
  superficie de producto (respuestas, errores, UI, analítica).
- **Apps de Oxy = primera parte.** Alia llega a las apps del usuario (Inbox…)
  sin paso de «conectar/autorizar». Un fallo de autoridad llega al modelo como
  `oxy_app_unavailable`, jamás como el motivo crudo de Oxy — `lib/tools/oxy-services.ts`.
- **Apps propias sin scopes/consent/niveles (ADR0022, Oxy ADR0049).** `oxy_*`
  usa la cuenta efectiva del requester, nunca la del dueño por sustitución;
  `self_*` sólo la cuenta bot con operador verificado. Tareas e hijos conservan
  el task id de Oxy del requester original, no su bearer. Servicios propios sólo
  workload; claves/OAuth externos conservan su autoridad limitada.
- **Dónde abre un agente lo dice Oxy (ADR 0021).** `canReachAgent` exige `surfaceApplicationId`,
  la app de la aserción `X-Oxy-App-Assertion` verificada en `lib/app-surface.ts` y nada más; un
  agente confinado no abre sin ella. Una respuesta de Oxy ilegible nunca es «en cualquier sitio».
- **Toda tarea tiene actor; Alia por defecto.** Sin `actorSelection` es
  `{ mode: 'alia' }`: nunca exijas un agente para una tarea. Las de Alia usan su
  autoridad permanente de Oxy y la cola `alia-tasks` —
  `proactive-intelligence.md`.
- **La conversación es del SDK (ADR 0018).** El hilo, sus tarjetas, el panel de pensamiento, el
  compositor con su selector de nivel y la llamada de voz los dibuja `AliaChatContent`
  (`packages/alia-chat`), el mismo que monta el bottom sheet. La app solo pone lo suyo (sidebar,
  right panel, layout, rutas, callbacks de host) por props y slots; no copies un componente de
  conversación a `packages/app`. `one-thread.test.tsx` lo comprueba.
- **Memoria por actor.** Un turno de agente nunca recibe la memoria de Alia ni
  sus herramientas (`saveUserMemory`…); el agente usa `agent_memory_documents`.
- **Un fallo de inferencia es un error tipado** (`failTurn`), antes o después de
  emitir texto; jamás un mensaje de relleno con `finish_reason: "stop"` —
  `chat-runtime.mdx`.
- **Runtime: Bun** para la API y el control del computer host (imagen
  `oven/bun`, CMD `bun ...`); `packages/integrations` y la imagen workspace
  siguen en Node. Todo one-shot que arranca la imagen de la API nombra `bun`
  (`MIGRATION_RUNTIME`, comando post-rollout, canary): un `bun`
  contra una imagen Node muere — `src/__tests__/dockerfileRuntime.test.ts`.
- **Upgrades WebSocket: un solo enrutador** (`lib/websocket-upgrades.ts`). Socket.IO sirve su ruta con
  `destroyUpgrade: false`; voz, relay MCP y cualquier ruta nueva son un `WebSocketRoute`; lo demás
  es 404. Nunca otro `server.on('upgrade')`: en Bun, engine.io cerraba al segundo todo socket ajeno.
  `test:bun-runtime` lo prueba en el runtime real.
- `Relay` es un nombre retirado; el único origen de Kaana es `https://kaana.ai`.
  `lib/mcp-relay.ts` es el transporte WebSocket de MCP y no se renombra.
- **Shows** (podcasts en Syra): la ruta acuña un ticket de ingesta de un solo
  uso y el worker lo canjea; jamás un token de servicio. `title`/`topic` son
  overrides opcionales y por eso admiten NULL; `topic` se envía entero —
  `shows.mdx`.
- **Ninguna pantalla espera detrás de un spinner ni de un «Loading...»** (`instant-loading.md`):
  lo que se espera se dibuja con el esqueleto de Bloom, con la forma del contenido
  (`src/shared/ui/skeletons`, `ThreadSkeleton` del SDK). El spinner es solo para acciones en
  curso; `__tests__/no-loading-screens.test.ts` lo hace cumplir.
- Actores: `actors.mdx`. Agentes y su ordenador: `agents.md`. Tareas y
  avisos: `proactive-intelligence.md`. Memoria: `memory-system.md`.
  Chat/SSE: `chat-runtime.mdx`. Despliegue: `deployment.md`.
  Migración: `migration/`.
