# Alia

La app del asistente de Oxy («el ChatGPT de Oxy»): app Expo (web, iOS y Android) que habla con el gemie Alia a través de `@gemies/sdk`, instalado desde npm, en un monorepo de bun workspaces con un solo paquete (`packages/app`).

**El backend vive en [OxyHQ/Gemies](https://github.com/OxyHQ/Gemies)** desde el 2026-11-12 (su [ADR 0034](https://github.com/OxyHQ/Gemies/blob/main/docs/adr/0034-gemies-and-alia.md)): la API (`api.gemies.ai`), integrations, el computer host, sus despliegues, canaries, runbooks y ADRs, y también el SDK (`@gemies/sdk`) y el cliente de servidor (`@gemies/server`). **Los cambios de backend y de SDK van a OxyHQ/Gemies**, nunca a este repo; aquí solo se sube la versión de `@gemies/sdk`.

## Comandos

```bash
bun install
bun run lint                                          # Biome; CI: bunx biome ci .
bun run --filter @alia/app typecheck && bun run --filter @alia/app test
bun run dev:app
```

## Mapa

- Índice: [`docs/index.mdx`](./docs/index.mdx). Decisiones vinculantes: los [ADRs de Gemies](https://github.com/OxyHQ/Gemies/tree/main/docs/adr); «ADR 00xx» en el código es esa serie.
- Reglas completas con su porqué: [`docs/agent-rules.md`](./docs/agent-rules.md).
- Arquitectura de la app: [`docs/app-architecture.mdx`](./docs/app-architecture.mdx). Contrato del SDK: [`agent-embedding.md` de Gemies](https://github.com/OxyHQ/Gemies/blob/main/docs/agent-embedding.md). Carga: [`docs/instant-loading.md`](./docs/instant-loading.md). Validación nativa: [`docs/native-validation.mdx`](./docs/native-validation.mdx).
- Chat/SSE, modelos y niveles de potencia, voz, agentes, despliegue del backend: en la [documentación de Gemies](https://github.com/OxyHQ/Gemies/blob/main/docs/index.mdx).

## Convenciones que difieren de lo habitual

- Usa `bun run --filter <pkg> test`, nunca `bun test` a pelo: la app usa vitest.
- Biome sustituye a ESLint/Prettier; `@ts-nocheck` y `@ts-expect-error` sin descripción los vigila `scripts/check-ts-directives.mjs` en CI.
- Sobre `process.env` en Expo, solo `process.env.EXPO_PUBLIC_*` estático (Metro no inlinea otra cosa); lo hacen cumplir los plugins de `biome-plugins/`.
- `bun.lock` va en el mismo commit que el `package.json` que lo cambia.
- Un `model` o id de proveedor nunca va fijo en código o env; los niveles de potencia los resuelve Oxy (`scripts/check-model-defaults.mjs`).
- Una pantalla nunca espera tras un spinner: usa el esqueleto de Bloom (`__tests__/no-loading-screens.test.ts`).
- Un fallo de inferencia se pinta como error tipado con reintento (`turn-failure.ts` de `@gemies/sdk`), nunca como respuesta.

## Límites

Nunca:
- Cambios de backend (API, integrations, computer host, sus Dockerfiles o despliegues) o del SDK en este repo: van a OxyHQ/Gemies.
- Credenciales de proveedor ni claves de Kaana en Alia, ni claves `alia_sk_*` (retiradas): las claves viven en Oxy Console.
- Un hostname de Kaana distinto de `https://kaana.ai`.
- Copiar un componente de conversación a `packages/app`: viene de `GemieChatContent` en `@gemies/sdk` (ADR 0018).
- Importar código de la API o leer sus ficheros desde la app: el servidor está en otro repo.

Pregunta antes de: cambiar un contrato entre productos Oxy; ver `docs/agent-rules.md` para cada regla.

## Pruebas

- Cambio en `packages/app`: typecheck + test de la app.
- Hecho = `bun run lint` y los tests del paquete tocado en verde, con CI verde en el PR.
- Verifica con ejecuciones dirigidas del paquete afectado, no solo con la suite completa.

## PR y commits

- PR contra `main`. Este repo no publica nada a npm.
- Formato y lint: [lint-and-format](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/lint-and-format.md). Estándares: [standards](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/standards.md).

## Secretos

Vienen del entorno (`.env`, secretos de GitHub), nunca se imprimen ni se commitean.

Owner: OxyHQ. Last reviewed: 2026-11-12.
