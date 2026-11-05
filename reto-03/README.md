# Reto 03 — Agente "Órdenes de Compra SAP"

Agente conversacional que lee el paquete de compra (correo, solicitud, cotización, aprobación y factura), lo valida contra los maestros con las reglas RC1–RC10, construye la OC con trazabilidad por campo, genera la evidencia de aprobación y crea la OC en un SAP simulado e idempotente. Las excepciones se confirman con la analista; los bloqueos se devuelven con la acción sugerida.

- **Link de prueba:** LINK_PENDIENTE (sin clave de acceso)
- **Planteamiento de la solución:** [SOLUCION.md](SOLUCION.md)

## Requisitos

- [Bun](https://bun.sh) 1.3 o superior.
- Una clave de **uno** de los proveedores de modelo: Anthropic, OpenAI o Google Gemini. `demo.ts` no necesita clave.

## Levantar en local (un comando)

```bash
cp .env.example .env   # completa LLM_PROVIDER y la clave del proveedor elegido
bun install && bun run dev
```

Abre http://localhost:3000. Bun carga `.env` automáticamente.

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
| `OUT_DIR` | No | Carpeta de salida local (defecto `./out`). |
| `BLOB_READ_WRITE_TOKEN` | Solo en Vercel | Token del Blob store privado; si existe, `out/` y las sesiones se guardan en Vercel Blob. |
| `ACCESS_KEY` | No | Si se define, la API exige la cabecera `x-access-key` (el front la pide una vez). |

## Demo sin modelo

```bash
bun install && bun run demo.ts
```

Limpia `out/` y procesa los 6 casos llamando directamente a las herramientas. Imprime por caso `apta`, bloqueos (con la acción sugerida), confirmaciones, derivados, `retroactiva` y el número de OC o el motivo. Muestra la idempotencia ejecutando `sol-001` dos veces, el rechazo de `confirmado: true` sin confirmación y la confirmación explícita de `sol-004`. Cierra con el manejo de errores (caso inexistente, pasos fuera de orden, JSON malformado, monto no numérico, adjuntos ausentes) y el contenido de `out/control.csv`.

| Caso | `apta` | Bloqueos | Confirmaciones | Retroactiva | Resultado |
| --- | --- | --- | --- | --- | --- |
| sol-001 | true | — | — | false | OC 4500000001; la segunda ejecución devuelve el mismo número con `idempotente: true` |
| sol-002 | false | RC1 (NIT 901999000 no existe) | — | false | No crea; sugiere el alta del proveedor |
| sol-003 | false | RC2 (fvargas no aprueba CC-2020) | — | false | No crea; pedir aprobación a rtorres, cuyo tope (30M) no alcanza para 74M: escalar |
| sol-004 | true | — | RC5 (25.000.000 vs 26.500.000, 6 %) | false | Pendiente; con `confirmado: true` → OC 4500000002 con los valores de la solicitud |
| sol-005 | true | — | RC8 (factura 2026-08-10 < solicitud 2026-08-27) | true | Pendiente; queda `retroactiva = true` en el control |
| sol-006 | true | — | RC6 (IVA C1 derivado) | false | Pendiente; derivados C1 y Z030; proveedor resuelto por nombre |

## Pruebas

```bash
bun test          # dominio (RC1–RC10, parsers, payload, SAP simulado), ciclo del agente y contrato de los 3 adaptadores
bun run typecheck # TypeScript estricto
bun run build:modulo --check   # verifica que modulo/ coincide con las fuentes
```

## API

| Método | Ruta | Cuerpo / respuesta |
| --- | --- | --- |
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation, pendiente, error, uso }` |
| `GET` | `/api/sessions/:id` | Historial de la sesión: mensajes, llamadas a herramientas y confirmación pendiente. |
| `GET` | `/api/health` | `{ ok, provider, model, configurado, storage }`, sin claves. |
| `GET` | `/api/archivos?caso=<caso>` | Archivos generados para un caso. |
| `GET` | `/out/<ruta>` | Descarga de un archivo generado (`control.csv`, `sap/ordenes.jsonl`, evidencia, payload, trazabilidad, logs). |
| `POST` | `/api/reset` | Vacía `out/` (en Vercel exige `ACCESS_KEY`). |

## Salidas

| Ruta | Contenido |
| --- | --- |
| `out/<caso>/aprobacion.txt` y `.pdf` | Evidencia de aprobación con encabezados, cuerpo y sha256. |
| `out/<caso>/payload.json` | OC validada con zod, tal como iría a SAP. |
| `out/<caso>/trazabilidad.json` | Fuente de cada campo: `solicitud`, `cotizacion`, `maestro.<nombre>` o `derivado`. |
| `out/<caso>/oc.json` | OC creada, con número y excepciones confirmadas. |
| `out/sap/ordenes.jsonl` | «Tabla» del SAP simulado, numerada desde 4500000001. |
| `out/control.csv` | Una fila por intento de crear: `solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts`. |
| `out/log.jsonl` y `out/<caso>/log.jsonl` | Cada llamada a herramienta. |

## Estructura

```
agent/prompt.md                   comportamiento del agente (system prompt)
src/knowledge/ordenes-compra.md   conocimiento del proceso: pasos, matriz RC1–RC10, payload, control
src/tools/oc.ts                   herramientas (oc_<export>)
src/domain/                       lógica pura: fixtures, paquete y parsers, reglas, payload y evidencia, control
src/sap/adapter.ts                interfaz SapAdapter (sección 7.4)
src/sap/mock.ts                   SAP simulado sobre out/sap/
src/core/                         ciclo, registro de herramientas, confirmación, sesiones, logs, storage
src/llm/                          interfaz LlmAdapter + Anthropic, OpenAI y Gemini
src/server.ts                     API HTTP (Hono) y front estático
web/                              front de chat
demo.ts                           ejecución sin modelo
modulo/                           agente empaquetado (generado con bun run build:modulo)
fixtures/                         entregados por Periferia (solo lectura)
```

## Despliegue en Vercel

1. Crear un proyecto en Vercel desde el repositorio, con **Root Directory** `reto-03`.
2. Conectar un **Blob store privado** al proyecto (Storage → Blob); Vercel inyecta `BLOB_READ_WRITE_TOKEN`.
3. Definir `LLM_PROVIDER`, `LLM_MODEL` (si aplica) y la clave del proveedor en Environment Variables.
4. Desplegar. La configuración está en `vercel.json` (runtime Bun, 300 s por función, archivos incluidos).

La raíz del proyecto se calcula desde `src/agente.ts`, porque en Vercel el directorio de trabajo es `/var/task` y no la carpeta del reto.
