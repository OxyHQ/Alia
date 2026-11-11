# Alia

El asistente de Oxy («el ChatGPT de Oxy»): API Express + PostgreSQL, app Expo, Codea, Cowork y SDK, en un monorepo de bun workspaces.

## Comandos

```bash
bun install
bun run lint                                          # Biome; CI: bunx biome ci .
bun run --filter @alia/api typecheck && bun run --filter @alia/api test
bun run --filter @alia/app typecheck && bun run --filter @alia/app test
bun run --filter @alia.onl/sdk typecheck && bun run --filter @alia.onl/sdk test
bun run --filter @alia/api test:pg                    # Postgres real; necesita TEST_DATABASE_URL
bun run dev:api                                       # también dev:app, dev:codea, dev:cowork
```

## Mapa

- Índice: [`docs/index.mdx`](./docs/index.mdx). Quién actúa: [`docs/actors.mdx`](./docs/actors.mdx). Decisiones vinculantes: [`docs/adr/`](./docs/adr).
- Reglas completas con su porqué: [`docs/agent-rules.md`](./docs/agent-rules.md).
- Chat/SSE: [`docs/chat-runtime.mdx`](./docs/chat-runtime.mdx). Agentes: [`docs/agents.md`](./docs/agents.md). Tareas: [`docs/proactive-intelligence.md`](./docs/proactive-intelligence.md). Memoria: [`docs/memory-system.md`](./docs/memory-system.md). Despliegue: [`docs/deployment.md`](./docs/deployment.md).
- Autoridad del requester entre productos: [`docs/requester-authority.md`](./docs/requester-authority.md).

## Convenciones que difieren de lo habitual

- Usa `bun run --filter <pkg> test`, nunca `bun test` a pelo: los paquetes usan vitest.
- Biome sustituye a ESLint/Prettier; `@ts-nocheck` y `@ts-expect-error` sin descripción los vigila `scripts/check-ts-directives.mjs` en CI.
- Sobre `process.env` en Expo, solo `process.env.EXPO_PUBLIC_*` estático (Metro no inlinea otra cosa); lo hacen cumplir los plugins de `biome-plugins/`.
- `bun.lock` va en el mismo commit que el `package.json` que lo cambia.
- Un `model` o id de proveedor nunca va fijo en código o env; los niveles de potencia los resuelve Oxy ([`docs/model-abstraction.mdx`](./docs/model-abstraction.mdx)).
- Cada one-shot que arranca la imagen de la API nombra `bun`; la imagen es Bun, no Node.
- Una pantalla nunca espera tras un spinner: usa el esqueleto de Bloom (`__tests__/no-loading-screens.test.ts`).
- Los fallos de inferencia son errores tipados (`failTurn`), nunca un mensaje de relleno con `finish_reason: "stop"`.

## Límites

Nunca:
- Credenciales de proveedor ni claves de Kaana en Alia, ni claves `alia_sk_*` (retiradas): las claves viven en Oxy Console.
- Un hostname de Kaana distinto de `https://kaana.ai`.
- Otro `server.on('upgrade')`: Bun cierra los sockets ajenos; todo upgrade pasa por `lib/websocket-upgrades.ts`.
- Copiar un componente de conversación a `packages/app`: viene de `AliaChatContent` en `packages/alia-chat` (ADR 0018).
- Pasar a un agente la memoria de Alia o sus herramientas.
- Exigir un agente para una tarea: sin `actorSelection` es `{ mode: 'alia' }`.

Pregunta antes de: cambiar un contrato entre productos Oxy, añadir una ruta WebSocket o tocar `lib/tools/oxy-services.ts`; ver `docs/agent-rules.md` para cada regla.

## Pruebas

- Cambio en `packages/api`: typecheck + test de `@alia/api`; si toca la base de datos, también `test:pg`.
- Cambio en `packages/app` o el SDK: typecheck + test de ese paquete.
- Hecho = `bun run lint` y los tests del paquete tocado en verde, con CI verde en el PR.
- Verifica con ejecuciones dirigidas del paquete afectado, no solo con la suite completa.

## PR y commits

- PR contra `main`; no publiques a npm desde un portátil: fusionar el bump de versión en `main` publica (CI + OIDC), ver [npm-releases](https://github.com/OxyHQ/oxy/blob/main/docs/npm-releases.md).
- Formato y lint: [lint-and-format](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/lint-and-format.md). Estándares: [standards](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/standards.md).

## Secretos

Vienen del entorno (`.env`, secretos de ECS), nunca se imprimen ni se commitean; `TEST_DATABASE_URL` solo apunta a una base de pruebas.

Owner: OxyHQ. Last reviewed: 2026-11-11.
