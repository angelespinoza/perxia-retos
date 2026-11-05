# Reto 01 — Agente "Registro como Proveedor"

Agente conversacional que lee una solicitud de registro como proveedor, llena el formulario desde el repositorio maestro (Excel o PDF), arma el paquete para firma y simula el envío solo con confirmación explícita.

- **Link de prueba:** https://perxia-reto-01-one.vercel.app (requiere ingreso, ver [Acceso](#acceso))
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

Abre http://localhost:3000 e ingresa con `APP_USER` / `APP_PASSWORD`. Bun carga `.env` automáticamente.

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
| `FECHA_REFERENCIA` | No | Fija la fecha para evaluar vigencias de soportes. Por defecto, la fecha de ejecución (hoy, hora de Colombia), como pide HU-4. |
| `OUT_DIR` | No | Carpeta de salida local (defecto `./out`). |
| `BLOB_READ_WRITE_TOKEN` | Solo en Vercel | Token del Blob store privado; si existe, `out/` y las sesiones se guardan en Vercel Blob. |
| `APP_USER` / `APP_PASSWORD` | Sí | Usuario y contraseña de `/login`. La contraseña se compara en tiempo constante. |
| `SESSION_SECRET` | Sí | Secreto (≥ 16 caracteres) con que se firma la cookie de sesión. Sin estas tres variables nadie puede ingresar. |

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
| `GET` / `POST` | `/login` | Pantalla de ingreso / envío del formulario (`usuario`, `password`); crea la cookie de sesión. |
| `POST` | `/logout` | Borra la cookie y vuelve a `/login`. |
| `GET` | `/api/me` | `{ usuario }` del ingreso actual. |
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation, pendiente, error, uso }` |
| `GET` | `/api/sessions/:id` | Historial de la sesión (solo del usuario que la creó): mensajes, llamadas a herramientas y confirmación pendiente. |
| `GET` | `/api/health` | `{ ok, provider, model, configurado, storage }`, sin claves. |
| `GET` | `/api/archivos?sessionId=<id>[&caso=<caso>]` | Archivos generados en el espacio de la sesión (opcionalmente de un caso). |
| `GET` | `/out/<sessionId>/<ruta>` | Descarga de un archivo generado (formularios, paquete, logs). | Solo para el dueño de la sesión. |
| `POST` | `/api/reset` | `{ sessionId }`: vacía el espacio `out/<sessionId>/` de esa sesión. |

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
3. Definir `LLM_PROVIDER`, `LLM_MODEL` (si aplica), la clave del proveedor, `APP_USER`, `APP_PASSWORD` y `SESSION_SECRET` en Environment Variables (como sensibles, en production y preview).
4. Desplegar. La configuración está en `vercel.json` (runtime Bun, 300 s por función, archivos incluidos).

La raíz del proyecto se calcula desde `src/agente.ts`, porque en Vercel el directorio de trabajo es `/var/task` y no la carpeta del reto.
