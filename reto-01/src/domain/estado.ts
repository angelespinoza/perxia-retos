// Estado de un caso en out/<caso>/estado.json (en la web, dentro del espacio de la sesión).
import type { Storage } from "../core/storage.ts"
import type { CampoMapeado } from "./mapeo.ts"
import type { SoporteEvaluado } from "./soportes.ts"

export interface EstadoCaso {
  campos?: CampoMapeado[]
  formulario?: { ruta: string; formato: string }
  soportes?: SoporteEvaluado[]
  listo_para_firma?: boolean
}

export async function leerEstado(storage: Storage, caso: string): Promise<EstadoCaso> {
  const texto = await storage.leerTexto(`${caso}/estado.json`)
  return texto ? (JSON.parse(texto) as EstadoCaso) : {}
}

export async function guardarEstado(storage: Storage, caso: string, cambios: EstadoCaso): Promise<EstadoCaso> {
  const estado = { ...(await leerEstado(storage, caso)), ...cambios }
  await storage.escribir(`${caso}/estado.json`, JSON.stringify(estado, null, 2))
  return estado
}

/** Lo que impide firmar: soportes ausentes o vencidos y la falta de formulario. */
export function pendientesDelPaquete(soportes: SoporteEvaluado[], hayFormulario: boolean): string[] {
  const pendientes = soportes
    .filter((s) => s.estado !== "presente")
    .map((s) => (s.estado === "vencido" ? `${s.tipo}: vencido (vigencia hasta ${s.vigencia_hasta})` : `${s.tipo}: ausente`))
  if (!hayFormulario) pendientes.push("formulario: no se pudo generar")
  return pendientes
}
