// Lectura validada de los fixtures del reto (solo lectura): solicitudes y maestros.
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"

export const BASE_FIXTURES = "fixtures/reto-03"

/** Error esperado de datos de entrada: se devuelve como { ok: false, error } con una acción sugerida. */
export class ErrorFixture extends Error {}

const monto = (campo: string) =>
  z.number({ error: (i) => (i.input === undefined ? `falta ${campo}` : `monto no numérico en ${campo}: ${JSON.stringify(i.input)}`) }).finite()

export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string(),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().regex(/^\d{6,12}$/, "NIT sin formato numérico").optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: monto("cantidad").positive(),
  valor_unitario: monto("valor_unitario").nonnegative(),
  valor_total: monto("valor_total").positive(),
  moneda: z.string().min(3),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha_solicitud debe ser YYYY-MM-DD"),
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  para: z.string().optional(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string().optional(),
  adjuntos: z.array(z.string()).optional(),
})
export type Correo = z.infer<typeof CorreoSchema>

export const AprobacionSchema = z.object({
  de: z.string(),
  para: z.string().optional(),
  cc: z.array(z.string()).optional(),
  fecha: z.string(),
  asunto: z.string(),
  cuerpo: z.string(),
})
export type AprobacionArchivo = z.infer<typeof AprobacionSchema>

export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})
export type Proveedor = z.infer<typeof ProveedorSchema>

export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string().optional(),
  subareas: z.array(z.string()),
  aprobadores: z.array(z.object({ email: z.string(), nombre: z.string().optional(), tope: z.number() })),
})
export type CentroCosto = z.infer<typeof CentroCostoSchema>

export const IndicadorIvaSchema = z.object({ codigo: z.string(), descripcion: z.string(), tasa: z.number() })
export const CondicionPagoSchema = z.object({ codigo: z.string(), descripcion: z.string(), dias: z.number() })

export interface Maestros {
  proveedores: Proveedor[]
  centros: CentroCosto[]
  indicadoresIva: z.infer<typeof IndicadorIvaSchema>[]
  condicionesPago: z.infer<typeof CondicionPagoSchema>[]
}

const CASO_VALIDO = /^[a-z0-9][a-z0-9-]{0,63}$/

function ruta(directory: string, ...partes: string[]): string {
  return join(directory, BASE_FIXTURES, ...partes)
}

async function leerTextoOpcional(rutaArchivo: string): Promise<string | null> {
  try {
    return await readFile(rutaArchivo, "utf8")
  } catch {
    return null
  }
}

function describirIssues(error: z.ZodError): string {
  return error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ")
}

/** Parsea y valida un JSON; los errores salen en lenguaje claro (HU-6). */
export function parsearJson<T>(texto: string, schema: z.ZodType<T>, archivo: string): T {
  let valor: unknown
  try {
    valor = JSON.parse(texto)
  } catch {
    throw new ErrorFixture(`JSON malformado en ${archivo}: no se puede leer. Pide al solicitante reenviar el archivo.`)
  }
  const r = schema.safeParse(valor)
  if (!r.success) throw new ErrorFixture(`datos inválidos en ${archivo}: ${describirIssues(r.error)}. Pide al solicitante corregirlo.`)
  return r.data
}

async function leerJsonOpcional<T>(rutaArchivo: string, schema: z.ZodType<T>, archivo: string): Promise<T | null> {
  const texto = await leerTextoOpcional(rutaArchivo)
  return texto === null ? null : parsearJson(texto, schema, archivo)
}

async function leerJson<T>(rutaArchivo: string, schema: z.ZodType<T>, archivo: string): Promise<T> {
  const valor = await leerJsonOpcional(rutaArchivo, schema, archivo)
  if (valor === null) throw new ErrorFixture(`no existe ${archivo}`)
  return valor
}

export async function listarCasos(directory: string): Promise<string[]> {
  const entradas = await readdir(ruta(directory, "solicitudes"), { withFileTypes: true })
  return entradas.filter((e) => e.isDirectory()).map((e) => e.name).sort()
}

export async function validarCaso(directory: string, caso: string): Promise<void> {
  if (!CASO_VALIDO.test(caso)) throw new ErrorFixture(`nombre de caso inválido: '${caso}'`)
  const casos = await listarCasos(directory)
  if (!casos.includes(caso)) throw new ErrorFixture(`caso inexistente: '${caso}'. Casos disponibles: ${casos.join(", ")}`)
}

/** Archivos crudos de un caso. Un adjunto ausente queda en null; solo correo y solicitud son indispensables. */
export interface ArchivosCaso {
  correo: Correo
  solicitud: Solicitud
  cotizacionTexto: string | null
  aprobacion: AprobacionArchivo | null
  facturaTexto: string | null
}

export async function leerArchivosCaso(directory: string, caso: string): Promise<ArchivosCaso> {
  const base = (archivo: string) => ruta(directory, "solicitudes", caso, archivo)
  const correo = await leerJsonOpcional(base("correo.json"), CorreoSchema, "correo.json")
  const solicitud = await leerJsonOpcional(base("solicitud.json"), SolicitudSchema, "solicitud.json")
  const faltan = [!correo && "correo.json", !solicitud && "solicitud.json (Excel de solicitud)"].filter(Boolean)
  if (!correo || !solicitud)
    throw new ErrorFixture(`paquete incompleto: falta ${faltan.join(" y ")}. Pide al solicitante reenviar el correo con la solicitud.`)
  return {
    correo,
    solicitud,
    cotizacionTexto: await leerTextoOpcional(base("cotizacion.txt")),
    aprobacion: await leerJsonOpcional(base("aprobacion.json"), AprobacionSchema, "aprobacion.json"),
    facturaTexto: await leerTextoOpcional(base("factura.txt")),
  }
}

export async function leerMaestros(directory: string): Promise<Maestros> {
  const m = (archivo: string) => ruta(directory, "maestros", archivo)
  const [proveedores, centros, indicadoresIva, condicionesPago] = await Promise.all([
    leerJson(m("proveedores.json"), z.array(ProveedorSchema), "maestros/proveedores.json"),
    leerJson(m("centros-costo.json"), z.array(CentroCostoSchema), "maestros/centros-costo.json"),
    leerJson(m("indicadores-iva.json"), z.array(IndicadorIvaSchema), "maestros/indicadores-iva.json"),
    leerJson(m("condiciones-pago.json"), z.array(CondicionPagoSchema), "maestros/condiciones-pago.json"),
  ])
  return { proveedores, centros, indicadoresIva, condicionesPago }
}
