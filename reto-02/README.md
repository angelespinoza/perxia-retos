# Reto 02 — Agente "Registro de Contratos Vigentes"

Agente conversacional que actúa como punto único de recepción de contratos: lee el buzón, extrae los datos del contrato con confianza por campo, clasifica cada mensaje (nuevo, actualización, duplicado o rechazado), alimenta el maestro y archiva el documento en una estructura tipo SharePoint, pide revisión humana para lo dudoso y genera el reporte de alertas.

- **Link de prueba:** https://perxia-reto-02-seven.vercel.app (requiere ingreso, ver [Acceso](#acceso))
- **Planteamiento de la solución:** [SOLUCION.md](SOLUCION.md)

## Acceso

El link está protegido con una pantalla de ingreso (`/login`):

| Usuario | Contraseña |
| --- | --- |
| `admin` | `prexia28` |

Las credenciales viven solo en variables de entorno del backend (`APP_USER`, `APP_PASSWORD`, `SESSION_SECRET`), no en el código. Al ingresar se crea una cookie `HttpOnly`, `Secure` y `SameSite=Lax`, firmada con HMAC, que vence a las 8 horas; el botón «Cerrar sesión» la borra. Tras 5 intentos fallidos desde una IP se bloquea el ingreso 15 minutos. Todo exige sesión salvo `/api/health`, que es público y no expone claves.

Cada sesión de chat (y cada «Nueva sesión») trabaja en su propio espacio `out/<sessionId>/`, asociado al usuario que ingresó y que parte de cero: así el prompt de la demo se puede reproducir siempre. Las rutas que muestra el chat (`out/...`) son relativas a ese espacio.

## Requisitos

- [Bun](https://bun.sh) 1.3 o superior.
- Una clave de **uno** de los proveedores de modelo: Anthropic, OpenAI o Google Gemini. `demo.ts` no necesita clave.

## Levantar en local (un comando)

```bash
cp .env.example .env   # completa LLM_PROVIDER, la clave del proveedor, APP_USER, APP_PASSWORD y SESSION_SECRET
bun install && bun run dev
```

Abre http://localhost:3000 e ingresa con `APP_USER` / `APP_PASSWORD`. Bun carga `.env` automáticamente. La primera sugerencia del chat es el prompt de la sección 11 del PRD.

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
| `APP_USER` / `APP_PASSWORD` | Sí | Usuario y contraseña de `/login`. La contraseña se compara en tiempo constante. |
| `SESSION_SECRET` | Sí | Secreto (≥ 16 caracteres) con que se firma la cookie de sesión. Sin estas tres variables nadie puede ingresar. |

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
| `GET` / `POST` | `/login` | Pantalla de ingreso / envío del formulario (`usuario`, `password`); crea la cookie de sesión. |
| `POST` | `/logout` | Borra la cookie y vuelve a `/login`. |
| `GET` | `/api/me` | `{ usuario }` del ingreso actual. |
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation, pendiente, error, uso }` |
| `GET` | `/api/sessions/:id` | Historial de la sesión (solo del usuario que la creó): mensajes, llamadas a herramientas y confirmación pendiente. |
| `GET` | `/api/health` | `{ ok, provider, model, configurado, storage }`, sin claves. |
| `GET` | `/api/archivos?sessionId=<id>[&caso=<caso>]` | Archivos generados en el espacio de la sesión (opcionalmente de un caso). |
| `GET` | `/out/<sessionId>/<ruta>` | Descarga de un archivo generado (maestro, historial, contratos archivados, alertas, log). | Solo para el dueño de la sesión. |
| `POST` | `/api/reset` | `{ sessionId }`: vacía el espacio `out/<sessionId>/` de esa sesión. |

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
3. `LLM_PROVIDER`, `LLM_MODEL`, la clave del proveedor, `APP_USER`, `APP_PASSWORD` y `SESSION_SECRET` en Environment Variables (sensibles, Production y Preview).
4. La configuración está en `vercel.json` (runtime Bun, 300 s por función, archivos incluidos).

La raíz del proyecto se calcula desde `src/agente.ts`, porque en Vercel el directorio de trabajo es `/var/task` y no la carpeta del reto.
