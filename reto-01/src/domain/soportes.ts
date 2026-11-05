// Evaluación de soportes exigidos contra el repositorio (HU-4, RN3).
import type { Soporte } from "./fixtures.ts"

export type EstadoSoporte = "presente" | "ausente" | "vencido"

export interface SoporteEvaluado {
  tipo: string
  estado: EstadoSoporte
  archivo?: string
  vigencia_hasta?: string | null
  descripcion?: string
}

/** Un soporte vence si `vigencia_hasta` es anterior a la fecha de referencia (YYYY-MM-DD). */
export function evaluarSoportes(exigidos: string[], indice: Soporte[], fechaReferencia: string): SoporteEvaluado[] {
  return exigidos.map((tipo) => {
    const soporte = indice.find((s) => s.tipo === tipo)
    if (!soporte) return { tipo, estado: "ausente" }
    const vencido = soporte.vigencia_hasta !== null && soporte.vigencia_hasta < fechaReferencia
    return {
      tipo,
      estado: vencido ? "vencido" : "presente",
      archivo: soporte.archivo,
      vigencia_hasta: soporte.vigencia_hasta,
      descripcion: soporte.descripcion,
    }
  })
}

/** RN3: ausentes o vencidos bloquean la firma; los campos faltantes no. */
export function listoParaFirma(soportes: SoporteEvaluado[]): boolean {
  return soportes.every((s) => s.estado === "presente")
}

export function esFechaValida(fecha: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(fecha) && !Number.isNaN(Date.parse(`${fecha}T00:00:00Z`))
}
