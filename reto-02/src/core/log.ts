// Registro de cada llamada a herramienta en out/log.jsonl (CA4 / RN7), con el mensaje o caso al que se refiere.
import type { Storage } from "./storage.ts"

export interface EntradaLog {
  ts: string
  sessionId: string
  herramienta: string
  mensaje_id?: string
  args_resumen: string
  ok: boolean
  resumen: string
  ms: number
}

const CLAVES_SENSIBLES = /cuenta|swift|api_?key|token|password|clave/i

/** Enmascara datos bancarios y secretos antes de escribir en el log. */
export function enmascarar(valor: unknown, clave = ""): unknown {
  if (typeof valor === "string") return CLAVES_SENSIBLES.test(clave) ? "***" : valor
  if (Array.isArray(valor)) return valor.map((v) => enmascarar(v, clave))
  if (typeof valor === "object" && valor !== null) {
    const objeto = valor as Record<string, unknown>
    const esBancario = typeof objeto.clave === "string" && objeto.clave.startsWith("banco.")
    return Object.fromEntries(
      Object.entries(objeto).map(([k, v]) => [k, esBancario && k === "valor" ? "***" : enmascarar(v, k)]),
    )
  }
  return valor
}

export function resumirArgs(args: Record<string, unknown>): string {
  const texto = JSON.stringify(enmascarar(args))
  return texto.length > 300 ? `${texto.slice(0, 297)}...` : texto
}

export async function registrarLlamada(storage: Storage, entrada: EntradaLog, caso: string | null): Promise<void> {
  const linea = JSON.stringify(entrada)
  await storage.anexar("log.jsonl", linea)
  if (caso) await storage.anexar(`${caso}/log.jsonl`, linea)
}
