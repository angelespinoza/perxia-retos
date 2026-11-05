/// <reference types="bun" />
// Ingreso con usuario y contraseña y separación de out/ por sesión, probados contra la app Hono (sin modelo).
import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ConfigAuth,
  credencialesValidas,
  DURACION_SESION_S,
  firmarSesion,
  limpiarFallos,
  MAX_FALLOS,
  verificarSesion,
} from "../src/core/auth.ts"
import { FsStorage } from "../src/core/storage.ts"

const USUARIO = "evaluador"
const PASSWORD = "clave-de-prueba-123"
let app: { request(url: string, init?: RequestInit): Promise<Response> | Response }
let base: FsStorage

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "servidor-"))
  Object.assign(process.env, {
    APP_USER: USUARIO,
    APP_PASSWORD: PASSWORD,
    SESSION_SECRET: "secreto-de-prueba-de-32-caracteres!!",
    OUT_DIR: dir,
    BLOB_READ_WRITE_TOKEN: "",
  })
  base = new FsStorage(dir)
  app = (await import("../src/server.ts")).app
})

beforeEach(() => limpiarFallos())

const ingresar = (usuario: string, password: string, ip = "10.0.0.1") =>
  app.request("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
    body: new URLSearchParams({ usuario, password }).toString(),
  })

async function cookieValida(): Promise<string> {
  const r = await ingresar(USUARIO, PASSWORD, "10.9.9.9")
  return (r.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
}

describe("ingreso con usuario y contraseña", () => {
  test("sin sesión: /api/health es público, la API responde 401 y el front redirige a /login", async () => {
    const health = await app.request("/api/health")
    expect(health.status).toBe(200)
    const cuerpo = await health.text()
    expect(cuerpo).not.toContain(PASSWORD)
    expect((await app.request("/api/chat", { method: "POST", body: "{}" })).status).toBe(401)
    expect((await app.request("/api/archivos")).status).toBe(401)
    const front = await app.request("/")
    expect(front.status).toBe(302)
    expect(front.headers.get("location")).toBe("/login")
    expect((await app.request("/out/x/y.md")).status).toBe(302)
    const login = await app.request("/login")
    expect(login.status).toBe(200)
    expect(await login.text()).toContain('action="/login"')
  })

  test("credenciales correctas: cookie HttpOnly, Secure, SameSite=Lax y 8 horas", async () => {
    const r = await ingresar(USUARIO, PASSWORD)
    expect(r.status).toBe(303)
    expect(r.headers.get("location")).toBe("/")
    const cookie = r.headers.get("set-cookie") ?? ""
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).toContain(`Max-Age=${DURACION_SESION_S}`)
    const me = await app.request("/api/me", { headers: { cookie: cookie.split(";")[0] ?? "" } })
    expect(await me.json()).toEqual({ usuario: USUARIO })
  })

  test("credenciales incorrectas y límite de intentos fallidos", async () => {
    const mala = await ingresar(USUARIO, "otra")
    expect(mala.headers.get("location")).toBe("/login?m=credenciales")
    expect(mala.headers.get("set-cookie")).toBeNull()
    for (let i = 1; i < MAX_FALLOS; i++) await ingresar("x", "y")
    // Bloqueada: ni siquiera la contraseña correcta entra desde esa IP; otra IP sí.
    const bloqueada = await ingresar(USUARIO, PASSWORD)
    expect(bloqueada.headers.get("location")).toBe("/login?m=bloqueado")
    expect((await ingresar(USUARIO, PASSWORD, "10.0.0.2")).headers.get("location")).toBe("/")
  })

  test("cookie alterada o vencida no sirve; cerrar sesión borra la cookie", async () => {
    const cookie = await cookieValida()
    const alterada = `${cookie.slice(0, -2)}xx`
    expect((await app.request("/api/me", { headers: { cookie: alterada } })).status).toBe(401)
    const salida = await app.request("/logout", { method: "POST", headers: { cookie } })
    expect(salida.headers.get("location")).toBe("/login?m=salida")
    expect(salida.headers.get("set-cookie")).toContain("Max-Age=0")
  })

  test("firma, vencimiento y comparación de credenciales", () => {
    const config: ConfigAuth = { usuario: "u", password: "p", secreto: "s".repeat(32) }
    const ahora = Date.parse("2026-11-04T12:00:00Z")
    const token = firmarSesion(config, "u", ahora)
    expect(verificarSesion(config, token, ahora + 1000)).toBe("u")
    expect(verificarSesion(config, token, ahora + DURACION_SESION_S * 1000 + 1)).toBeNull()
    expect(verificarSesion({ ...config, secreto: "t".repeat(32) }, token, ahora)).toBeNull()
    expect(verificarSesion(null, token, ahora)).toBeNull()
    expect(credencialesValidas(config, "u", "p")).toBe(true)
    expect(credencialesValidas(config, "u", "P")).toBe(false)
    expect(credencialesValidas(config, "U", "p")).toBe(false)
  })
})

describe("estado por sesión asociado al usuario (A1)", () => {
  test("solo el dueño ve la sesión y sus archivos en out/<sessionId>/", async () => {
    const cookie = await cookieValida()
    const sesion = (id: string, usuario: string) =>
      JSON.stringify({ id, usuario, creada: "", mensajes: [], eventos: [], pendiente: null, uso: { entrada: 0, salida: 0 } })
    await base.escribir("sessions/propia.json", sesion("propia", USUARIO))
    await base.escribir("sessions/ajena.json", sesion("ajena", "otro"))
    await base.escribir("propia/caso-x/nota.md", "# propia")
    await base.escribir("propia/caso-x/estado.json", "{}")
    await base.escribir("ajena/caso-x/nota.md", "# ajena")
    const get = (url: string) => app.request(url, { headers: { cookie } })

    expect((await get("/out/propia/caso-x/nota.md")).status).toBe(200)
    expect((await get("/out/ajena/caso-x/nota.md")).status).toBe(404)
    expect((await get("/out/sessions/propia.json")).status).toBe(404)
    expect((await get("/out/propia/../ajena/caso-x/nota.md")).status).not.toBe(200)
    expect((await get("/api/sessions/propia")).status).toBe(200)
    expect((await get("/api/sessions/ajena")).status).toBe(404)

    const archivos = await get("/api/archivos?sessionId=propia&caso=caso-x")
    expect(archivos.headers.get("cache-control")).toBe("no-store")
    expect(await archivos.json()).toEqual({ archivos: ["caso-x/nota.md"] })
    expect(await (await get("/api/archivos?sessionId=ajena")).json()).toEqual({ archivos: [] })
  })
})
