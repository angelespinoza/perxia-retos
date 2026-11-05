// API HTTP del agente y servidor del front. En Vercel se exporta la app Hono; en local la sirve dev.ts.
import { readFile } from "node:fs/promises"
import { extname, join } from "node:path"
import { Hono } from "hono"
import { z } from "zod"
import { cargarSystemPrompt, DIRECTORIO, fechaReferencia, registro } from "./agente.ts"
import { ejecutarTurno, leerConfigCiclo } from "./core/loop.ts"
import { cargarSesion, guardarSesion, idValido, nuevaSesion } from "./core/session.ts"
import { crearStorage, rutaSegura } from "./core/storage.ts"
import { crearAdapter, leerConfigLlm } from "./llm/index.ts"

const storage = crearStorage(DIRECTORIO)
const llm = crearAdapter()
const configLlm = leerConfigLlm()
let systemPrompt: Promise<string> | null = null

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".pdf": "application/pdf",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
}

const ChatSchema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  message: z.string().trim().min(1).max(4000),
})

export const app = new Hono()

// Ningún error llega crudo al cliente (CA5): se registra en el servidor y se responde en lenguaje claro.
app.onError((err, c) => {
  console.error(err)
  return c.json({ ok: false, error: "Error interno del servidor. La sesión sigue activa: reintenta en unos segundos." }, 500)
})

// Protección opcional del link público con ACCESS_KEY (cabecera x-access-key o parámetro ?key=).
app.use("/api/*", async (c, next) => {
  const clave = process.env.ACCESS_KEY
  if (!clave || c.req.path === "/api/health") return next()
  const enviada = c.req.header("x-access-key") ?? c.req.query("key")
  if (enviada !== clave) return c.json({ ok: false, error: "clave de acceso inválida" }, 401)
  return next()
})

app.get("/api/health", (c) =>
  c.json({ ok: true, provider: configLlm.provider, model: configLlm.model, configurado: "adapter" in llm, storage: storage.tipo }),
)

app.post("/api/chat", async (c) => {
  const cuerpo = ChatSchema.safeParse(await c.req.json().catch(() => null))
  if (!cuerpo.success) return c.json({ ok: false, error: "se espera { sessionId?, message } con un mensaje de hasta 4000 caracteres" }, 400)
  const id = cuerpo.data.sessionId ?? crypto.randomUUID()
  const sesion = (await cargarSesion(storage, id)) ?? nuevaSesion(id)
  systemPrompt ??= cargarSystemPrompt()
  const respuesta = await ejecutarTurno({
    sesion,
    mensaje: cuerpo.data.message,
    adapter: "adapter" in llm ? llm.adapter : null,
    errorConfiguracion: "error" in llm ? llm.error : undefined,
    registro,
    system: await systemPrompt,
    ctxBase: { directory: DIRECTORIO, fechaReferencia: fechaReferencia(), storage },
    config: leerConfigCiclo(),
  })
  await guardarSesion(storage, sesion)
  return c.json({ sessionId: id, ...respuesta, uso: sesion.uso })
})

app.get("/api/sessions/:id", async (c) => {
  const id = c.req.param("id")
  const sesion = idValido(id) ? await cargarSesion(storage, id) : null
  if (!sesion) return c.json({ ok: false, error: "sesión no encontrada" }, 404)
  return c.json({ id: sesion.id, creada: sesion.creada, eventos: sesion.eventos, pendiente: sesion.pendiente, uso: sesion.uso })
})

app.get("/api/archivos", async (c) => {
  const caso = c.req.query("caso") ?? ""
  if (!/^[a-z0-9][a-z0-9-]*$/.test(caso)) return c.json({ ok: false, error: "caso inválido" }, 400)
  return c.json({ archivos: (await storage.listar(caso)).filter((r) => !r.endsWith("estado.json")) })
})

app.post("/api/reset", async (c) => {
  if (!process.env.ACCESS_KEY && storage.tipo === "blob")
    return c.json({ ok: false, error: "en producción el reinicio exige ACCESS_KEY" }, 403)
  await storage.borrarTodo()
  return c.json({ ok: true })
})

// Descarga de archivos generados (formularios, paquete, logs). Las sesiones no se exponen.
app.get("/out/*", async (c) => {
  let ruta: string
  try {
    ruta = rutaSegura(decodeURIComponent(c.req.path.slice("/out/".length)))
  } catch {
    return c.text("ruta inválida", 400)
  }
  if (ruta.startsWith("sessions/")) return c.text("no disponible", 404)
  const bytes = await storage.leer(ruta)
  if (!bytes) return c.text("no encontrado", 404)
  return c.body(new Uint8Array(bytes), 200, { "content-type": TIPOS[extname(ruta)] ?? "application/octet-stream" })
})

// Front estático (web/).
app.get("*", async (c) => {
  const nombre = c.req.path === "/" ? "index.html" : c.req.path.slice(1)
  if (!/^[\w.-]+$/.test(nombre)) return c.text("no encontrado", 404)
  try {
    const contenido = await readFile(join(DIRECTORIO, "web", nombre))
    return c.body(new Uint8Array(contenido), 200, { "content-type": TIPOS[extname(nombre)] ?? "application/octet-stream" })
  } catch {
    return c.text("no encontrado", 404)
  }
})

export default app
