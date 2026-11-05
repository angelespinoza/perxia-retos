// Clasificación contra el maestro (RN1–RN5) y construcción de la fila a escribir. Funciones puras.
import type { Campo, Contrato, Extraccion } from "./extraccion.ts"
import { jaccard, slug } from "./texto.ts"

export type Clasificacion = "nuevo" | "actualizacion" | "duplicado" | "rechazado"
export type Fila = Record<string, string>

export const UMBRAL_CONFIANZA = 0.8
export const UMBRAL_SIMILITUD = 0.9

/** Campos que un documento puede modificar en una fila existente; la identidad del cliente no se pisa. */
const ACTUALIZABLES = ["objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza"] as const
const OBLIGATORIOS_NUEVO: Campo[] = ["cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin"]

export type Cambios = Record<string, [string, string]>

export interface Validacion {
  clasificacion: Clasificacion
  id_contrato: string
  id_contrato_existente?: string
  requiere_revision: string[]
  /** Motivo de cada campo en revisión (confianza o conflicto). */
  motivos_revision: Record<string, string>
  diferencias?: Cambios
  motivo?: string
  estado_poliza: string
}

/** Valor de un campo del contrato como texto del CSV. */
export function aCsv(campo: string, valor: unknown): string {
  if (valor === null || valor === undefined) return ""
  if (typeof valor === "boolean") return valor ? "true" : "false"
  if (typeof valor === "number") return String(valor)
  return String(valor)
}

function iguales(campo: string, doc: string, maestro: string): boolean {
  if (campo === "valor") return Number(doc) === Number(maestro)
  if (campo === "tipo_poliza") return [...new Set(doc.split(";").filter(Boolean))].sort().join(";") === [...new Set(maestro.split(";").filter(Boolean))].sort().join(";")
  return doc.trim().toLowerCase() === maestro.trim().toLowerCase()
}

/** Diferencias entre lo que trae el documento (sin null) y la fila existente. */
export function diferencias(c: Contrato, fila: Fila): Cambios {
  const cambios: Cambios = {}
  for (const campo of ACTUALIZABLES) {
    const nuevo = c[campo]
    if (nuevo === null) continue
    const antes = fila[campo] ?? ""
    const despues = aCsv(campo, nuevo)
    if (!iguales(campo, despues, antes)) cambios[campo] = [antes, despues]
  }
  return cambios
}

function buscarSimilar(c: Contrato, maestro: Fila[]): Fila | undefined {
  if (!c.nit_cliente || !c.objeto) return undefined
  return maestro.find((f) => f.nit_cliente === c.nit_cliente && jaccard(f.objeto ?? "", c.objeto ?? "") >= UMBRAL_SIMILITUD)
}

function revisionPorConfianza(ext: Extraccion, campos: readonly Campo[], motivos: Record<string, string>): void {
  for (const campo of campos) {
    const confianza = ext.confianza[campo]
    const ausente = ext.contrato[campo] === null
    if (confianza < UMBRAL_CONFIANZA) motivos[campo] = ausente ? "no aparece en el documento" : `confianza ${confianza}`
  }
}

/** Propuesta de estado de póliza (7.2): nuevo con póliza → pendiente; otrosí que amplía plazo de una póliza vigente → pendiente. */
function estadoPoliza(c: Contrato, existente: Fila | undefined, cambios: Cambios): string {
  if (!existente) return c.requiere_poliza ? "pendiente" : "no_aplica"
  const actual = existente.estado_poliza ?? ""
  const requiere = cambios.requiere_poliza ? cambios.requiere_poliza[1] === "true" : existente.requiere_poliza === "true"
  if (!requiere) return "no_aplica"
  if (cambios.requiere_poliza) return "pendiente"
  const amplia = cambios.fecha_fin && cambios.fecha_fin[1] > cambios.fecha_fin[0]
  if (c.es_otrosi && amplia && actual === "vigente") return "pendiente"
  return actual || "pendiente"
}

export function clasificar(ext: Extraccion | null, maestro: Fila[], motivoSinContrato?: string): Validacion {
  const base = { requiere_revision: [], motivos_revision: {}, estado_poliza: "" }
  if (!ext) return { ...base, clasificacion: "rechazado", id_contrato: "", motivo: motivoSinContrato ?? "sin adjunto de contrato" }
  const c = ext.contrato
  const id = c.id_contrato ?? ""
  if (!c.es_otrosi && ((!c.cliente && !c.nit_cliente) || !c.objeto))
    return { ...base, clasificacion: "rechazado", id_contrato: id, motivo: "el texto no contiene partes ni objeto identificables" }

  const porId = c.id_contrato ? maestro.find((f) => f.id_contrato === c.id_contrato) : undefined
  const existente = porId ?? (c.es_otrosi ? undefined : buscarSimilar(c, maestro))
  if (c.es_otrosi && !existente)
    return { ...base, clasificacion: "rechazado", id_contrato: id, motivo: `otrosí de un contrato que no está en el maestro (${id || "sin número"})` }

  const motivos: Record<string, string> = {}
  if (!existente) {
    revisionPorConfianza(ext, ["id_contrato", ...OBLIGATORIOS_NUEVO, "requiere_poliza", "tipo_poliza"], motivos)
    return {
      clasificacion: "nuevo",
      id_contrato: id,
      requiere_revision: Object.keys(motivos),
      motivos_revision: motivos,
      estado_poliza: estadoPoliza(c, undefined, {}),
    }
  }

  const cambios = diferencias(c, existente)
  // Solo se revisa la confianza de lo que el documento trae y se escribiría.
  revisionPorConfianza(ext, ["id_contrato", ...ACTUALIZABLES].filter((k): k is Campo => k === "id_contrato" || c[k as Campo] !== null), motivos)
  if (c.nit_cliente && existente.nit_cliente && c.nit_cliente !== existente.nit_cliente)
    motivos.nit_cliente = `conflicto con el maestro (${existente.nit_cliente})`
  if (cambios.moneda) motivos.moneda = `conflicto con el maestro (${existente.moneda})`
  if (!porId && c.id_contrato) motivos.id_contrato = `el documento dice ${c.id_contrato}; en el maestro es ${existente.id_contrato}`

  const estado = estadoPoliza(c, existente, cambios)
  if (estado !== (existente.estado_poliza ?? "")) cambios.estado_poliza = [existente.estado_poliza ?? "", estado]
  const duplicado =
    !c.es_otrosi && ["valor", "fecha_inicio", "fecha_fin"].every((k) => !cambios[k]) && c.valor !== null && c.fecha_fin !== null
  return {
    clasificacion: duplicado ? "duplicado" : "actualizacion",
    id_contrato: existente.id_contrato ?? id,
    id_contrato_existente: existente.id_contrato,
    requiere_revision: duplicado ? [] : Object.keys(motivos),
    motivos_revision: duplicado ? {} : motivos,
    diferencias: duplicado ? {} : cambios,
    estado_poliza: estado,
  }
}

/** AUTO-<año>-<secuencia> para documentos sin número (7.2). */
export function siguienteAuto(maestro: Fila[], anio: string): string {
  const prefijo = `AUTO-${anio}-`
  const usados = maestro.map((f) => f.id_contrato ?? "").filter((id) => id.startsWith(prefijo)).map((id) => Number(id.slice(prefijo.length)))
  return `${prefijo}${String(Math.max(0, ...usados.filter(Number.isFinite)) + 1).padStart(3, "0")}`
}

export function rutaArchivo(c: Contrato, id: string, existente: Fila | undefined, extension: string): string {
  const anio = (existente?.fecha_inicio || c.fecha_inicio || "").slice(0, 4) || "sin-fecha"
  const carpeta = existente?.ruta_sharepoint ? existente.ruta_sharepoint.split("/").slice(0, -1).join("/") : `Contratos/${anio}/${slug(c.cliente ?? existente?.cliente ?? "")}`
  const nombre = c.es_otrosi ? `${id}-otrosi-${c.numero_otrosi ?? 1}` : id
  return `${carpeta}/${nombre}${extension}`
}

export interface DatosRegistro {
  comercial: string
  ruta: string
  hoy: string
}

export function filaNueva(c: Contrato, v: Validacion, d: DatosRegistro): Fila {
  return {
    id_contrato: v.id_contrato,
    cliente: aCsv("cliente", c.cliente),
    nit_cliente: aCsv("nit_cliente", c.nit_cliente),
    pais: aCsv("pais", c.pais),
    objeto: aCsv("objeto", c.objeto),
    valor: aCsv("valor", c.valor),
    moneda: aCsv("moneda", c.moneda),
    fecha_inicio: aCsv("fecha_inicio", c.fecha_inicio),
    fecha_fin: aCsv("fecha_fin", c.fecha_fin),
    requiere_poliza: aCsv("requiere_poliza", c.requiere_poliza ?? false),
    tipo_poliza: aCsv("tipo_poliza", c.requiere_poliza ? c.tipo_poliza : ""),
    estado_poliza: v.estado_poliza,
    comercial: d.comercial,
    ruta_sharepoint: d.ruta,
    fecha_registro: d.hoy,
    fuente: "buzon",
  }
}

export function aplicarCambios(fila: Fila, cambios: Cambios): Fila {
  const nueva = { ...fila }
  for (const [campo, [, despues]] of Object.entries(cambios)) nueva[campo] = despues
  return nueva
}
