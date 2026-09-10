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
- **Alia no emite claves.** `alia_sk_*` está congelado y se retira; la clave de
  Oxy Console para la API de Alia aún no se valida aquí — no lo documentes como
  si existiera — `docs/developers-portal.md`.
- **Perfiles de routing solo por ID opaco exacto** de
  `packages/api/src/config/oxy-inference-routing-profile-ids.ts`; nunca por
  nombre, slug u orden — `docs/model-abstraction.mdx`.
- **Nombres de operador/modelo upstream nunca en la superficie de producto**
  (respuestas, errores, UI, analítica); sí en catálogo, licencias y auditoría —
  `README.md` § producto.
- `Relay` es un nombre retirado; el único origen de Kaana es `https://kaana.ai`.
  `lib/mcp-relay.ts` es el transporte WebSocket de MCP y no se renombra.
- **Shows** (podcasts en Syra): la ruta acuña un ticket de ingesta de un solo
  uso y el worker lo canjea; jamás un token de servicio. `title`/`topic` son
  overrides opcionales y por eso admiten NULL; `topic` se envía entero —
  `docs/shows.mdx`.
- Agentes, tareas, memoria: `docs/agents.md`. Chat/SSE: `docs/chat-runtime.mdx`.
  Despliegue: `docs/deployment.md`. Migración: `docs/migration/`.
