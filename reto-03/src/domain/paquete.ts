// Paquete normalizado (sección 7.2): parser de cotización y factura, normalizadores de nombres, NIT y fechas.
import { type ArchivosCaso, ErrorFixture, type Solicitud } from "./fixtures.ts"

export interface Cotizacion {
  numero: string | null
  fecha: string | null
  proveedor: string
  nit: string | null
  total: number
  moneda: string
  validez_hasta: string | null
  texto: string
}

export interface Aprobacion {
  de: string
  para: string | null
  fecha: string
  asunto: string
  aprobado: boolean
  texto: string
}

export interface Factura {
  numero: string
  fecha: string
  total: number
}

export interface Paquete {
  correo: { id: string; de: string; asunto: string; fecha: string }
  solicitud: Solicitud
  cotizacion: Cotizacion | null
  aprobacion: Aprobacion | null
  factura: Factura | null
  /** Adjuntos que no llegaron, por nombre. */
  faltantes: string[]
}

/** Minúsculas, sin tildes ni espacios sobrantes. */
export function normalizarTexto(texto: string): string {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim()
}

const SUFIJOS_SOCIETARIOS = /\b(s ?a ?s|s ?a|ltda|limitada|s en c|e ?u)\b/g

/** Nombre de proveedor comparable: sin tildes, sin puntuación y sin «S.A.S.», «S.A.» o «Ltda.». */
export function normalizarNombre(nombre: string): string {
  return normalizarTexto(nombre)
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .replace(SUFIJOS_SOCIETARIOS, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** «900.555.111-2» → «900555111» (sin puntos ni dígito de verificación). */
export function normalizarNit(nit: string): string {
  return nit.replace(/-\d$/, "").replace(/\D/g, "")
}

/** «COP 11.400.000» o «11.400.000,50» (formato colombiano) → número. */
export function parsearMonto(texto: string, contexto: string): number {
  const limpio = texto.replace(/[A-Z$\s]/g, "")
  if (!/^\d{1,3}(\.\d{3})*(,\d+)?$|^\d+(,\d+)?$/.test(limpio))
    throw new ErrorFixture(`monto no numérico en ${contexto}: '${texto.trim()}'. Pide al solicitante el documento corregido.`)
  return Number(limpio.replace(/\./g, "").replace(",", "."))
}

/** Fecha calendario (YYYY-MM-DD) en America/Bogota, para comparar con fecha_solicitud. */
export function fechaBogota(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso
  const fecha = new Date(iso)
  if (Number.isNaN(fecha.getTime())) throw new ErrorFixture(`fecha inválida: '${iso}'`)
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(fecha)
}

export function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

function campo(texto: string, etiqueta: RegExp): string | null {
  return texto.match(etiqueta)?.[1]?.trim() ?? null
}

export function parsearCotizacion(texto: string): Cotizacion {
  const totalLinea = texto.match(/^TOTAL[^:\n]*:\s*([A-Z]{3})\s*([\d.,]+)\s*$/m)
  if (!totalLinea?.[1] || !totalLinea[2]) throw new ErrorFixture("cotizacion.txt sin línea TOTAL legible. Pide al proveedor la cotización completa.")
  const fecha = campo(texto, /^Fecha:\s*(\d{4}-\d{2}-\d{2})/m)
  const dias = campo(texto, /^Validez de la oferta:\s*(\d+)\s*d[ií]as/im)
  const nit = campo(texto, /^NIT:\s*([\d.\-]+)/m)
  return {
    numero: campo(texto, /^COTIZACI[OÓ]N\s+(\S+)/m),
    fecha,
    proveedor: campo(texto, /^Proveedor:\s*(.+)$/m) ?? "",
    nit: nit ? normalizarNit(nit) : null,
    total: parsearMonto(totalLinea[2], "cotizacion.txt (TOTAL)"),
    moneda: totalLinea[1],
    validez_hasta: fecha && dias ? sumarDias(fecha, Number(dias)) : null,
    texto,
  }
}

export function parsearFactura(texto: string): Factura {
  const numero = campo(texto, /^FACTURA[^\n]*No\.\s*(\S+)/m)
  const fecha = campo(texto, /^Fecha de emisi[oó]n:\s*(\d{4}-\d{2}-\d{2})/m)
  const total = campo(texto, /^TOTAL:\s*(.+)$/m)
  if (!numero || !fecha || !total) throw new ErrorFixture("factura.txt sin número, fecha de emisión o total legibles.")
  return { numero, fecha, total: parsearMonto(total, "factura.txt (TOTAL)") }
}

const NEGACION_APROBACION = /\b(no|sin|rechazad[oa])\b[^.\n]{0,20}\baprobad[oa]\b/

/** Contiene «aprobado/aprobada» y no está negado («no aprobado», «sin aprobar»). */
export function esAprobacion(cuerpo: string): boolean {
  const texto = normalizarTexto(cuerpo)
  return /\baprobad[oa]\b/.test(texto) && !NEGACION_APROBACION.test(texto)
}

export function armarPaquete(archivos: ArchivosCaso): Paquete {
  const { correo, solicitud, aprobacion } = archivos
  const faltantes: string[] = []
  if (archivos.cotizacionTexto === null) faltantes.push("cotizacion.pdf")
  if (aprobacion === null) faltantes.push("aprobacion.eml")
  const esperaFactura = (correo.adjuntos ?? []).some((a) => a.startsWith("factura"))
  if (esperaFactura && archivos.facturaTexto === null) faltantes.push("factura.pdf")
  return {
    correo: { id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha },
    solicitud,
    cotizacion: archivos.cotizacionTexto === null ? null : parsearCotizacion(archivos.cotizacionTexto),
    aprobacion: aprobacion
      ? {
          de: aprobacion.de,
          para: aprobacion.para ?? null,
          fecha: aprobacion.fecha,
          asunto: aprobacion.asunto,
          aprobado: esAprobacion(aprobacion.cuerpo),
          texto: aprobacion.cuerpo,
        }
      : null,
    factura: archivos.facturaTexto === null ? null : parsearFactura(archivos.facturaTexto),
    faltantes,
  }
}
