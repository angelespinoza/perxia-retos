# SOLUCIÓN — Reto 02: Agente "Registro de Contratos Vigentes"

## 1. Problema en una frase

Desde el 2026-05-30 nadie alimenta el maestro de contratos y solo llegan a administración los que piden póliza, así que la dirección no sabe qué contratos están vigentes ni qué pólizas vencen; le duele a la analista administrativa (dueña del maestro y de las pólizas), a gerencia (sin visibilidad de vencimientos) y a la empresa (riesgo contractual y dependencia de una persona).

## 2. Arquitectura

```
┌──────────────┐  HTTP   ┌──────────── Backend Hono (Vercel Functions) ─────────────┐
│ web/  chat   │ ──────▶ │ src/server.ts    /api/chat · /api/sessions · /api/health  │
│ - historial  │ ◀────── │ src/core/loop.ts ciclo: modelo ↔ herramientas, topes      │
│ - tool calls │         │ src/core/confirm.ts  puerta de confirmación                │
│ - confirmar  │         │ src/llm/*        LlmAdapter: Anthropic · OpenAI · Gemini   │
│ - archivos   │         │ src/core/registry.ts + src/tools/contratos.ts (zod)       │
└──────────────┘         │        └─ src/domain/ texto · extracción · clasificación  │
                         │                       CSV · alertas                        │
                         └───────────────┬──────────────────────┬───────────────────┘
                                         │                      │
                     fixtures/reto-02/ (solo lectura)    Storage: out/ en disco (local)
                     buzón · maestro · comerciales       o Vercel Blob privado (producción)
                                                         sharepoint/ · alertas.md · log.jsonl
```

| Capa | Dónde vive | Qué contiene |
| --- | --- | --- |
| Comportamiento | `agent/prompt.md` | Orden de pasos (en paralelo), formato de respuesta, reglas que no se rompen. |
| Conocimiento | `src/knowledge/registro-contratos.md` | Esquema 7.2, umbral de confianza, RN1–RN7, alertas. |
| Ejecución | `src/tools/contratos.ts` → `src/domain/` | Herramientas tipadas con zod y lógica determinista. |

El núcleo (`src/core/`, `src/llm/`, `src/server.ts`, `web/`) es el mismo de la Etapa 1; solo cambiaron las herramientas, el prompt, el conocimiento y los textos del front. Un cambio de reglas de negocio toca `src/domain/` o `src/knowledge/`, nunca `src/server.ts`.

## 3. Ciclo del agente

1. `POST /api/chat` carga la sesión desde el `Storage` (`sessions/<id>.json`), para que funcione aunque cada request caiga en otra instancia de Vercel.
2. Si la sesión tenía una confirmación pendiente y el mensaje es afirmativo («sí», «confirmo», «registra»…), la confirmación vale **solo para ese turno** y **solo para el mensaje del buzón que se preguntó**. Cualquier otro mensaje la descarta.
3. El ciclo llama al modelo con el historial y las herramientas. El prompt pide llamadas en paralelo (extraer los 6 a la vez, validar los 6 a la vez, registrar los limpios a la vez), así el prompt de la sección 11 se resuelve en unas 6 iteraciones. Cada llamada se valida con zod (el error vuelve al modelo), se ejecuta dentro de `safe()` (nunca lanza) y queda en `out/log.jsonl` con el `mensaje_id` (RN7).
4. **Confirmación humana (CA3 / RN5):** con campos en revisión, `contratos_registrar` responde `requiere revisión: valor (confianza 0.6), fecha_fin (confianza 0.6)`. El modelo pide confirmación con la pseudo-herramienta `agente_solicitar_confirmacion`; el ciclo termina el turno con `needsConfirmation: true` y el front muestra el banner. Una llamada con `confirmado: true` sin un «sí» del usuario en el turno anterior para ese mismo mensaje se rechaza en el registro de herramientas, aunque el modelo se equivoque.
5. **Topes:** `MAX_ITERACIONES` (25) por turno, `MAX_TOKENS_SESION` por sesión, `LLM_TIMEOUT_MS` por llamada y 270 s por turno (la función de Vercel tiene 300 s). Al llegar a un tope, el agente responde con lo hecho y lo que falta.
6. **Errores (CA5 / HU-6):** un error del proveedor se traduce a un mensaje claro; un error de herramienta (texto vacío, fecha inválida, moneda desconocida) vuelve como `{ ok: false, error }` y el prompt obliga a seguir con el siguiente mensaje.

## 4. Elección del modelo

El agente es **agnóstico de proveedor**: `LLM_PROVIDER` elige entre Anthropic, OpenAI y Gemini, y `LLM_MODEL` el modelo. `tests/llm-contrato.test.ts` verifica que los tres adaptadores traducen el mismo historial sin perder llamadas ni resultados.

- **En producción:** OpenAI `gpt-5.5`, el mismo de la Etapa 1. Ejecuta bien llamadas en paralelo y respeta reglas como «no pases `confirmado: true` por iniciativa propia».
- **Por defecto en el código:** Anthropic `claude-opus-5-5` con esfuerzo `medium`.
- **Por qué alcanza un modelo orquestador:** el modelo no extrae ni clasifica; solo decide el orden, transmite la confirmación y redacta. Toda la lógica es determinista en las herramientas.

**Costo medido** con `gpt-5.5` (campo `uso` de `/api/chat`), procesando el buzón completo con el prompt de la sección 11:

| Turno | Tokens de entrada | Tokens de salida |
| --- | --- | --- |
| «Procesa el buzón…» (6 mensajes, alertas y pregunta) | ≈ 57 000 | ≈ 3 100 |
| «confirmo el valor 0 y la fecha fin 2027-08-31» | ≈ 39 000 | ≈ 800 |
| **Total (≈ 16 000 tokens por mensaje del buzón)** | ≈ 96 000 | ≈ 3 900 |

Como referencia, con Claude Opus 5.5 ($4 por millón de entrada y $20 por millón de salida) el lote completo costaría ≈ US$0,46 sin caché (≈ US$0,08 por contrato) y menos de la mitad con la caché automática del prefijo. El costo con OpenAI depende de la tarifa vigente de `gpt-5.5`.

## 5. Estrategia de extracción

La extracción es **100 % determinista** (`src/domain/extraccion.ts`): expresiones regulares y heurísticas sobre el texto, con confianza y evidencia por campo. El modelo no extrae.

| Campo | Cómo se encuentra | Confianza |
| --- | --- | --- |
| `id_contrato` | `No. XX-AAAA-N` en el encabezado; en un otrosí, el contrato al que se refiere | 1.0; sin número → `AUTO-<año>-<seq>` con 0.5 |
| `cliente`, `nit_cliente` | Partes del preámbulo «NOMBRE, identificada con NIT/RUC/RTN …»; se descarta Periferia (900123456); se quitan puntos y dígito de verificación; la razón social se toma con la grafía del bloque de firmas | 0.95 |
| `pais` | Tipo de identificador: NIT → CO, RTN → HN, RUC de 13 dígitos → EC, de 11 → PE; si no, ciudad del domicilio | 0.9 / 0.7 por texto |
| `objeto` | Cláusula «OBJETO.» hasta el punto final, recortada a 200 caracteres | 0.9 |
| `valor`, `moneda` | Cláusula VALOR: código de moneda + cifra, con el separador de cada moneda (COP: punto de miles; USD/PEN/PAB/HNL: coma de miles) **contrastada con el valor en letras** (parser de números en español) | 0.95 si coinciden; 0.5 si no; «no tiene un valor determinado» → 0 con 0.6 |
| `fecha_inicio`, `fecha_fin` | Cláusula PLAZO: «desde el … (D) de MES de AAAA hasta …» usando el número entre paréntesis; si solo hay plazo en meses, fin = inicio + n meses − 1 día; si el plazo corre desde una firma sin día, inicio = día 1 del mes de firma y fin = último día del mes en que vence | 0.95 explícitas; 0.85 derivadas; 0.8 / 0.6 con firma sin día |
| `requiere_poliza`, `tipo_poliza` | Cláusula GARANTÍAS o «póliza de …» normalizada a cumplimiento, calidad, salarios_prestaciones, responsabilidad_civil… Una póliza condicionada a cada orden de servicio no se marca en el contrato marco | 0.9; condicional 0.85 con aviso |

- **Confianza < 0.8 → `requiere_revision`.** También entran los conflictos con el maestro (otro NIT o moneda para el mismo contrato, o un número distinto al de una fila similar).
- **Un campo ausente es `null` con confianza 0**, nunca inventado. En un otrosí, los campos que el documento no trae no pisan la fila.
- **Clasificación** (`src/domain/clasificacion.ts`): RN1 duplicado si coinciden número, valor y fechas; RN2 actualización si es otrosí, mismo número con diferencias o mismo NIT con objeto similar ≥ 0.9 (Jaccard de palabras significativas); RN3 nuevo; RN4 rechazado sin adjunto de contrato (por nombre y contenido del adjunto) o sin partes ni objeto.
- **Dónde entra el modelo:** presenta los campos en revisión con su evidencia y transmite lo que la analista confirma. `contratos_registrar` acepta valores del usuario **solo en los campos en revisión** y **solo con `confirmado: true`**; cualquier otro valor que mande el modelo se ignora y se reporta. El registro siempre recalcula la extracción y la clasificación (no confía en el `contrato` que recibe).

## 6. Regla de gobierno

**Dueño del proceso:** la analista administrativa es la dueña del maestro y del buzón; la gerencia administrativa es su respaldo y quien escala. No hay área legal: el agente no revisa cláusulas.

1. **Canal único.** Todo contrato se envía a `contratos@periferia.com` (en la demo, `contratos@periferia-ficticia.com`). Lo administra la analista administrativa; la gerencia administrativa tiene acceso de respaldo. Ningún otro canal cuenta como entregado.
2. **Obligación del comercial.** En los **3 días hábiles** siguientes a la firma envía el PDF firmado por ambas partes, y con la misma regla todo otrosí, acta de inicio y acta de terminación o liquidación, **con o sin póliza**. Asunto: `[CONTRATO|OTROSI|TERMINACION] <número> - <cliente>`, un documento por correo. El comercial que envía debe estar en `comerciales.json`.
3. **Acuse automático.** En menos de **1 hora hábil** el agente responde al remitente: número de contrato, clasificación (nuevo, actualización, duplicado, rechazado), campos que quedaron en revisión y, si aplica, que la póliza quedó `pendiente` con el corredor.
4. **Excepciones y escalamiento.** Contrato sin firma, sin valor (salvo contrato marco por demanda) o sin plazo: se registra como rechazado o en revisión y se devuelve al comercial con el motivo; si no se corrige en 5 días hábiles, escala a su jefe comercial. Un remitente no registrado se procesa pero se notifica a la gerencia comercial. Una póliza `pendiente` a 15 días del inicio escala a la gerencia administrativa.
5. **Cierre del gap (junio–agosto de 2026).** Una sola campaña de dos semanas: finanzas extrae la lista de clientes **facturados** entre el 2026-05-30 y la fecha de arranque; cada comercial reenvía al buzón los contratos de esa lista que no estén en el maestro (`bun run demo.ts` muestra cómo el agente los clasifica y deduplica); al final la analista concilia factura contra maestro y reporta los faltantes a gerencia.
6. **Indicador mensual.** **% de clientes facturados en el mes con contrato vigente en el maestro** (meta ≥ 95 %), más el tiempo promedio entre la firma y la llegada al buzón (meta ≤ 3 días hábiles). Si el primero cae, el proceso dejó de vivir.

## 7. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
| --- | --- | --- |
| Extracción determinista con confianza y evidencia por campo | Pedirle al modelo que extraiga los campos | El riesgo central del PRD es que el modelo «redondee» un valor o infiera una fecha. Con reglas el resultado es trazable, testeable y la demo corre sin clave; lo dudoso va a revisión humana. |
| `contratos_registrar` recalcula todo y solo acepta valores del usuario en los campos en revisión | Registrar el `contrato` que manda el modelo | Evita que el modelo cambie un valor entre validar y registrar (CA2 por diseño). |
| `contratos_registrar` también cierra duplicados y rechazados (los marca como procesados sin tocar el maestro) | Que `validar` escriba en `procesados.json` | `validar` queda como lectura pura y hay un solo punto de escritura auditable. |
| Confirmación en el registro de herramientas, atada al `mensaje_id` | Solo una instrucción en el prompt | Un «sí» de la analista solo habilita `confirmado: true` para el mensaje que se preguntó y en el turno siguiente. |
| Valor en cifra contrastado con el valor en letras | Confiar solo en la cifra | Detecta errores de digitación o de separador (COP vs. USD) sin modelo. |
| Contrato marco con póliza por orden → `requiere_poliza = false` y aviso | Marcarla requerida con baja confianza | La póliza se constituye por cada orden; marcarla en el marco dejaría una alerta pendiente permanente y además el PRD espera revisión solo en valor y fecha fin. |
| Vercel con `Storage` intercambiable (disco en local, Blob privado en producción) | Servidor con disco persistente | Decisión del equipo; el disco de la función es efímero, así que maestro, historial y sesiones viven en Blob. |

## 8. Supuestos

- «Hoy» es 2026-09-03 (fecha del PRD), configurable con `FECHA_REFERENCIA`; también es la `fecha_registro` de lo que entra, para que la demo sea determinista.
- **msg-006:** el contrato corre 12 meses desde una firma «en el mes de agosto de 2026» sin día. Se propone `fecha_inicio = 2026-08-01` (confianza 0.8, con aviso) y `fecha_fin = 2027-08-31`, el último día del mes en que vence: es la fecha más tardía compatible con el texto y coincide con la que el PRD espera confirmar. Moneda COP, tomada del umbral de la cláusula de garantías.
- **msg-003:** el otrosí amplía el plazo y dice que las garantías «deberán ampliarse»; se propone `estado_poliza = pendiente` y el cambio queda en el historial. Por eso CT-2026-011 aparece en pólizas pendientes.
- En una actualización no se cambian `fecha_registro` ni `comercial`; la actualización se reporta en alertas como «actualizados desde el corte», con datos del historial.
- El documento archivado conserva la extensión del adjunto (`.txt`); un otrosí se archiva junto al contrato como `<id>-otrosi-<n>.txt` y la fila conserva la ruta del contrato original.
- Un remitente no registrado queda con `comercial` vacío y un aviso `remitente_no_registrado`.
- «Vencidos sin cierre» es una sección adicional de `alertas.md` (CT-2025-018 y CT-2026-002 vencieron y siguen en el maestro).

## 9. Cobertura

| Historia | Estado | Evidencia | Qué falta para producción |
| --- | --- | --- | --- |
| HU-1 Leer el buzón | Hecho | `contratos_leer_buzon` excluye `procesados.json`; `tiene_contrato` por nombre y contenido | Conexión a Exchange / Graph y adjuntos PDF reales. |
| HU-2 Extraer | Hecho (P0 determinista) | Esquema 7.2 con confianza y evidencia; `null` con confianza 0 si falta | OCR para escaneos; `contratos_leer_pdf` (P1) no implementado: los fixtures traen el texto. |
| HU-3 Validar y clasificar | Hecho | RN1–RN5, comercial contra `comerciales.json`, conflictos con el maestro | Catálogo de razones sociales y NIT para clientes con varias filiales. |
| HU-4 Registrar y archivar | Hecho | Maestro en `out/sharepoint/`, `Contratos/<año>/<cliente>/`, `historial.jsonl`, `procesados.json` | Escritura en SharePoint real con control de versiones. |
| HU-5 Alertar | Hecho | `out/alertas.md` con las tres secciones + vencidos sin cierre | Envío programado semanal a gerencia. |
| HU-6 Errores | Hecho | Texto vacío, fecha inválida, moneda desconocida y mensaje inexistente en `demo.ts`; el lote continúa | Cola de reintentos y alertas operativas. |
| Despliegue (link) | Hecho | URL_PRODUCCION con OpenAI `gpt-5.5` y Vercel Blob privado | Dominio propio y monitoreo de errores. |
| Bonus `modulo/` | Hecho | Generado desde las mismas fuentes; `bun run build:modulo --check` en CI | — |

## 10. Uso de IA

- **Claude Code con Claude Opus 5.5:** redacción del SDD por etapas, adaptación del núcleo de la Etapa 1, dominio de extracción y clasificación, herramientas, pruebas, front y esta documentación. Todo el código se revisó y se probó con `demo.ts` (dos corridas idénticas), `bun test`, TypeScript estricto y una prueba real con `gpt-5.5`.
- **Propuestas descartadas:** extraer los campos con el modelo (riesgo de valores inventados); marcar la póliza condicional del contrato marco como requerida con confianza 0.6 (habría puesto `requiere_poliza` en revisión y una alerta permanente); que `validar` escriba en `procesados.json` (se mantuvo como lectura); leer PDF con una librería adicional (P1 fuera de alcance porque los fixtures traen el texto).

## 11. Riesgos de llevar esto a producción

| Riesgo | Mitigación |
| --- | --- |
| Contratos reales con redacciones que las reglas no cubren | Todo lo no reconocido queda `null` o con baja confianza y va a revisión; cada caso nuevo amplía las reglas con su prueba. En un segundo paso, el modelo podría proponer valores que siempre pasan por `validar` y confirmación. |
| PDF escaneados | OCR antes de la extracción y confianza máxima 0.8 para texto de OCR. |
| Falsos duplicados por variaciones del nombre del cliente | La deduplicación usa número de contrato y NIT, no el nombre. |
| El modelo «redondea» un valor o infiere una fecha | El valor registrado sale de la herramienta; el modelo solo transmite lo que la analista confirma y solo en campos en revisión. |
| Concurrencia en Vercel Blob (el CSV y los logs se reescriben completos) | Aceptable para una analista; en producción, maestro en una lista de SharePoint o base de datos con escritura atómica por fila. |
| El proceso depende de que los comerciales envíen | Regla de gobierno con acuse, escalamiento e indicador mensual contra facturación. |
| Gasto de la clave del modelo | Topes de iteraciones, tokens por sesión y tiempo por turno; `ACCESS_KEY` para el link público. |
