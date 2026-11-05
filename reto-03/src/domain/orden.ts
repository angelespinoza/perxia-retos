// Payload de la OC (sección 7.4) con esquema zod, trazabilidad por campo y evidencia de aprobación.
import { createHash } from "node:crypto"
import { PDFDocument, rgb, StandardFonts } from "pdf-lib"
import { z } from "zod"
import type { AprobacionArchivo } from "./fixtures.ts"
import { normalizarTexto, type Paquete } from "./paquete.ts"
import type { ResultadoValidacion } from "./reglas.ts"

export const OrdenCompraSchema = z.object({
  referencia: z.object({ solicitud_id: z.string(), correo_id: z.string(), cotizacion_ref: z.string().nullable() }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string().min(1), nit: z.string().min(1), nombre: z.string().min(1) }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string().min(1),
  aprobador: z.object({
    email: z.string().min(3),
    fecha_aprobacion: z.string(),
    evidencia_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int().positive().multipleOf(10),
        descripcion: z.string().min(1).max(40),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string().min(1),
        subarea: z.string().min(1),
        indicador_iva: z.string().min(1),
      }),
    )
    .min(1),
  excepciones: z.array(z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() })),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>

export type Fuente = "solicitud" | "cotizacion" | `maestro.${string}` | "derivado"
export interface Traza {
  fuente: Fuente
  valor: unknown
  detalle?: string
}
export type Trazabilidad = Record<string, Traza>

const LIMITE_DESCRIPCION = 40

/** Texto breve SAP: máximo 40 caracteres, cortado en límite de palabra. */
export function truncarDescripcion(texto: string, limite = LIMITE_DESCRIPCION): string {
  const limpio = texto.replace(/\s+/g, " ").trim()
  if (limpio.length <= limite) return limpio
  const corte = limpio.slice(0, limite + 1)
  const espacio = corte.lastIndexOf(" ")
  const base = espacio > limite / 2 ? corte.slice(0, espacio) : limpio.slice(0, limite)
  return base.replace(/[\s,.;:–-]+$/, "").replace(CONECTORES_FINALES, "")
}

/** Palabras que no deben quedar al final de un texto truncado («… de arquitectura de»). */
const CONECTORES_FINALES = /(\s+(de|del|la|las|el|los|para|por|y|con|a|en|e|o|u))+$/i

/** «horas» → H, «mensual» → MES, el resto → UN. */
export function derivarUnidad(descripcion: string): "UN" | "H" | "MES" {
  const texto = normalizarTexto(descripcion)
  if (/\bhoras?\b/.test(texto)) return "H"
  if (/\bmensual(es|idad)?\b|\bpor mes\b/.test(texto)) return "MES"
  return "UN"
}

/** JSON con claves ordenadas: el mismo payload da el mismo hash aunque cambie el orden de las claves. */
export function jsonCanonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(",")}]`
  if (valor && typeof valor === "object")
    return `{${Object.entries(valor as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${jsonCanonico(v)}`)
      .join(",")}}`
  return JSON.stringify(valor)
}

export const sha256 = (contenido: string | Uint8Array) => createHash("sha256").update(contenido).digest("hex")

export function hashPayload(orden: OrdenCompra): string {
  return sha256(jsonCanonico(orden))
}

export interface ResultadoConstruccion {
  orden: OrdenCompra
  trazabilidad: Trazabilidad
}

/** Construye la OC con los valores de la solicitud; los derivados salen de la validación, nunca del modelo. */
export function construirOrden(p: Paquete, v: ResultadoValidacion, evidenciaSha: string): ResultadoConstruccion {
  const s = p.solicitud
  const prov = v.derivados.proveedor
  if (!prov || !p.aprobacion) throw new Error("la solicitud no es apta: falta proveedor o aprobación válidos")
  const iva = s.indicador_iva ?? v.derivados.indicador_iva?.valor
  const pago = s.condiciones_pago ?? v.derivados.condiciones_pago?.valor
  const descripcion = truncarDescripcion(s.descripcion)
  const unidad = derivarUnidad(s.descripcion)

  const candidato = {
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.numero ?? null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: prov.codigo_sap, nit: prov.nit, nombre: prov.nombre },
    moneda: s.moneda,
    condiciones_pago: pago,
    aprobador: { email: p.aprobacion.de, fecha_aprobacion: p.aprobacion.fecha, evidencia_sha256: evidenciaSha },
    posiciones: [
      {
        numero: 10,
        descripcion,
        cantidad: s.cantidad,
        unidad,
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: iva,
      },
    ],
    excepciones: v.confirmaciones.map((c) => ({ codigo: c.regla, detalle: c.detalle, confirmado_por: null })),
  }
  const r = OrdenCompraSchema.safeParse(candidato)
  if (!r.success)
    throw new Error(`el payload no cumple el esquema de OC: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`)

  const derivado = (valor: unknown, detalle: string): Traza => ({ fuente: "derivado", valor, detalle })
  const ivaTraza: Traza = s.indicador_iva
    ? { fuente: "solicitud", valor: iva }
    : derivado(iva, v.derivados.indicador_iva?.detalle ?? "indicador_iva_default del proveedor (RC6)")
  const pagoTraza: Traza = s.condiciones_pago
    ? { fuente: "solicitud", valor: pago }
    : derivado(pago, v.derivados.condiciones_pago?.detalle ?? "condiciones_pago_default del proveedor (RC7)")
  const trazabilidad: Trazabilidad = {
    "referencia.solicitud_id": { fuente: "solicitud", valor: s.solicitud_id },
    "referencia.correo_id": derivado(p.correo.id, "id del correo de entrada (correo.json)"),
    "referencia.cotizacion_ref": p.cotizacion ? { fuente: "cotizacion", valor: p.cotizacion.numero } : derivado(null, "sin cotización"),
    sociedad: derivado("1000", "valor fijo de la sociedad Periferia"),
    organizacion_compras: derivado("1000", "valor fijo de la organización de compras"),
    "proveedor.codigo_sap": { fuente: "maestro.proveedores", valor: prov.codigo_sap, detalle: `resuelto por ${prov.resuelto_por}` },
    "proveedor.nit": s.proveedor_nit ? { fuente: "solicitud", valor: s.proveedor_nit } : { fuente: "maestro.proveedores", valor: prov.nit },
    "proveedor.nombre": { fuente: "maestro.proveedores", valor: prov.nombre },
    moneda: { fuente: "solicitud", valor: s.moneda },
    condiciones_pago: pagoTraza,
    "aprobador.email": { fuente: "maestro.centros-costo", valor: p.aprobacion.de, detalle: "remitente de la aprobación, listado como aprobador del centro" },
    "aprobador.fecha_aprobacion": derivado(p.aprobacion.fecha, "fecha del correo de aprobación (aprobacion.json)"),
    "aprobador.evidencia_sha256": derivado(evidenciaSha, "sha256 de aprobacion.txt"),
    "posiciones[0].numero": derivado(10, "primera posición SAP"),
    "posiciones[0].descripcion": {
      fuente: "solicitud",
      valor: descripcion,
      ...(descripcion !== s.descripcion ? { detalle: `truncada a 40 caracteres; texto completo: «${s.descripcion}»` } : {}),
    },
    "posiciones[0].cantidad": { fuente: "solicitud", valor: s.cantidad },
    "posiciones[0].unidad": derivado(unidad, "derivada de la descripción (horas → H, mensual → MES, resto → UN)"),
    "posiciones[0].precio_unitario": { fuente: "solicitud", valor: s.valor_unitario },
    "posiciones[0].centro_costo": { fuente: "solicitud", valor: s.centro_costo },
    "posiciones[0].subarea": { fuente: "solicitud", valor: s.subarea },
    "posiciones[0].indicador_iva": ivaTraza,
    excepciones: derivado(r.data.excepciones.map((e) => e.codigo), "confirmaciones de oc_validar"),
  }
  return { orden: r.data, trazabilidad }
}

// ---------- evidencia de aprobación (HU-4) ----------

export function textoEvidencia(a: AprobacionArchivo): string {
  return [
    `De: ${a.de}`,
    `Para: ${a.para ?? ""}`,
    ...(a.cc?.length ? [`CC: ${a.cc.join(", ")}`] : []),
    `Fecha: ${a.fecha}`,
    `Asunto: ${a.asunto}`,
    "",
    a.cuerpo,
    "",
  ].join("\n")
}

/** aprobacion.txt: encabezados, cuerpo y sha256 del contenido (calculado sobre encabezados + cuerpo). */
export function generarEvidenciaTxt(a: AprobacionArchivo): { contenido: string; sha256: string } {
  const texto = textoEvidencia(a)
  const hash = sha256(texto)
  return { contenido: `${texto}\n---\nSHA-256 del contenido: ${hash}\n`, sha256: hash }
}

/** P1: el mismo contenido en PDF. */
export async function generarEvidenciaPdf(a: AprobacionArchivo, hash: string, caso: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(`Evidencia de aprobación ${caso}`)
  pdf.setCreator("Agente Órdenes de Compra SAP")
  const pagina = pdf.addPage([595, 842])
  const normal = await pdf.embedFont(StandardFonts.Helvetica)
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold)
  let y = 790
  const escribir = (texto: string, fuente = normal, tamano = 10) => {
    for (const linea of partirLinea(texto, 95)) {
      pagina.drawText(linea, { x: 50, y, size: tamano, font: fuente, color: rgb(0.1, 0.1, 0.1) })
      y -= tamano + 5
    }
  }
  escribir("Evidencia de aprobación de orden de compra", negrita, 14)
  y -= 8
  for (const linea of textoEvidencia(a).split("\n")) escribir(linea)
  y -= 8
  escribir("SHA-256 del contenido:", negrita, 9)
  escribir(hash, normal, 9)
  return pdf.save()
}

function partirLinea(texto: string, ancho: number): string[] {
  if (texto.length <= ancho) return [texto]
  const lineas: string[] = []
  let actual = ""
  for (const palabra of texto.split(" ")) {
    if ((actual + " " + palabra).trim().length > ancho) {
      lineas.push(actual)
      actual = palabra
    } else actual = `${actual} ${palabra}`.trim()
  }
  return [...lineas, actual]
}
