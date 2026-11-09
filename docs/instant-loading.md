# Carga instantánea

Ninguna pantalla de Alia espera detrás de un spinner ni de un «Loading...». Lo que una pantalla
espera tiene forma (filas, una cabecera, un hilo) y se dibuja con el esqueleto de Bloom, así que
la pantalla ocupa su sitio desde el primer fotograma y nada se mueve cuando llegan los datos.

## Reglas

1. **Un esqueleto con la forma del contenido**, nunca un spinner ni un texto de espera. Los
   esqueletos son compartidos: `src/shared/ui/skeletons` (filas de lista, filas de ajustes, detalle,
   estado de tarjeta de acceso, tarjetas, líneas) y `ThreadSkeleton` del SDK (un hilo de
   conversación). Se componen con `@oxy.so/bloom/skeleton`; no se copian por pantalla.
2. **El spinner es para acciones**: un paso que se está ejecutando, una llamada que conecta, un
   mensaje que se está contestando. Nunca para una pantalla ni para una lista. Las excepciones
   están enumeradas, con su motivo, en `__tests__/no-loading-screens.test.ts`; una nueva es una
   afirmación de que la espera es una acción y se dice allí.
3. **La pantalla se pinta antes de saber qué es.** Un hilo de agente (`/@handle`) dibuja el chat con
   el agente que el sidebar ya conoce y el esqueleto del hilo (`ConversationScreen loading`); el
   compositor solo espera para enviar.
4. **Nada de textos de carga**: no existen claves `*.loading` ni cadenas «Loading»/«Cargando» sobre
   pantallas. El esqueleto se anuncia a los lectores de pantalla con la etiqueta localizada de
   Bloom.

## Por qué es rápido de verdad

- **Caché persistida por cuenta** (`ALIA_ACCOUNT_QUERIES`, `src/shared/api/query-keys.ts`): las
  listas que ve primero quien vuelve (agentes, el hilo de un agente, las conversaciones del
  sidebar, el perfil del agente, las skills) se guardan por cuenta y se pintan al abrir, mientras
  se refrescan detrás. No se persisten los mensajes de una conversación, la facturación ni nada
  firmado. Otra cuenta no puede hidratarlas y cerrar sesión las borra (lo hace Oxy);
  `useAccountLifecycle` descarta las consultas de Alia al cambiar de cuenta.
- **Prefetch por intención**: pasar el ratón o pulsar una fila del sidebar lee su conversación
  (`usePrefetchConversation`) y, en un agente con el que ya se habló, su hilo
  (`usePrefetchAgentThread`). `GET /agents/thread/:username` CREA el hilo la primera vez, así que
  nunca se pide por adelantado de un agente sin conversación.
- **Resultados previos a la vista** (`placeholderData: keepPreviousData`) al cambiar de búsqueda o
  categoría en el catálogo de skills.
- Las consultas de suscripción y de derechos usan `staleTime: 0` y `gcTime: 0` a propósito: un
  estado de pago nunca se muestra de la semana pasada. Su tarjeta, mientras tanto, es un esqueleto.

## Comprobación

`__tests__/no-loading-screens.test.ts` lee el código y falla ante un `ActivityIndicator`, un
`<Loading text=…>`, una clave `*.loading`, una cadena «Loading» en los idiomas o un import de
`Loading` fuera de la lista de acciones.
