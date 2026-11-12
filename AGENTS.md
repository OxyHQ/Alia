# Alia

La app del asistente de Oxy («el ChatGPT de Oxy»): app Expo (web, iOS y Android) y, mientras sus consumidores los necesiten, los paquetes publicados `@alia.onl/sdk` y `@alia.onl/server`, en un monorepo de bun workspaces.

**El backend vive en [OxyHQ/Gemies](https://github.com/OxyHQ/Gemies)** desde el 2026-11-12 (su [ADR 0034](https://github.com/OxyHQ/Gemies/blob/main/docs/adr/0034-gemies-and-alia.md)): la API (`api.alia.onl`), integrations, el computer host, sus despliegues, canaries, runbooks y ADRs. **Los cambios de backend van a OxyHQ/Gemies**, nunca a este repo.

## Comandos

```bash
bun install
bun run lint                                          # Biome; CI: bunx biome ci .
bun run --filter @alia/app typecheck && bun run --filter @alia/app test
bun run --filter @alia.onl/sdk typecheck && bun run --filter @alia.onl/sdk test
bun run --filter @alia.onl/server typecheck && bun run --filter @alia.onl/server test
bun run dev:app
```

## Mapa

- Índice: [`docs/index.mdx`](./docs/index.mdx). Decisiones vinculantes: los [ADRs de Gemies](https://github.com/OxyHQ/Gemies/tree/main/docs/adr); «ADR 00xx» en el código es esa serie.
- Reglas completas con su porqué: [`docs/agent-rules.md`](./docs/agent-rules.md).
- Arquitectura de la app: [`docs/app-architecture.mdx`](./docs/app-architecture.mdx). Contrato del SDK: [`docs/agent-embedding.md`](./docs/agent-embedding.md). Carga: [`docs/instant-loading.md`](./docs/instant-loading.md). Validación nativa: [`docs/native-validation.mdx`](./docs/native-validation.mdx).
- Chat/SSE, modelos y niveles de potencia, voz, agentes, despliegue del backend: en la [documentación de Gemies](https://github.com/OxyHQ/Gemies/blob/main/docs/index.mdx).

## Convenciones que difieren de lo habitual

- Usa `bun run --filter <pkg> test`, nunca `bun test` a pelo: los paquetes usan vitest.
- Biome sustituye a ESLint/Prettier; `@ts-nocheck` y `@ts-expect-error` sin descripción los vigila `scripts/check-ts-directives.mjs` en CI.
- Sobre `process.env` en Expo, solo `process.env.EXPO_PUBLIC_*` estático (Metro no inlinea otra cosa); lo hacen cumplir los plugins de `biome-plugins/`.
- `bun.lock` va en el mismo commit que el `package.json` que lo cambia.
- Un `model` o id de proveedor nunca va fijo en código o env; los niveles de potencia los resuelve Oxy (`scripts/check-model-defaults.mjs`).
- Una pantalla nunca espera tras un spinner: usa el esqueleto de Bloom (`__tests__/no-loading-screens.test.ts`).
- Un fallo de inferencia se pinta como error tipado con reintento (`turn-failure.ts` del SDK), nunca como respuesta.

## Límites

Nunca:
- Cambios de backend (API, integrations, computer host, sus Dockerfiles o despliegues) en este repo: van a OxyHQ/Gemies.
- Credenciales de proveedor ni claves de Kaana en Alia, ni claves `alia_sk_*` (retiradas): las claves viven en Oxy Console.
- Un hostname de Kaana distinto de `https://kaana.ai`.
- Copiar un componente de conversación a `packages/app`: viene de `AliaChatContent` en `packages/alia-chat` (ADR 0018).
- Importar código de la API o leer sus ficheros desde la app, el SDK o el server: el servidor está en otro repo.

Pregunta antes de: cambiar un contrato entre productos Oxy o la superficie pública de `@alia.onl/sdk` o `@alia.onl/server`; ver `docs/agent-rules.md` para cada regla.

## Pruebas

- Cambio en `packages/app`, el SDK o el server: typecheck + test de ese paquete (en el SDK también `test:metro`, `check:entries` y `check:entry-types`; en el server, `check:entrypoints` tras `build`).
- Hecho = `bun run lint` y los tests del paquete tocado en verde, con CI verde en el PR.
- Verifica con ejecuciones dirigidas del paquete afectado, no solo con la suite completa.

## PR y commits

- PR contra `main`; no publiques a npm desde un portátil: fusionar el bump de versión en `main` publica (CI + OIDC), ver [npm-releases](https://github.com/OxyHQ/oxy/blob/main/docs/npm-releases.md).
- Formato y lint: [lint-and-format](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/lint-and-format.md). Estándares: [standards](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/standards.md).

## Secretos

Vienen del entorno (`.env`, secretos de GitHub), nunca se imprimen ni se commitean.

Owner: OxyHQ. Last reviewed: 2026-11-12.
