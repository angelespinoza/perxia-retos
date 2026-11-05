// Contrato de salida de toda herramienta: JSON con { ok, data } o { ok: false, error }. Nunca lanza.

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }

export function ok<T>(data: T): string {
  return JSON.stringify({ ok: true, data })
}

export function fail(error: string): string {
  return JSON.stringify({ ok: false, error })
}

export function mensajeError(e: unknown): string {
  if (e instanceof Error) return e.message
  return typeof e === "string" ? e : "error desconocido"
}

/** Ejecuta una función de herramienta y convierte cualquier excepción en { ok: false, error }. */
export async function safe(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn()
  } catch (e) {
    return fail(mensajeError(e))
  }
}

export function parsearResultado(texto: string): Resultado<unknown> {
  try {
    const valor: unknown = JSON.parse(texto)
    if (typeof valor === "object" && valor !== null && "ok" in valor) {
      return valor as Resultado<unknown>
    }
    return { ok: false, error: "resultado sin formato { ok, data }" }
  } catch {
    return { ok: false, error: "resultado no es JSON" }
  }
}

/** Resumen corto de un resultado para el log y las tarjetas del chat. */
export function resumir(resultado: Resultado<unknown>): string {
  if (!resultado.ok) return resultado.error
  const data = resultado.data
  if (typeof data !== "object" || data === null) return String(data)
  const partes: string[] = []
  for (const [clave, valor] of Object.entries(data)) {
    if (Array.isArray(valor)) partes.push(`${clave}: ${valor.length}`)
    else if (typeof valor === "string") partes.push(`${clave}: ${valor.length > 60 ? `${valor.slice(0, 57)}...` : valor}`)
    else if (typeof valor === "number" || typeof valor === "boolean") partes.push(`${clave}: ${valor}`)
  }
  return partes.join(" · ")
}
