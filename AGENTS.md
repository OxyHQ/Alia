# Alia

Plataforma de IA multi-proveedor. Agente: `alia`.

**Kaana es el proveedor de inferencia que Alia consume; Alia no aloja lógica de
proveedor.** Es el único nombre que se usa dentro de Alia: módulos, tipos,
comentarios, docs y el campo `kaana` de `/health`. Cualquier adaptador de
proveedor o tabla de routing que quede dentro de Alia es transitorio y se está
retirando.

`Relay` fue su nombre de trabajo y sobrevive **sólo** donde el nombre no lo
decide Alia: el repositorio (`~/Oxy/Relay`), sus recursos de AWS, las cabeceras
firmadas `X-Oxy-Relay-*` con el separador de dominio `oxy-relay-envelope:v1`, el
host `relay.oxy.so` y las variables de entorno `ALIA_RELAY_*` / `RELAY_BASE_URL`
que la task definition viva ya declara. Renombrar cualquiera de esos es un
cambio coordinado con infraestructura o con Kaana, nunca un renombrado dentro de
este repo. `lib/mcp-relay.ts` es otro sistema — el relay WebSocket de MCP — y no
tiene nada que ver.

Los **shows** son series de podcast publicadas en **Syra** (`syra.fm`), no audio
guardado en Alia. El worker que las produce no lleva credencial de usuario y Syra
solo acepta el JWT de una persona, así que la ruta acuña un **ticket de ingesta
de un solo uso** y el worker lo canjea: no lo sustituyas por un token de
servicio — esa delegación está cerrada en todo Oxy hasta que aterrice ADR 0012.

Pedir un episodio **no pregunta nada**: el brief de la serie y los temas ya
usados deciden de qué va, y el guion terminado le pone nombre.
`show_episodes.topic` es una línea por episodio y se manda ENTERO — la ventana
de recaps sola es justo lo que hace que un show se repita en el episodio nueve.
`title` y `topic` son OVERRIDES opcionales, no defaults rivales, y por eso las
dos columnas admiten NULL: guardar un placeholder haría indistinguible «lo
nombró su dueño» de «todavía no tiene nombre». Detalle en `docs/shows.mdx`.

**Antes de tocar nada, lee `docs/`.** Ahí está lo que este fichero no cuenta:
arquitectura, decisiones (`docs/adr/`), despliegue y migraciones. Las normas de
ingeniería comunes se cargan solas desde `~/AGENTS.md` y `~/Oxy/AGENTS.md`; las
versiones están en `package.json`, nunca aquí.
