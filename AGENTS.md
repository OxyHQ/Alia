# Alia

El asistente de Oxy («el ChatGPT de Oxy»). Monorepo de bun workspaces: API
(`packages/api`, Express + PostgreSQL), app (`packages/app`, Expo), Codea
(`alia-codea`, `alia-codea-cli`), Cowork (`alia-cowork`), SDK (`alia-chat`).
Antes de tocar un área lee su doc: `docs/index.mdx` es el índice, `docs/adr/`
las decisiones vinculantes. Aquí solo van reglas que rompen en silencio.

## Comandos

```bash
bun install
bun run --filter @alia/api typecheck && bun run --filter @alia/api lint && bun run --filter @alia/api test
bun run --filter @alia/app typecheck && bun run --filter @alia/app test
bun run --filter @alia.onl/sdk typecheck && bun run --filter @alia.onl/sdk test
bun run --filter @alia/api test:pg     # suite con Postgres real; necesita TEST_DATABASE_URL
```

Nunca `bun test` a pelo: los paquetes usan vitest. `bun.lock` va en el mismo
commit que el `package.json` que lo cambia.

## Reglas

- **Tres papeles (ADR 0010):** Kaana = API de inferencia (solo modelos; las
  credenciales de proveedor viven allí). Oxy = plataforma + Oxy Console (TODAS
  las claves de API: Alia, Kaana, Mention). Alia = asistente con API de producto
  **permanente** (`/alia/chat` y `/v1/*`, un solo handler) que usan sus propias
  superficies (app, Codea, Cowork, CLI), otras apps Oxy y terceros vía SDK.
- **Alia nunca llama ni firma a Kaana:** `Alia -> Oxy -> Kaana` con
  `OxyInferenceClient` de `@oxy.so/core`. Sin credenciales de proveedor, sin
  transporte alternativo — `docs/adr/0001-*.md`.
- **Alia no emite ni acepta claves propias.** `alia_sk_*` está retirado: la API
  lo rechaza (`credential_retired`) y sus tablas no existen. La clave de Oxy
  Console tiene un candidato app-only con scopes explícitos; requiere release
  coordinada de Oxy/core y adopción registry — `docs/machine-chat-contract.md`.
- **La gente elige modos, no modelos (ADR 0014; ADR 0012):** Alia no tiene
  modelos propios. En la UI el usuario elige un nivel de potencia de Oxy —
  `auto` (por defecto), `instant`, `medium`, `high`, `xhigh`, `pro`, `ultra` —
  y Oxy escoge el modelo disponible; nunca una lista de modelos por nombre.
  Por API, un `model` exacto `publisher/model` del catálogo de Oxy (o
  `local/...`) sigue valiendo para agentes fijados y llamadas de fondo. Sin
  perfiles `route:*` ni alias propios. Cero ids de modelo en código o env y
  cero listas curadas: destacados, por defecto, utilitario y voz se calculan —
  `docs/model-abstraction.mdx`.
- **Nombres de modelo y publisher sí se muestran.** El operador que lo sirve
  (Groq, Cerebras, OpenRouter…) y los ids de deployment siguen ocultos en la
  superficie de producto (respuestas, errores, UI, analítica).
- **Apps de Oxy = primera parte.** Alia llega a las apps del usuario (Inbox…)
  sin paso de «conectar/autorizar». Un fallo de autoridad llega al modelo como
  `oxy_app_unavailable`, jamás como el motivo crudo de Oxy — `lib/tools/oxy-services.ts`.
- **Los datos del dueño, solo con el dueño presente.** Las apps de Oxy de un
  agente son las de su dueño; `requesterAccountId` del pipeline decide y un
  extraño (bot del agente, agente público) nunca las recibe.
- `Relay` es un nombre retirado; el único origen de Kaana es `https://kaana.ai`.
  `lib/mcp-relay.ts` es el transporte WebSocket de MCP y no se renombra.
- **Shows** (podcasts en Syra): la ruta acuña un ticket de ingesta de un solo
  uso y el worker lo canjea; jamás un token de servicio. `title`/`topic` son
  overrides opcionales y por eso admiten NULL; `topic` se envía entero —
  `docs/shows.mdx`.
- Agentes, tareas, memoria: `docs/agents.md`. Chat/SSE: `docs/chat-runtime.mdx`.
  Despliegue: `docs/deployment.md`. Migración: `docs/migration/`.
