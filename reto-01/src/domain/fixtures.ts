// Lectura validada de los fixtures del reto (solo lectura).
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"

export const BASE_FIXTURES = "fixtures/reto-01"

export const SolicitudSchema = z.object({
  id: z.string(),
  de: z.string(),
  para: z.string().optional(),
  asunto: z.string(),
  fecha: z.string(),
  pais: z.string(),
  cliente: z.string(),
  formato: z.enum(["xlsx", "pdf", "portal"]),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export const CeldaSchema = z.object({
  hoja: z.string().min(1),
  celda_etiqueta: z.string().regex(/^[A-Z]+\d+$/),
  etiqueta: z.string().min(1),
  celda_valor: z.string().regex(/^[A-Z]+\d+$/),
})
export type Celda = z.infer<typeof CeldaSchema>

export const CampoPlantillaSchema = z.object({ etiqueta: z.string().min(1), obligatorio: z.boolean() })
export type CampoPlantilla = z.infer<typeof CampoPlantillaSchema>

export const SoporteSchema = z.object({
  tipo: z.string(),
  archivo: z.string(),
  vigencia_hasta: z.string().nullable(),
  pais_emisor: z.string(),
  descripcion: z.string(),
})
export type Soporte = z.infer<typeof SoporteSchema>

export type Maestro = Record<string, unknown>
export type Glosario = Record<string, string>

const CASO_VALIDO = /^[a-z0-9][a-z0-9-]{0,63}$/

export class ErrorFixture extends Error {}

function rutaFixture(directory: string, ...partes: string[]): string {
  return join(directory, BASE_FIXTURES, ...partes)
}

async function leerJson<T>(ruta: string, schema: z.ZodType<T>, descripcion: string): Promise<T> {
  let texto: string
  try {
    texto = await readFile(ruta, "utf8")
  } catch {
    throw new ErrorFixture(`no existe ${descripcion}`)
  }
  let valor: unknown
  try {
    valor = JSON.parse(texto)
  } catch {
    throw new ErrorFixture(`${descripcion}: archivo corrupto (JSON inválido)`)
  }
  const r = schema.safeParse(valor)
  if (!r.success) throw new ErrorFixture(`${descripcion} no tiene el formato esperado`)
  return r.data
}

export async function listarCasos(directory: string): Promise<string[]> {
  const entradas = await readdir(rutaFixture(directory, "casos"), { withFileTypes: true }).catch(() => [])
  return entradas.filter((e) => e.isDirectory()).map((e) => e.name).sort()
}

export async function validarCaso(directory: string, caso: string): Promise<void> {
  if (!CASO_VALIDO.test(caso)) throw new ErrorFixture(`nombre de caso inválido: ${caso}`)
  const casos = await listarCasos(directory)
  if (!casos.includes(caso))
    throw new ErrorFixture(`caso inexistente: ${caso}. Casos disponibles: ${casos.join(", ") || "ninguno"}`)
}

export function leerSolicitud(directory: string, caso: string): Promise<Solicitud> {
  return leerJson(rutaFixture(directory, "casos", caso, "solicitud.json"), SolicitudSchema, `solicitud.json del caso ${caso}`)
}

export function leerPlantillaCeldas(directory: string, caso: string): Promise<Celda[]> {
  return leerJson(
    rutaFixture(directory, "casos", caso, "plantilla-celdas.json"),
    z.array(CeldaSchema).min(1),
    "la plantilla Excel (plantilla-celdas.json)",
  )
}

export function leerPlantillaCampos(directory: string, caso: string): Promise<CampoPlantilla[]> {
  return leerJson(
    rutaFixture(directory, "casos", caso, "plantilla-campos.json"),
    z.array(CampoPlantillaSchema).min(1),
    "la plantilla de campos (plantilla-campos.json)",
  )
}

export function leerSoportesExigidos(directory: string, caso: string): Promise<string[]> {
  return leerJson(
    rutaFixture(directory, "casos", caso, "soportes-exigidos.json"),
    z.array(z.string()),
    "soportes-exigidos.json",
  )
}

export function leerMaestro(directory: string): Promise<Maestro> {
  return leerJson(rutaFixture(directory, "repositorio", "maestro.json"), z.record(z.string(), z.unknown()), "el maestro")
}

export function leerGlosario(directory: string): Promise<Glosario> {
  return leerJson(rutaFixture(directory, "glosario-campos.json"), z.record(z.string(), z.string()), "el glosario")
}

export function leerIndiceSoportes(directory: string): Promise<Soporte[]> {
  return leerJson(
    rutaFixture(directory, "repositorio", "soportes", "index.json"),
    z.array(SoporteSchema),
    "el índice de soportes",
  )
}

export async function leerArchivoSoporte(directory: string, archivo: string): Promise<Uint8Array> {
  if (!/^[\w.-]+$/.test(archivo)) throw new ErrorFixture(`nombre de soporte inválido: ${archivo}`)
  return new Uint8Array(await readFile(rutaFixture(directory, "repositorio", "soportes", archivo)))
}
