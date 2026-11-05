# SOLUCIÓN — Reto 01: Agente "Registro como Proveedor"

## 1. Problema en una frase

La analista administrativa transcribe a mano, campo por campo, datos que ya existen en el repositorio interno para responder 8 a 12 solicitudes de registro como proveedor al mes; le duele a ella (retrabajo y errores en datos sensibles como NIT o cuenta bancaria) y a la empresa (facturación retrasada y dependencia de una persona).

## 2. Arquitectura

```
┌──────────────┐  HTTP   ┌──────────── Backend Hono (Vercel Functions) ────────────┐
│ web/  chat   │ ──────▶ │ src/server.ts    /api/chat · /api/sessions · /api/health │
│ - historial  │ ◀────── │ src/core/loop.ts ciclo: modelo ↔ herramientas, topes     │
│ - tool calls │         │ src/core/confirm.ts  puerta de confirmación               │
│ - confirmar  │         │ src/llm/*        LlmAdapter: Anthropic · OpenAI · Gemini  │
└──────────────┘         │ src/core/registry.ts + src/tools/proveedor.ts (zod)      │
                         │        └─ src/domain/  mapeo · vigencias · xlsx/pdf       │
                         └───────────────┬──────────────────────┬──────────────────┘
                                         │                      │
                              fixtures/ (solo lectura)   Storage: out/ en disco (local)
                                                         o Vercel Blob privado (producción)
```

| Capa | Dónde vive | Qué contiene |
| --- | --- | --- |
| Comportamiento | `agent/prompt.md` | Orden de pasos, formato de respuesta, reglas que no se rompen. |
| Conocimiento | `src/knowledge/registro-proveedor.md` | Estados de campo, RN1–RN5, soportes, formatos. |
| Ejecución | `src/tools/proveedor.ts` → `src/domain/` | Herramientas tipadas con zod y lógica determinista. |

Un cambio de reglas de negocio toca `src/domain/` o `src/knowledge/`, nunca `src/server.ts`. El núcleo (`src/core/`, `src/llm/`, `src/server.ts`, `web/`) no sabe nada de proveedores ni formularios.

## 3. Ciclo del agente

1. `POST /api/chat` exige sesión iniciada por `/login` y carga la sesión del usuario desde el `Storage` (`sessions/<id>.json`); las herramientas trabajan en el espacio `out/<sessionId>/` de esa sesión, para que funcione aunque cada request caiga en otra instancia de Vercel.
2. Si la sesión tenía una confirmación pendiente y el mensaje responde «sí» o «confirmo» (o es el botón Confirmar), esa confirmación vale **solo para este turno** y solo para la acción y la referencia que se preguntaron. Los verbos de orden («envía», «registra», «crea») son pedidos, no confirmaciones; cualquier otro mensaje descarta la pendiente.
3. El ciclo llama al modelo con el historial y las herramientas. Si el modelo pide herramientas, el registro valida los argumentos con zod (un error de validación vuelve al modelo como resultado), ejecuta la herramienta dentro de `safe()` (nunca lanza) y registra la llamada en `out/log.jsonl` y `out/<caso>/log.jsonl`.
4. **Confirmación humana (CA3 / RN4):** el modelo pide confirmación llamando a la pseudo-herramienta `agente_solicitar_confirmacion`. La política del reto valida la acción contra el estado real y el código arma la pregunta, con una advertencia fuerte si el paquete u OC no está listo; el ciclo termina el turno, guarda la acción pendiente y responde con `needsConfirmation: true`; el front muestra un banner con botones Confirmar / Cancelar. Cualquier herramienta llamada con `confirmado: true` sin una confirmación válida para ese caso en el turno actual se rechaza en el registro con «requiere confirmación explícita», aunque el modelo se equivoque.
5. **Topes:** `MAX_ITERACIONES` (25) por turno, `MAX_TOKENS_SESION` por sesión, `LLM_TIMEOUT_MS` por llamada y un presupuesto de 270 s por turno (la función de Vercel tiene 300 s). Al llegar a un tope, el agente responde con lo que hizo y lo que falta.
6. **Errores (CA5):** un error del proveedor (clave inválida, límite de tasa, timeout) se traduce a un mensaje claro en el chat; la sesión sigue viva.

## 4. Elección del modelo

El agente es **agnóstico de proveedor**: `LLM_PROVIDER` elige entre Anthropic, OpenAI y Gemini, y `LLM_MODEL` el modelo. Los tres adaptadores implementan la misma interfaz `enviar(mensajes, herramientas)` y traducen el historial neutro al formato de cada API; `tests/llm-contrato.test.ts` verifica que el mismo historial se traduce sin perder llamadas ni resultados.

- **Por defecto:** Anthropic `claude-opus-5-5` con esfuerzo `medium`. Sigue bien instrucciones de varios pasos con herramientas y respeta reglas como «no afirmes valores que no salgan de una herramienta». El adaptador activa la caché automática del prefijo y el reintento del lado del servidor si un clasificador de seguridad rechaza la solicitud.
- **Por qué alcanza un esfuerzo medio:** el modelo solo orquesta y redacta. Toda la lógica (mapeo, vigencias, documentos) es determinista en las herramientas.

**Costo estimado por caso** (procesar un caso completo: ~5 llamadas al modelo, ~45 000 tokens de entrada acumulados y ~3 000 de salida), con los precios de Claude Opus 5.5 ($4 por millón de tokens de entrada y $20 por millón de salida):

| Escenario | Cálculo | Costo aproximado |
| --- | --- | --- |
| Sin caché | 45 000 × $4/M + 3 000 × $20/M | ≈ US$0,24 |
| Con caché del prefijo | la mayor parte de la entrada se lee de caché a $0,20/M | ≈ US$0,10 |

Es una estimación; el costo real se mide con el campo `uso` que devuelve `/api/chat` en cada turno. **Medición real** del despliegue actual (OpenAI `gpt-5.5`): el prompt de la sección 11 consumió unos 20 000 tokens de entrada y 1 400 de salida en el primer turno, y unos 9 000 y 200 en el turno de envío. El costo con OpenAI depende de la tarifa vigente de ese modelo.

## 5. Diseño del portal web (formato «portal con usuario y contraseña»)

**Estrategia.** Un navegador controlado (Playwright) que el agente maneja con un guion por portal: abrir la URL, esperar a que la persona inicie sesión, ubicar cada campo por su etiqueta visible y llenarlo con los valores del mapeo, y subir los soportes. Se prefiere a una extensión de navegador (exige instalarla en cada equipo) y a RPA de escritorio (más frágil y costoso). El guion de cada portal se guarda como conocimiento versionado, igual que las plantillas.

**Límites.** CAPTCHA y MFA no se automatizan: los resuelve la persona en la misma ventana. Si cambia el diseño del portal, el agente no encuentra una etiqueta y se detiene; en ese caso se cae al modo actual: `valores-portal.md` listo para copiar. Los portales con sesiones cortas obligan a llenar en una sola pasada.

**Credenciales.** Nunca en el repositorio, el prompt ni los logs. Viven en el gestor de secretos de la empresa (por ejemplo un vault con acceso por rol) y las ingresa la analista directamente en el navegador; el agente no las ve. Si en el futuro se automatiza el inicio de sesión, el navegador las toma del vault en el momento de usarlas, fuera del contexto del modelo, y los logs enmascaran cualquier campo de tipo contraseña.

**Reparto de tareas.**

| Paso | Quién |
| --- | --- |
| Ingresar usuario, contraseña, CAPTCHA y MFA | Humano |
| Llenar campos y adjuntar soportes | Agente |
| Revisar el formulario lleno en pantalla | Humano |
| Pulsar «Enviar» | Humano |

Hoy, para `pa-logistica-istmo`, el agente responde «formato no soportado» y produce `out/pa-logistica-istmo/valores-portal.md`.

## 6. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
| --- | --- | --- |
| La pregunta de confirmación la arma el código desde la acción pendiente (con advertencia si no está lista) y solo «sí»/«confirmo» o el botón la aceptan | Dejar que el modelo redacte la pregunta y aceptar verbos como «envía», «registra» o «crea» | Revisión del reto-01: una orden es un pedido, no una confirmación, y la advertencia de un paquete u OC incompleto no puede depender del texto del modelo. |
| Estado por sesión en la web: cada sesión trabaja en `out/<sessionId>/`, que parte de cero y pertenece al usuario que ingresó; `demo.ts` sigue escribiendo en `out/` | Un único `out/` compartido en Blob | Revisión: en producción todas las sesiones compartían el estado, así que la demo de la sección 11 no se podía reproducir. |
| Ingreso propio con usuario y contraseña (`/login`), cookie `HttpOnly`/`Secure`/`SameSite=Lax` firmada con HMAC y vencimiento de 8 h | `ACCESS_KEY` en una cabecera o en la URL; Vercel Deployment Protection | Una pantalla de ingreso es lo esperable para un evaluador, la clave no viaja en la URL y las sesiones quedan asociadas a un usuario. |
| Mapeo determinista: glosario normalizado y similitud de palabras con umbrales 0.8 / 0.5 | Pedirle al modelo que mapee etiquetas | El modelo podría «completar» un campo con un valor plausible (riesgo del PRD). Con reglas, el resultado es trazable, testeable y la demo corre sin clave. |
| El estado del caso (mapeo, formulario, soportes) lo guarda la herramienta; `generar_formulario` ignora el mapeo que manda el modelo | Usar el `mapeo` recibido como argumento | Evita que el modelo altere un valor entre mapear y generar (CA2 por diseño). |
| Confirmación garantizada en el registro de herramientas, con una pseudo-herramienta para pedirla | Solo una instrucción en el prompt | El prompt puede fallar; el código no deja ejecutar `confirmado: true` sin un «sí» del usuario en el turno anterior. |
| Tres adaptadores nativos detrás de `LlmAdapter` | Un SDK multi-proveedor (Vercel AI SDK, LangChain) | El PRD pide una interfaz propia; tres implementaciones explícitas muestran que cambiar de proveedor no toca el ciclo. |
| Vercel con `Storage` intercambiable (disco en local, Blob privado en producción) | Servidor con disco persistente (Railway, Fly.io) | Decisión del equipo de desplegar en Vercel. Como el disco de la función es efímero y las instancias no se garantizan entre requests, las sesiones y `out/` se guardan en Blob. |
| PDF generado con `pdf-lib` (etiqueta y valor en orden) | Rellenar un AcroForm | El PRD lo acepta y no hay PDF original del cliente en los fixtures. |

## 7. Supuestos

- La fecha de referencia para vigencias es la fecha de ejecución (hoy, hora de Colombia), como pide HU-4; `FECHA_REFERENCIA` la fija si hace falta reproducir otra fecha. Con la fecha de hoy la Cámara de Comercio (vigente hasta 2026-09-30) está vencida, así que **ningún caso queda listo para firma**; con `FECHA_REFERENCIA=2026-09-03` quedan listos `co-industrias-delta` y `pa-logistica-istmo`.
- «Enviar» se permite aunque el paquete no esté listo para firma, porque el PRD espera `ENVIO-SIMULADO.md` para `ec-corp-andina` (que no está listo). Procesar un caso no deja el envío pendiente: solo «envía» lo propone, el código arma la pregunta con una advertencia fuerte y la lista de pendientes, y solo un «sí»/«confirmo» lo ejecuta. El archivo deja constancia de los pendientes.
- El borrador de correo solo adjunta soportes vigentes (y solo esos se copian al paquete). Si el paquete no está listo, va encabezado con «BORRADOR — no enviar» y los pendientes, y no dice «firmado». `proveedor_armar_paquete` devuelve el texto del borrador, que no contiene datos bancarios.
- Rearmar un paquete lo regenera desde cero y borra cualquier `ENVIO-SIMULADO.md` anterior.
- El país se llena con el código del maestro (`CO`) y los ingresos anuales con una nota de moneda y año (COP, 2025).
- Para el caso portal, `generar_formulario` devuelve `ok: false` con «formato no soportado» y aun así escribe `valores-portal.md`, como pide HU-3.
- En las celdas faltantes del Excel el valor queda vacío, resaltado en amarillo y con una nota; las que requieren confirmación quedan en naranja.

## 8. Cobertura

| Historia | Estado | Evidencia | Qué falta para producción |
| --- | --- | --- | --- |
| HU-1 Leer la solicitud | Hecho | `proveedor_leer_solicitud`; etiquetas ambiguas en `requiere_confirmacion` con el equivalente del país | Leer el correo real y los adjuntos binarios (xlsx/pdf) en vez de fixtures normalizados. |
| HU-2 Mapear campos | Hecho | 3 estados, ruta del maestro, glosario normalizado, RN1 | Un dueño del glosario y del maestro; revisión periódica de sinónimos nuevos. |
| HU-3 Generar formulario | Hecho (P0 xlsx, P1 pdf, P2 portal como valores) | `out/<caso>/formulario.xlsx`, `formulario.pdf`, `valores-portal.md` | Escribir sobre la plantilla original del cliente cuando la envíe; automatizar portales (sección 5). |
| HU-4 Paquete para firma | Hecho | `paquete/` con formulario, soportes vigentes, `checklist.md`, `borrador-correo.md`; vencido o ausente bloquea; vigencias a la fecha de ejecución | Integración con firma electrónica y correo (fuera de alcance). |
| HU-5 Manejo de errores | Hecho | Caso inexistente, plantilla corrupta y formato no soportado en `demo.ts`; herramientas sin excepciones | Alertas operativas sobre errores repetidos. |
| Despliegue (link) | Hecho | https://perxia-reto-01-one.vercel.app con OpenAI `gpt-5.5` y Vercel Blob privado; prompt de la sección 11 probado en producción | Dominio propio y monitoreo de errores. |
| Bonus `modulo/` | Hecho | Generado desde las mismas fuentes; `bun run build:modulo --check` en CI | — |

## 9. Uso de IA

- **Claude Code con Claude Opus 5.5:** redacción del SDD por etapas, andamiaje del proyecto, núcleo (ciclo, registro de herramientas, confirmación, storage), adaptadores LLM, herramientas, front, pruebas y esta documentación. Todo el código se revisó y se probó con `demo.ts`, `bun test` y TypeScript estricto.
- **Propuestas descartadas:** desplegar en Railway con disco persistente (se eligió Vercel y se resolvió la persistencia con Blob); usar un SDK multi-proveedor (el PRD pide interfaz propia); dejar que el modelo mapee etiquetas (riesgo de valores inventados).

## 10. Riesgos de llevar esto a producción

| Riesgo | Mitigación |
| --- | --- |
| Acceso al link público | Ingreso con usuario y contraseña en variables sensibles de Vercel, comparación en tiempo constante, cookie firmada de 8 h y bloqueo de 15 min tras 5 intentos fallidos por IP. El bloqueo vive en la memoria de cada instancia: en producción iría a un almacén compartido (o a un proveedor de identidad con MFA) y habría un usuario por persona. |
| Espacios de sesión que se acumulan en Blob | Cada sesión ocupa `out/<sessionId>/`; en producción, una limpieza programada de sesiones viejas. |
| El modelo afirma un valor que no salió de una herramienta | Las herramientas son la única fuente; el prompt lo prohíbe y los documentos se generan desde el estado guardado por la herramienta, no desde el texto del modelo. Revisión humana antes de firmar. |
| Plantillas reales más variadas que los fixtures | Umbral de confianza: lo dudoso queda en `requiere_confirmacion`; ampliar el glosario con cada caso nuevo. |
| Maestro o soportes desactualizados | Dueño del dato y alerta de soportes que vencen en los próximos 30 días. |
| Concurrencia en Vercel Blob: añadir una línea a un log es leer y reescribir el archivo | Aceptable para una analista; en producción, logs en una cola o base de datos y escritura atómica por caso. |
| Gasto descontrolado de la clave del modelo | Topes de iteraciones, tokens por sesión y tiempo por turno; el link exige ingreso con usuario y contraseña. |
| Exposición de datos bancarios | Enmascarados en logs y tarjetas del chat; nunca en el borrador de correo (test que lo verifica). |
