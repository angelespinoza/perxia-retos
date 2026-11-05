# Reto 01 — Agente "Registro como Proveedor"

Agente conversacional que lee una solicitud de registro como proveedor, llena el formulario desde el repositorio maestro (Excel o PDF), arma el paquete para firma y simula el envío solo con confirmación explícita.

- **Link de prueba:** https://perxia-reto-01-one.vercel.app (sin clave de acceso)
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
| `FECHA_REFERENCIA` | No | Fecha para evaluar vigencias de soportes (defecto `2026-09-03`). |
| `OUT_DIR` | No | Carpeta de salida local (defecto `./out`). |
| `BLOB_READ_WRITE_TOKEN` | Solo en Vercel | Token del Blob store privado; si existe, `out/` y las sesiones se guardan en Vercel Blob. |
| `ACCESS_KEY` | No | Si se define, la API exige la cabecera `x-access-key` (el front la pide una vez). |

## Demo sin modelo

```bash
bun install && bun run demo.ts
```

Limpia `out/`, procesa los 4 casos llamando directamente a las herramientas e imprime por caso los campos llenos, faltantes y por confirmar, los soportes y `listo_para_firma`. También muestra el manejo de errores (caso inexistente y plantilla corrupta) y la regla de confirmación del envío.

## Pruebas

```bash
bun test          # dominio, ciclo del agente con un modelo simulado y contrato de los 3 adaptadores
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
| `GET` | `/out/<ruta>` | Descarga de un archivo generado (formularios, paquete, logs). |
| `POST` | `/api/reset` | Vacía `out/` (en Vercel exige `ACCESS_KEY`). |

## Estructura

```
agent/prompt.md                      comportamiento del agente (system prompt)
src/knowledge/registro-proveedor.md  conocimiento del proceso
src/tools/proveedor.ts               herramientas (proveedor_<export>)
src/domain/                          lógica pura: mapeo, vigencias, documentos
src/core/                            ciclo, registro de herramientas, confirmación, sesiones, logs, storage
src/llm/                             interfaz LlmAdapter + Anthropic, OpenAI y Gemini
src/server.ts                        API HTTP (Hono) y front estático
web/                                 front de chat
demo.ts                              ejecución sin modelo
modulo/                              agente empaquetado (generado con bun run build:modulo)
fixtures/                            entregados por Periferia (solo lectura)
```

## Despliegue en Vercel

1. Crear un proyecto en Vercel desde el repositorio, con **Root Directory** `reto-01`.
2. Conectar un **Blob store privado** al proyecto (Storage → Blob); Vercel inyecta `BLOB_READ_WRITE_TOKEN`.
3. Definir `LLM_PROVIDER`, `LLM_MODEL` (si aplica) y la clave del proveedor en Environment Variables.
4. Desplegar. La configuración está en `vercel.json` (runtime Bun, 300 s por función, archivos incluidos).

La raíz del proyecto se calcula desde `src/agente.ts`, porque en Vercel el directorio de trabajo es `/var/task` y no la carpeta del reto.
