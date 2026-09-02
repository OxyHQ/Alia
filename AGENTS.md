# Alia

Producto de IA sobre Oxy y Kaana. Agente: `alia`.

**Kaana es el plano de inferencia de Alia, pero Alia nunca lo llama ni lo firma
directamente.** Alia usa `@oxyhq/core` (`OxyInferenceClient`) con una credencial
de servicio: `Alia -> Oxy -> Kaana`. Oxy resuelve identidad y rutas autorizadas;
Alia no aloja lógica ni credenciales de proveedor, claves de firma de Kaana o
un transporte alternativo.

El antiguo nombre de trabajo `Relay` está retirado. El repositorio es
`~/Oxy/Kaana`; no se admiten aliases de compatibilidad. `lib/mcp-relay.ts`
es otro sistema — el relay WebSocket de MCP — y conserva ese nombre porque
describe el protocolo que implementa.

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
