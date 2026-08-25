# Alia

Plataforma de IA multi-proveedor. Agente: `alia`.

La inferencia la sirve **Kaana** (`~/Oxy/Relay`); Alia la consume. Cualquier
adaptador de proveedor o tabla de routing que quede dentro de Alia es
transitorio y se está retirando.

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
