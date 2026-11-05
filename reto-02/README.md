# Reto 02 — Agente "Registro de Contratos Vigentes"

Agente conversacional que actúa como punto único de recepción de contratos: lee el buzón, extrae los datos del contrato con confianza por campo, clasifica cada mensaje (nuevo, actualización, duplicado o rechazado), alimenta el maestro y archiva el documento en una estructura tipo SharePoint, pide revisión humana para lo dudoso y genera el reporte de alertas.

- **Link de prueba:** URL_PRODUCCION (sin clave de acceso)
- **Planteamiento de la solución:** [SOLUCION.md](SOLUCION.md)

## Requisitos

- [Bun](https://bun.sh) 1.3 o superior.
- Una clave de **uno** de los proveedores de modelo: Anthropic, OpenAI o Google Gemini. `demo.ts` no necesita clave.

## Levantar en local (un comando)

```bash
cp .env.example .env   # completa LLM_PROVIDER y la clave del proveedor elegido
bun install && bun run dev
```

Abre http://localhost:3000. Bun carga `.env` automáticamente. La primera sugerencia del chat es el prompt de la sección 11 del PRD.

## Variables de entorno

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `LLM_PROVIDER` | No (por defecto `anthropic`) | `anthropic`, `openai` o `gemini`. |
| `LLM_MODEL` | Para OpenAI y Gemini | Modelo del proveedor. Con Anthropic, por defecto `claude-opus-5-5`. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | Solo la del proveedor activo | Clave del modelo. Solo vive en el backend. |
| `LLM_EFFORT` | No | Esfuerzo de razonamiento en Anthropic: `low`, `medium` (defecto) o `high`. |
| `LLM_TIMEOUT_MS` | No | Timeout por llamada al modelo (defecto 60000). |
| `MAX_ITERACIONES` | No | Tope de llamadas herramienta → modelo por turno (defecto 25). |
| `MAX_TOKENS_SESION` | No | Tope de tokens por sesión (defecto 400000). |
| `FECHA_REFERENCIA` | No | «Hoy» del sistema: `fecha_registro` de los contratos y fecha de alertas si el usuario no indica otra (defecto `2026-09-03`). |
| `OUT_DIR` | No | Carpeta de salida local (defecto `./out`). |
| `BLOB_READ_WRITE_TOKEN` | Solo en Vercel | Token del Blob store privado; si existe, `out/` y las sesiones se guardan en Vercel Blob. |
| `ACCESS_KEY` | No | Si se define, la API exige la cabecera `x-access-key` (el front la pide una vez). |

## Demo sin modelo

```bash
bun install && bun run demo.ts
```

Limpia `out/` y procesa los 6 mensajes del buzón en orden llamando directamente a las herramientas (`extraer` → `validar` → `registrar`). Imprime por mensaje la clasificación, los campos en revisión y la acción tomada. `msg-006` queda sin registrar en la primera pasada; la demo muestra la segunda llamada con `confirmado: true` (primero sin confirmación del usuario, que se rechaza, y luego con ella). Termina con el reporte de alertas y los errores de HU-6 (texto vacío, fecha inválida, moneda desconocida, mensaje inexistente), mostrando que el lote continúa.

Resultado esperado (hoy = 2026-09-03):

| Mensaje | Clasificación | Revisión | Acción |
| --- | --- | --- | --- |
| msg-001 | nuevo · CT-2026-015 · COP 265.000.000 | — | insertado, póliza pendiente |
| msg-002 | nuevo · CT-2026-016 · USD 120.000 | — | insertado, no_aplica |
| msg-003 | actualización de CT-2026-011 (otrosí) | — | valor 350000 → 520000, fecha_fin 2027-05-01 → 2027-11-01, póliza vigente → pendiente |
| msg-004 | duplicado de CT-2026-012 | — | sin escritura |
| msg-005 | rechazado (cotización) | — | marcado procesado con motivo |
| msg-006 | nuevo · CM-2026-03 | valor, fecha_fin | segunda pasada confirmada: valor 0, fecha_fin 2027-08-31 |

Alertas: vencen CT-2026-009 y CT-2026-004; pólizas pendientes CT-2026-004, CT-2026-015 y CT-2026-011; registrados desde el corte CM-2026-03, CT-2026-015 y CT-2026-016; vencidos sin cierre CT-2025-018 y CT-2026-002.

## Pruebas

```bash
bun test          # dominio (extracción, clasificación, alertas, CSV), ciclo con un modelo simulado y contrato de los 3 adaptadores
bun run typecheck # TypeScript estricto
bun run build:modulo --check   # verifica que modulo/ coincide con las fuentes
```

## API

| Método | Ruta | Cuerpo / respuesta |
| --- | --- | --- |
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation, pendiente, error, uso }` |
| `GET` | `/api/sessions/:id` | Historial de la sesión: mensajes, llamadas a herramientas y confirmación pendiente. |
| `GET` | `/api/health` | `{ ok, provider, model, configurado, storage }`, sin claves. |
| `GET` | `/api/archivos` | Archivos generados en `out/` (sin sesiones). |
| `GET` | `/out/<ruta>` | Descarga de un archivo generado (maestro, historial, contratos archivados, alertas, log). |
| `POST` | `/api/reset` | Vacía `out/` (en Vercel exige `ACCESS_KEY`). |

## Herramientas

| Herramienta | Efecto | Qué hace |
| --- | --- | --- |
| `contratos_leer_buzon` | lectura | Mensajes no procesados con `tiene_contrato` y motivo si no lo tiene. |
| `contratos_extraer` | lectura | Campos del esquema 7.2 con confianza y evidencia por campo. |
| `contratos_validar` | lectura | Clasificación RN1–RN4, `requiere_revision` (RN5), diferencias y comercial. |
| `contratos_registrar` | externa | Inserta o actualiza el maestro, archiva el documento, escribe el historial y marca el mensaje como procesado. Con campos en revisión exige `confirmado: true` y la confirmación del usuario. |
| `contratos_alertas` | escritura | Escribe `out/alertas.md`. |
| `agente_solicitar_confirmacion` | — | Termina el turno y espera la confirmación del usuario. |

## Salidas en `out/`

```
out/sharepoint/maestro-contratos.csv           copia de trabajo del maestro (el fixture no se toca)
out/sharepoint/historial.jsonl                 { ts, fecha, id_contrato, accion, cambios, mensaje_id, documento }
out/sharepoint/Contratos/<año>/<cliente>/      contratos y otrosíes archivados
out/procesados.json                            mensajes procesados con su clasificación y acción
out/extracciones/<mensaje>.json                última extracción de cada mensaje
out/alertas.md                                 reporte de alertas
out/log.jsonl                                  todas las llamadas a herramientas (RN7)
```

## Estructura

```
agent/prompt.md                       comportamiento del agente (system prompt)
src/knowledge/registro-contratos.md   conocimiento del proceso
src/tools/contratos.ts                herramientas (contratos_<export>)
src/domain/                           lógica pura: texto en español, extracción, clasificación, CSV, alertas
src/core/                             ciclo, registro de herramientas, confirmación, sesiones, logs, storage
src/llm/                              interfaz LlmAdapter + Anthropic, OpenAI y Gemini
src/server.ts                         API HTTP (Hono) y front estático
web/                                  front de chat
demo.ts                               ejecución sin modelo
modulo/                               agente empaquetado (generado con bun run build:modulo)
fixtures/                             entregados por Periferia (solo lectura)
```

## Despliegue en Vercel

1. Proyecto de Vercel `perxia-reto-02` conectado al repositorio, con **Root Directory** `reto-02`.
2. **Blob store privado** conectado al proyecto (Storage → Blob); Vercel inyecta `BLOB_READ_WRITE_TOKEN`.
3. `LLM_PROVIDER`, `LLM_MODEL` y la clave del proveedor en Environment Variables (Production y Preview).
4. La configuración está en `vercel.json` (runtime Bun, 300 s por función, archivos incluidos).

La raíz del proyecto se calcula desde `src/agente.ts`, porque en Vercel el directorio de trabajo es `/var/task` y no la carpeta del reto.
