# Carga instantánea

Ninguna pantalla de Alia espera detrás de un spinner ni de un «Loading...». Lo que una pantalla
espera tiene forma (filas, una cabecera, un hilo) y se dibuja con el esqueleto de Bloom, así que
la pantalla ocupa su sitio desde el primer fotograma y nada se mueve cuando llegan los datos.

## Reglas

1. **Un esqueleto con la forma del contenido**, nunca un spinner ni un texto de espera. Los
   esqueletos son compartidos: `src/shared/ui/skeletons` (filas de lista, filas de ajustes, detalle,
   estado de tarjeta de acceso, tarjetas) y `ThreadSkeleton` del SDK (un hilo de
   conversación). Se componen con `@oxy.so/bloom/skeleton`; no se copian por pantalla.
2. **El spinner es para acciones**: un paso que se está ejecutando, una llamada que conecta, un
   mensaje que se está contestando. Nunca para una pantalla ni para una lista. Las excepciones
   están enumeradas, con su motivo, en `__tests__/no-loading-screens.test.ts`; una nueva es una
   afirmación de que la espera es una acción y se dice allí.
3. **La pantalla se pinta antes de saber qué es.** Una conversación abierta (`/c/:id`) dibuja su
   cabecera y el esqueleto del hilo desde el primer fotograma; el compositor solo espera para
   enviar.
4. **Nada de textos de carga**: no existen claves `*.loading` ni cadenas «Loading»/«Cargando» sobre
   pantallas. El esqueleto se anuncia a los lectores de pantalla con la etiqueta localizada de
   Bloom.
5. **Los datos de una pantalla son una consulta** (React Query), nunca un `fetch` desde un
   `useEffect` a un `useState`: la consulta sirve lo que ya hay (esta sesión o la caché de la
   cuenta) y lo refresca detrás. Una consulta que dibuja una pantalla no lleva `gcTime: 0`, que la
   tiraría al desmontarse, y una pantalla que espera dibuja su esqueleto, nunca `null`.

## Por qué es rápido de verdad

- **Caché persistida por cuenta** (`ALIA_ACCOUNT_QUERIES`, `src/shared/api/query-keys.ts`): las
  listas que ve primero quien vuelve (las conversaciones del sidebar, el perfil de un gemie que el
  chat dibuja, las skills) se guardan por cuenta y se pintan al abrir, mientras
  se refrescan detrás. No se persisten la facturación ni nada firmado. Otra cuenta no puede hidratarlas y cerrar sesión las borra (lo hace Oxy);
  `useAccountLifecycle` descarta las consultas de Alia al cambiar de cuenta.
- **Los mensajes recientes de las conversaciones recientes también**, acotados
  (`src/shared/api/persisted-conversations.ts`): las 20 conversaciones actualizadas más
  recientemente, de cada una sus últimos 40 mensajes, como mucho 150 KB por conversación, solo
  texto (una imagen puede ser un data URL o una URL firmada que caduca) y nunca un turno que se
  está emitiendo o que el servidor aún no guardó. Las demás no se escriben y salen de memoria si
  nadie las mira. Volver a una conversación la pinta al instante y la refresca detrás. Van en la
  caché de la cuenta, como el resto: nunca las lee otra cuenta del dispositivo (Alia, Mention y
  Commons comparten UID en Android, así que la clave es la cuenta, no la app), un cambio de cuenta
  las saca de memoria y cerrar sesión las borra.
- **La caché sobrevive a los despliegues**: `ALIA_ACCOUNT_QUERIES.dataVersion` es
  `PERSISTED_DATA_STAMP` (`src/shared/api/persisted-data-version.ts`: la versión de la forma de lo
  persistido más la de `@gemies/sdk`). `@oxy.so/services` solo tira la caché cuando cambia ese
  sello o su propia versión. Si cambia un tipo de lo persistido, `__tests__/persisted-data-version.test.ts`
  falla hasta que se sube la versión: un olvido es un test rojo, no una pantalla rota.
- **Prefetch por intención**: pasar el ratón o pulsar una fila del sidebar lee su conversación
  (`usePrefetchConversation`).
- **Resultados previos a la vista** (`placeholderData: keepPreviousData`) al cambiar de búsqueda o
  categoría en el catálogo de skills.
- **La caché vive tanto en memoria como en disco**: `@oxy.so/services` 14.19.3 da a las raíces
  persistidas `gcTime: Infinity`. Antes salían de memoria a la media hora sin mirarlas, y con
  ellas del siguiente snapshot, así que «persistido» era «visto en la última media hora».
- **Facturación, créditos y derechos** se piden de nuevo en cada montaje (`staleTime: 0`) y nunca
  se escriben a disco (un estado de pago no se muestra de la semana pasada), pero la última
  respuesta de esta sesión se dibuja mientras tanto, en vez de un esqueleto en cada visita.
- **Conectores, Seguridad y Estilo de escritura** son consultas (`queryKeys.mcp`, `.audit`,
  `.writingStyle`), en memoria: la lista de conectores la leen el compositor de cada chat y
  Ajustes, y se pide una vez.

## Comprobación

`__tests__/no-loading-screens.test.ts` lee el código y falla ante un `ActivityIndicator`, un
`<Loading text=…>`, una clave `*.loading`, una cadena «Loading» en los idiomas o un import de
`Loading` fuera de la lista de acciones. `__tests__/screens-draw-from-cache.test.ts` falla ante un
`useEffect` que pide datos, un `gcTime: 0` o un `return null` mientras carga, salvo las excepciones
que enumera con su motivo.
