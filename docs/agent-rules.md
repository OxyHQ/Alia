# Reglas del repo para agentes

Reglas que rompen en silencio, con su porqué. `AGENTS.md` lleva el resumen
comprobable; aquí está el texto completo. Antes de tocar un área lee su doc
(índice en [`index.mdx`](./index.mdx)).

- **El backend vive en [OxyHQ/Gemies](https://github.com/OxyHQ/Gemies)** desde el
  2026-11-12 (su [ADR 0034](https://github.com/OxyHQ/Gemies/blob/main/docs/adr/0034-gemies-and-alia.md)):
  la API, integrations, el computer host, sus despliegues, canaries, runbooks y ADRs.
  Un cambio de servidor, de rutas, de eventos del stream, de base de datos o de
  despliegue va allí. Aquí quedan la app, `@gemies/sdk` y `@gemies/server`.
  Las referencias a «ADR 00xx» en el código son la serie de Gemies.
- **Tres papeles (ADR 0010):** Kaana = API de inferencia (solo modelos; las
  credenciales de proveedor viven allí). Oxy = plataforma + Oxy Console (TODAS
  las claves de API). Alia = el asistente; su API de producto la sirve el backend
  en Gemies. Ninguna superficie de este repo guarda credenciales de proveedor ni
  claves de Kaana, y `alia_sk_*` está retirado.
- **La gente elige niveles de potencia, no modelos (ADR 0014; ADR 0012):** en la UI el
  usuario elige un nivel de potencia de Oxy — `auto` (por defecto), `instant`,
  `medium`, `high`, `xhigh`, `pro`, `ultra` — y Oxy escoge el modelo; nunca una
  lista de modelos por nombre. Cero ids de modelo en código o env y cero listas
  curadas: sin nada elegido, la petición no lleva `model` y responde el valor por
  defecto del servidor. `scripts/check-model-defaults.mjs` lo hace cumplir en
  cada cliente.
- **Nombres de modelo y publisher sí se muestran.** El operador que lo sirve
  (Groq, Cerebras, OpenRouter…) y los ids de deployment siguen ocultos en la
  superficie de producto (UI, errores, analítica).
- **La conversación es del SDK (ADR 0018).** El hilo, sus tarjetas, el panel de pensamiento, el
  compositor con su selector de nivel y la llamada de voz los dibuja `GemieChatContent`
  (`@gemies/sdk`), el mismo que monta el bottom sheet. La app solo pone lo suyo (sidebar,
  right panel, layout, rutas, callbacks de host) por props y slots; no copies un componente de
  conversación a `packages/app`. `one-thread.test.tsx` lo comprueba.
- **Un fallo de inferencia llega como error tipado** y el SDK lo pinta como fallo
  (`turn-failure.ts`), nunca como respuesta: ni un mensaje de relleno con
  `finish_reason: "stop"` ni un toast que desaparece; el turno se queda en el hilo
  con su reintento.
- **Ninguna pantalla espera detrás de un spinner ni de un «Loading...»** (`instant-loading.md`):
  lo que se espera se dibuja con el esqueleto de Bloom, con la forma del contenido
  (`src/shared/ui/skeletons`, `ThreadSkeleton` del SDK). El spinner es solo para acciones en
  curso; `__tests__/no-loading-screens.test.ts` lo hace cumplir.
- **`process.env` en Expo:** solo `process.env.EXPO_PUBLIC_*` estático; Metro no
  inlinea otra cosa. Lo hacen cumplir los plugins de `biome-plugins/`.
- **`@gemies/sdk` se publica como código fuente**: el consumidor compila `src/` con su
  Metro o tsc, así que tiene que resolver y tipar en una instalación externa real.
  `check:entries` mantiene la voz detrás de `./voice` y `check:entry-types` compila un
  consumidor de cada entrada por separado.
- `Relay` es un nombre retirado; el único origen de Kaana es `https://kaana.ai`.
