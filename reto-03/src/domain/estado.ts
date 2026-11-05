// Estado de una solicitud en out/<caso>/estado.json (en la web, dentro del espacio de la sesión).
import type { Storage } from "../core/storage.ts"
import type { ResultadoValidacion } from "./reglas.ts"

export interface EstadoCaso {
  paquete_leido?: boolean
  validacion?: ResultadoValidacion
  evidencia?: { ruta: string; ruta_pdf: string; sha256: string }
  payload?: { ruta: string; trazabilidad: string; hash: string }
  oc?: { numero_oc: string; fecha: string }
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
