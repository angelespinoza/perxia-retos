// Generación de formularios (xlsx, pdf, portal) y textos del paquete para firma.
import ExcelJS from "exceljs"
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib"
import type { CampoPlantilla, Celda, Solicitud } from "./fixtures.ts"
import type { CampoMapeado } from "./mapeo.ts"
import type { SoporteEvaluado } from "./soportes.ts"

function porEtiqueta(campos: CampoMapeado[]): Map<string, CampoMapeado> {
  return new Map(campos.map((c) => [c.etiqueta, c]))
}

function textoValor(c: CampoMapeado | undefined): string {
  return c?.valor === undefined ? "" : String(c.valor)
}

/** P0: escribe etiqueta y valor en la hoja y celda que indica plantilla-celdas.json. */
export async function generarXlsx(celdas: Celda[], campos: CampoMapeado[]): Promise<Uint8Array> {
  const libro = new ExcelJS.Workbook()
  libro.creator = "Agente Registro como Proveedor"
  const mapa = porEtiqueta(campos)
  for (const celda of celdas) {
    const hoja = libro.getWorksheet(celda.hoja) ?? libro.addWorksheet(celda.hoja)
    const etiqueta = hoja.getCell(celda.celda_etiqueta)
    etiqueta.value = celda.etiqueta
    etiqueta.font = { bold: true }
    const campo = mapa.get(celda.etiqueta)
    const valor = hoja.getCell(celda.celda_valor)
    valor.value = campo?.valor ?? ""
    if (!campo || campo.estado === "faltante") marcar(valor, "FFFFF2CC", "FALTANTE: no existe en el maestro")
    else if (campo.estado === "requiere_confirmacion") marcar(valor, "FFFCE4D6", `REQUIERE CONFIRMACIÓN: ${campo.nota ?? ""}`)
    else if (campo.nota) valor.note = campo.nota
  }
  for (const hoja of libro.worksheets) {
    hoja.columns.forEach((columna) => {
      columna.width = 34
    })
  }
  return new Uint8Array(await libro.xlsx.writeBuffer())
}

/** Resalta la celda y deja la explicación como nota. */
function marcar(celda: ExcelJS.Cell, color: string, nota: string): void {
  celda.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } }
  celda.note = nota
}

/** pdf-lib con fuentes estándar solo admite WinAnsi: se reemplazan caracteres fuera de ese juego. */
function winAnsi(texto: string): string {
  return texto.replace(/[^\x20-\x7E -ÿ–—‘’“”•€]/g, "?")
}

function partirLineas(texto: string, fuente: PDFFont, tamano: number, ancho: number): string[] {
  const lineas: string[] = []
  let actual = ""
  for (const palabra of winAnsi(texto).split(/\s+/)) {
    const prueba = actual ? `${actual} ${palabra}` : palabra
    if (fuente.widthOfTextAtSize(prueba, tamano) > ancho && actual) {
      lineas.push(actual)
      actual = palabra
    } else actual = prueba
  }
  if (actual) lineas.push(actual)
  return lineas.length > 0 ? lineas : [""]
}

/** P1: PDF generado con cada campo (etiqueta y valor) en el orden de plantilla-campos.json. */
export async function generarPdf(solicitud: Solicitud, plantilla: CampoPlantilla[], campos: CampoMapeado[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Formulario de proveedor - ${solicitud.cliente}`)
  const normal = await doc.embedFont(StandardFonts.Helvetica)
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold)
  const margen = 50
  const anchoValor = 300
  let pagina: PDFPage = doc.addPage([595, 842])
  let y = 842 - margen

  const escribir = (texto: string, x: number, fuente: PDFFont, tamano: number, color = rgb(0, 0, 0)) =>
    pagina.drawText(winAnsi(texto), { x, y, size: tamano, font: fuente, color })
  const asegurarEspacio = (alto: number) => {
    if (y - alto < margen) {
      pagina = doc.addPage([595, 842])
      y = 842 - margen
    }
  }

  escribir("Formulario de registro de proveedor", margen, negrita, 16)
  y -= 22
  escribir(`Cliente: ${solicitud.cliente} (${solicitud.pais})`, margen, normal, 11)
  y -= 16
  escribir(`Proveedor: Periferia IT Group S.A.S. · Solicitud ${solicitud.id} del ${solicitud.fecha}`, margen, normal, 10)
  y -= 28

  const mapa = porEtiqueta(campos)
  for (const item of plantilla) {
    const campo = mapa.get(item.etiqueta)
    const etiqueta = `${item.etiqueta}${item.obligatorio ? " *" : ""}`
    const valor =
      !campo || campo.estado === "faltante"
        ? "[FALTANTE]"
        : campo.estado === "requiere_confirmacion"
          ? `${textoValor(campo)}  [REQUIERE CONFIRMACIÓN]`
          : textoValor(campo)
    const lineas = partirLineas(valor, normal, 10, anchoValor)
    asegurarEspacio(lineas.length * 13 + 8)
    escribir(etiqueta, margen, negrita, 10)
    const color = campo?.estado === "lleno" ? rgb(0, 0, 0) : rgb(0.75, 0.1, 0.1)
    for (const linea of lineas) {
      escribir(linea, margen + 195, normal, 10, color)
      y -= 13
    }
    y -= 6
  }
  asegurarEspacio(60)
  y -= 20
  escribir("* Campo obligatorio. Firma del representante legal: ______________________", margen, normal, 9)
  return doc.save()
}

/** P2: valores listos para copiar en el portal del cliente. */
export function generarValoresPortal(solicitud: Solicitud, campos: CampoMapeado[]): string {
  const filas = campos.map((c) => `| ${c.etiqueta} | ${textoValor(c) || "—"} | ${c.estado}${c.nota ? ` (${c.nota})` : ""} |`)
  return [
    `# Valores para el portal de ${solicitud.cliente}`,
    "",
    "Formato no soportado para llenado automático: el ingreso de credenciales y el clic en «Enviar» los hace una persona.",
    "",
    "| Campo | Valor | Estado |",
    "| --- | --- | --- |",
    ...filas,
    "",
  ].join("\n")
}

export function generarChecklist(
  solicitud: Solicitud,
  soportes: SoporteEvaluado[],
  campos: CampoMapeado[],
  listo: boolean,
  fechaReferencia: string,
): string {
  const icono = { presente: "[x]", ausente: "[ ]", vencido: "[!]" } as const
  const lineasSoportes = soportes.map((s) => {
    const vigencia = s.vigencia_hasta ? `vigente hasta ${s.vigencia_hasta}` : "sin vencimiento"
    const detalle = s.estado === "ausente" ? "no existe en el repositorio" : `${s.archivo} · ${vigencia}`
    return `- ${icono[s.estado]} ${s.tipo} — ${s.estado.toUpperCase()} — ${detalle}`
  })
  const faltantes = campos.filter((c) => c.estado === "faltante").map((c) => `- ${c.etiqueta}`)
  const confirmar = campos.filter((c) => c.estado === "requiere_confirmacion").map((c) => `- ${c.etiqueta}: ${c.nota ?? ""}`)
  return [
    `# Checklist — ${solicitud.cliente}`,
    "",
    `Fecha de referencia: ${fechaReferencia}`,
    `Estado: **${listo ? "LISTO PARA FIRMA" : "NO LISTO PARA FIRMA"}**`,
    "",
    "## Soportes exigidos",
    ...lineasSoportes,
    "",
    "## Campos faltantes (no bloquean la firma)",
    ...(faltantes.length > 0 ? faltantes : ["- Ninguno"]),
    "",
    "## Campos que requieren confirmación",
    ...(confirmar.length > 0 ? confirmar : ["- Ninguno"]),
    "",
  ].join("\n")
}

/** RN2: el borrador nunca incluye datos bancarios ni valores del formulario.
 * Solo adjunta soportes vigentes; si el paquete no está listo, se encabeza con «BORRADOR — no enviar»
 * y la lista de pendientes, y no dice «firmado». */
export function generarBorradorCorreo(
  solicitud: Solicitud,
  soportes: SoporteEvaluado[],
  nombreFormulario: string,
  estado: { listo: boolean; pendientes: string[] } = { listo: true, pendientes: [] },
): string {
  const adjuntos = soportes.filter((s) => s.estado === "presente").map((s) => `- ${s.descripcion ?? s.tipo}`)
  const encabezado = estado.listo
    ? []
    : [
        "> **BORRADOR — no enviar.** El paquete no está listo para firma. Pendientes:",
        ...estado.pendientes.map((p) => `> - ${p}`),
        "",
      ]
  const formulario = estado.listo
    ? `el formulario de registro como proveedor (${nombreFormulario}) firmado por nuestro representante legal`
    : `el formulario de registro como proveedor (${nombreFormulario}), pendiente de firma del representante legal`
  return [
    ...encabezado,
    `Para: ${solicitud.de}`,
    `Asunto: RE: ${solicitud.asunto}`,
    "",
    "Buen día,",
    "",
    `En respuesta a su solicitud del ${solicitud.fecha}, adjuntamos ${formulario}${adjuntos.length > 0 ? ", junto con los siguientes soportes:" : "."}`,
    "",
    ...adjuntos,
    ...(adjuntos.length > 0 ? [""] : []),
    "Quedamos atentos a cualquier información adicional.",
    "",
    "Cordialmente,",
    "Área Administrativa — Periferia IT Group S.A.S.",
    "",
  ].join("\n")
}
