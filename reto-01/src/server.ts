// API HTTP del agente y servidor del front. En Vercel se exporta la app Hono; en local la sirve dev.ts.
import { readFile } from "node:fs/promises"
import { extname, join } from "node:path"
import { Hono } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { z } from "zod"
import { cargarSystemPrompt, DIRECTORIO, fechaReferencia, registro } from "./agente.ts"
import {
  bloqueoRestante,
  COOKIE_SESION,
  credencialesValidas,
  DURACION_SESION_S,
  firmarSesion,
  leerConfigAuth,
  limpiarFallos,
  registrarFallo,
  verificarSesion,
} from "./core/auth.ts"
import { ejecutarTurno, leerConfigCiclo } from "./core/loop.ts"
import { cargarSesion, guardarSesion, idValido, nuevaSesion } from "./core/session.ts"
import { crearStorage, EspacioStorage, rutaSegura } from "./core/storage.ts"
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
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain; charset=utf-8",
}

const ChatSchema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  message: z.string().trim().min(1).max(4000),
})

type Variables = { usuario: string }
export const app = new Hono<{ Variables: Variables }>()

/** Rutas sin sesión: la pantalla de ingreso, su hoja de estilos y /api/health (público por PRD, sin claves). */
const PUBLICAS = new Set(["/login", "/styles.css", "/api/health"])

// Ningún error llega crudo al cliente (CA5): se registra en el servidor y se responde en lenguaje claro.
app.onError((err, c) => {
  console.error(err)
  return c.json({ ok: false, error: "Error interno del servidor. La sesión sigue activa: reintenta en unos segundos." }, 500)
})

// La API y los archivos generados nunca se cachean (el panel de archivos debe ver lo último).
app.use("*", async (c, next) => {
  await next()
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/out/")) c.header("Cache-Control", "no-store")
})

// Todo exige sesión iniciada salvo las rutas públicas.
app.use("*", async (c, next) => {
  if (PUBLICAS.has(c.req.path)) return next()
  const usuario = verificarSesion(leerConfigAuth(), getCookie(c, COOKIE_SESION))
  if (!usuario) {
    if (c.req.path.startsWith("/api/")) return c.json({ ok: false, error: "sesión no iniciada: ingresa por /login" }, 401)
    return c.redirect("/login", 302)
  }
  c.set("usuario", usuario)
  return next()
})

// ---------- ingreso ----------

const MENSAJES_LOGIN: Record<string, string> = {
  credenciales: "Usuario o contraseña incorrectos.",
  bloqueado: "Demasiados intentos fallidos. Espera unos minutos e inténtalo de nuevo.",
  config: "El ingreso no está configurado en el servidor (faltan APP_USER, APP_PASSWORD o SESSION_SECRET).",
  salida: "Cerraste la sesión.",
}

function ipCliente(c: { req: { header(n: string): string | undefined } }): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local"
}

app.get("/login", async (c) => {
  if (verificarSesion(leerConfigAuth(), getCookie(c, COOKIE_SESION))) return c.redirect("/", 302)
  const clave = leerConfigAuth() ? (c.req.query("m") ?? "") : "config"
  const mensaje = MENSAJES_LOGIN[clave]
  const html = (await readFile(join(DIRECTORIO, "web", "login.html"), "utf8")).replace(
    "<!--MENSAJE-->",
    mensaje ? `<p class="aviso-login${clave === "salida" ? " neutro" : ""}" role="alert">${mensaje}</p>` : "",
  )
  c.header("Cache-Control", "no-store")
  return c.html(html)
})

app.post("/login", async (c) => {
  const config = leerConfigAuth()
  if (!config) return c.redirect("/login?m=config", 303)
  const ip = ipCliente(c)
  if (bloqueoRestante(ip) > 0) return c.redirect("/login?m=bloqueado", 303)
  const cuerpo = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
  const usuario = typeof cuerpo.usuario === "string" ? cuerpo.usuario.trim() : ""
  const password = typeof cuerpo.password === "string" ? cuerpo.password : ""
  if (!credencialesValidas(config, usuario, password)) {
    registrarFallo(ip)
    return c.redirect(`/login?m=${bloqueoRestante(ip) > 0 ? "bloqueado" : "credenciales"}`, 303)
  }
  limpiarFallos(ip)
  setCookie(c, COOKIE_SESION, firmarSesion(config, config.usuario), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: DURACION_SESION_S,
  })
  return c.redirect("/", 303)
})

app.post("/logout", (c) => {
  deleteCookie(c, COOKIE_SESION, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })
  return c.redirect("/login?m=salida", 303)
})

// ---------- API ----------

app.get("/api/health", (c) =>
  c.json({ ok: true, provider: configLlm.provider, model: configLlm.model, configurado: "adapter" in llm, storage: storage.tipo }),
)

app.get("/api/me", (c) => c.json({ usuario: c.get("usuario") }))

app.post("/api/chat", async (c) => {
  const usuario = c.get("usuario")
  const cuerpo = ChatSchema.safeParse(await c.req.json().catch(() => null))
  if (!cuerpo.success) return c.json({ ok: false, error: "se espera { sessionId?, message } con un mensaje de hasta 4000 caracteres" }, 400)
  // Una sesión inexistente o de otro usuario no se reutiliza: se abre una nueva con id del servidor.
  const previa = cuerpo.data.sessionId ? await cargarSesion(storage, cuerpo.data.sessionId, usuario) : null
  const sesion = previa ?? nuevaSesion(crypto.randomUUID(), usuario)
  systemPrompt ??= cargarSystemPrompt()
  const respuesta = await ejecutarTurno({
    sesion,
    mensaje: cuerpo.data.message,
    adapter: "adapter" in llm ? llm.adapter : null,
    errorConfiguracion: "error" in llm ? llm.error : undefined,
    registro,
    system: await systemPrompt,
    // Cada sesión trabaja en su propio espacio out/<sessionId>/, que parte de cero.
    ctxBase: { directory: DIRECTORIO, fechaReferencia: fechaReferencia(), storage: new EspacioStorage(storage, sesion.id) },
    config: leerConfigCiclo(),
  })
  await guardarSesion(storage, sesion)
  return c.json({ sessionId: sesion.id, ...respuesta, uso: sesion.uso })
})

app.get("/api/sessions/:id", async (c) => {
  const sesion = await cargarSesion(storage, c.req.param("id"), c.get("usuario"))
  if (!sesion) return c.json({ ok: false, error: "sesión no encontrada" }, 404)
  return c.json({ id: sesion.id, creada: sesion.creada, eventos: sesion.eventos, pendiente: sesion.pendiente, uso: sesion.uso })
})

/** Espacio out/<id>/ de una sesión del usuario actual, o null si no es suya. */
async function espacioDe(id: string, usuario: string): Promise<EspacioStorage | null> {
  if (!idValido(id)) return null
  return (await cargarSesion(storage, id, usuario)) ? new EspacioStorage(storage, id) : null
}

// Archivos generados en la sesión (opcionalmente de un caso). Los internos (estado.json, _*) no se listan.
app.get("/api/archivos", async (c) => {
  const espacio = await espacioDe(c.req.query("sessionId") ?? "", c.get("usuario"))
  if (!espacio) return c.json({ archivos: [] })
  const caso = c.req.query("caso") ?? ""
  if (caso && !/^[a-z0-9][a-z0-9-]*$/.test(caso)) return c.json({ ok: false, error: "caso inválido" }, 400)
  const archivos = (await espacio.listar(caso ? `${caso}/` : "")).filter(
    (r) => !r.endsWith("estado.json") && !r.split("/").some((p) => p.startsWith("_")),
  )
  return c.json({ archivos })
})

// Vacía el espacio de la sesión actual (la sesión de chat se conserva).
app.post("/api/reset", async (c) => {
  const id = z.object({ sessionId: z.string() }).safeParse(await c.req.json().catch(() => null))
  const espacio = id.success ? await espacioDe(id.data.sessionId, c.get("usuario")) : null
  if (!espacio) return c.json({ ok: false, error: "sesión no encontrada" }, 404)
  await espacio.borrarTodo()
  return c.json({ ok: true })
})

// Descarga de archivos generados: /out/<sessionId>/<ruta>, solo para el dueño de la sesión.
app.get("/out/:id/*", async (c) => {
  const id = c.req.param("id")
  const espacio = await espacioDe(id, c.get("usuario"))
  if (!espacio) return c.text("no encontrado", 404)
  let ruta: string
  try {
    ruta = rutaSegura(decodeURIComponent(c.req.path.slice(`/out/${id}/`.length)))
  } catch {
    return c.text("ruta inválida", 400)
  }
  const bytes = await espacio.leer(ruta)
  if (!bytes) return c.text("no encontrado", 404)
  return c.body(new Uint8Array(bytes), 200, { "content-type": TIPOS[extname(ruta)] ?? "application/octet-stream" })
})

// Front estático (web/).
app.get("*", async (c) => {
  const nombre = c.req.path === "/" ? "index.html" : c.req.path.slice(1)
  if (!/^[\w.-]+$/.test(nombre) || nombre === "login.html") return c.text("no encontrado", 404)
  try {
    const contenido = await readFile(join(DIRECTORIO, "web", nombre))
    return c.body(new Uint8Array(contenido), 200, { "content-type": TIPOS[extname(nombre)] ?? "application/octet-stream" })
  } catch {
    return c.text("no encontrado", 404)
  }
})

export default app
