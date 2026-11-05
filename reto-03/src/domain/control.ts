// Log de control para contabilidad y auditoría (out/control.csv): una fila por intento de crear una OC.
import type { Storage } from "../core/storage.ts"

export const ARCHIVO_CONTROL = "control.csv"
const COLUMNAS = ["solicitud_id", "resultado", "numero_oc", "retroactiva", "bloqueos", "confirmaciones", "ts"] as const

export type ResultadoControl = "creada" | "idempotente" | "bloqueada" | "pendiente"

export interface FilaControl {
  solicitud_id: string
  resultado: ResultadoControl
  numero_oc: string | null
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
  ts: string
}

function celda(valor: string): string {
  return /[",\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor
}

export function filaCsv(f: FilaControl): string {
  return [f.solicitud_id, f.resultado, f.numero_oc ?? "", String(f.retroactiva), f.bloqueos.join("|"), f.confirmaciones.join("|"), f.ts]
    .map(celda)
    .join(",")
}

export async function registrarControl(storage: Storage, fila: FilaControl): Promise<void> {
  const actual = await storage.leerTexto(ARCHIVO_CONTROL)
  if (actual === null) await storage.escribir(ARCHIVO_CONTROL, `${COLUMNAS.join(",")}\n${filaCsv(fila)}\n`)
  else await storage.anexar(ARCHIVO_CONTROL, filaCsv(fila))
}
