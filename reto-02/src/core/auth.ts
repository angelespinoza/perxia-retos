// Ingreso con usuario y contraseña. Credenciales solo en variables de entorno del backend:
// APP_USER, APP_PASSWORD y SESSION_SECRET (nunca en el código ni en el repositorio).
import { createHmac, timingSafeEqual } from "node:crypto"

export const COOKIE_SESION = "perxia_sesion"
export const DURACION_SESION_S = 8 * 60 * 60

export interface ConfigAuth {
  usuario: string
  password: string
  secreto: string
}

/** null si falta alguna variable: entonces nadie puede ingresar (falla cerrado). */
export function leerConfigAuth(env = process.env): ConfigAuth | null {
  const usuario = env.APP_USER ?? ""
  const password = env.APP_PASSWORD ?? ""
  const secreto = env.SESSION_SECRET ?? ""
  if (!usuario || !password || secreto.length < 16) return null
  return { usuario, password, secreto }
}

function hmac(secreto: string, texto: string): Buffer {
  return createHmac("sha256", secreto).update(texto).digest()
}

/** Comparación en tiempo constante: se comparan los HMAC (mismo largo) y se evalúan ambos campos siempre. */
export function credencialesValidas(config: ConfigAuth, usuario: string, password: string): boolean {
  const okUsuario = timingSafeEqual(hmac(config.secreto, usuario), hmac(config.secreto, config.usuario))
  const okPassword = timingSafeEqual(hmac(config.secreto, password), hmac(config.secreto, config.password))
  return okUsuario && okPassword
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url")

/** Token de la cookie: base64url({ u, exp }).firma, con firma = HMAC-SHA256(secreto, payload). */
export function firmarSesion(config: ConfigAuth, usuario: string, ahora = Date.now()): string {
  const payload = b64(JSON.stringify({ u: usuario, exp: Math.floor(ahora / 1000) + DURACION_SESION_S }))
  return `${payload}.${b64(hmac(config.secreto, payload))}`
}

/** Devuelve el usuario si la firma es válida, no venció y el usuario sigue siendo el configurado. */
export function verificarSesion(config: ConfigAuth | null, token: string | undefined, ahora = Date.now()): string | null {
  if (!config || !token) return null
  const [payload, firma, ...resto] = token.split(".")
  if (!payload || !firma || resto.length > 0) return null
  const esperada = hmac(config.secreto, payload)
  const recibida = Buffer.from(firma, "base64url")
  if (recibida.length !== esperada.length || !timingSafeEqual(recibida, esperada)) return null
  try {
    const datos = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u?: unknown; exp?: unknown }
    if (typeof datos.u !== "string" || typeof datos.exp !== "number") return null
    if (datos.exp * 1000 <= ahora) return null
    return datos.u === config.usuario ? datos.u : null
  } catch {
    return null
  }
}

// ---------- límite básico de intentos fallidos (por IP, en memoria de la instancia) ----------

export const MAX_FALLOS = 5
export const VENTANA_MS = 15 * 60 * 1000

const fallos = new Map<string, { cuenta: number; desde: number }>()

/** Milisegundos que faltan para poder reintentar; 0 si no está bloqueado. */
export function bloqueoRestante(ip: string, ahora = Date.now()): number {
  const f = fallos.get(ip)
  if (!f) return 0
  if (ahora - f.desde > VENTANA_MS) {
    fallos.delete(ip)
    return 0
  }
  return f.cuenta >= MAX_FALLOS ? VENTANA_MS - (ahora - f.desde) : 0
}

export function registrarFallo(ip: string, ahora = Date.now()): void {
  const f = fallos.get(ip)
  if (!f || ahora - f.desde > VENTANA_MS) fallos.set(ip, { cuenta: 1, desde: ahora })
  else f.cuenta++
  // Evita que el mapa crezca sin límite si llegan muchas IP distintas.
  if (fallos.size > 10_000) fallos.delete(fallos.keys().next().value as string)
}

export function limpiarFallos(ip?: string): void {
  if (ip === undefined) fallos.clear()
  else fallos.delete(ip)
}
