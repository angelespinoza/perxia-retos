// Herramientas del agente "Registro de Contratos Vigentes". Cada export se expone al modelo como contratos_<export>.
import { z } from "zod"
import { fail, ok } from "../core/result.ts"
import { defineTool, type ToolCtx } from "../core/types.ts"
import { type Actualizacion, alertasMarkdown, calcularAlertas } from "../domain/alertas.ts"
import {
  aCsv,
  aplicarCambios,
  type Cambios,
  clasificar,
  type Fila,
  filaNueva,
  rutaArchivo,
  siguienteAuto,
  type Validacion,
} from "../domain/clasificacion.ts"
import { parsearCsv, serializarCsv, type Tabla } from "../domain/csv.ts"
import { CAMPOS, type Campo, type Contrato, type Extraccion, extraerContrato, PAISES } from "../domain/extraccion.ts"
import {
  type Adjunto,
  type Correo,
  documentoContrato,
  leerAdjuntos,
  leerComerciales,
  leerCorreo,
  leerMaestroFixture,
  listarMensajes,
  motivoSinContrato,
} from "../domain/fixtures.ts"
import { esFechaIso, MONEDAS } from "../domain/texto.ts"

const RUTA_MAESTRO = "sharepoint/maestro-contratos.csv"
const RUTA_HISTORIAL = "sharepoint/historial.jsonl"
const RUTA_PROCESADOS = "procesados.json"
const RUTA_ALERTAS = "alertas.md"

// ---------- argumentos ----------

const argMensaje = z.string().describe("Identificador del mensaje del buzón, por ejemplo 'msg-001'")
const argFecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "se espera una fecha YYYY-MM-DD")

const ContratoArg = z
  .object({
    id_contrato: z.string().nullable().describe("Número del contrato"),
    cliente: z.string().nullable().describe("Razón social de la contraparte"),
    nit_cliente: z.string().nullable().describe("Identificador tributario sin puntos ni dígito de verificación"),
    pais: z.enum(PAISES).nullable().describe("País de la contraparte"),
    objeto: z.string().nullable().describe("Objeto del contrato (máx. 200 caracteres)"),
    valor: z.number().nonnegative().nullable().describe("Valor sin separadores; 0 si es por demanda"),
    moneda: z.enum(MONEDAS).nullable().describe("Moneda del valor"),
    fecha_inicio: argFecha.nullable().describe("Fecha de inicio YYYY-MM-DD"),
    fecha_fin: argFecha.nullable().describe("Fecha de fin YYYY-MM-DD"),
    requiere_poliza: z.boolean().nullable().describe("Si el contrato exige póliza"),
    tipo_poliza: z.string().nullable().describe("Tipos de póliza separados por ';'"),
  })
  .partial()
  .describe("Campos del contrato tal como los devolvió contratos_extraer; en los campos en revisión, el valor que confirmó el usuario")
type ContratoEntrada = z.infer<typeof ContratoArg>

// ---------- estado en out/ ----------

interface Procesado {
  clasificacion: string
  accion: string
  id_contrato: string
  fecha: string
  motivo?: string
}

async function leerProcesados(ctx: ToolCtx): Promise<Record<string, Procesado>> {
  const texto = await ctx.storage.leerTexto(RUTA_PROCESADOS)
  return texto ? (JSON.parse(texto) as Record<string, Procesado>) : {}
}

async function marcarProcesado(ctx: ToolCtx, id: string, p: Procesado): Promise<void> {
  const actuales = await leerProcesados(ctx)
  await ctx.storage.escribir(RUTA_PROCESADOS, JSON.stringify({ ...actuales, [id]: p }, null, 2))
}

/** Copia de trabajo del maestro; el fixture nunca se modifica (RN6). */
async function leerMaestro(ctx: ToolCtx): Promise<Tabla> {
  return parsearCsv((await ctx.storage.leerTexto(RUTA_MAESTRO)) ?? (await leerMaestroFixture(ctx.directory)))
}

/** La primera escritura copia el fixture a out/sharepoint/ (RN6). */
async function asegurarMaestro(ctx: ToolCtx): Promise<Tabla> {
  const copia = await ctx.storage.leerTexto(RUTA_MAESTRO)
  if (copia) return parsearCsv(copia)
  const original = await leerMaestroFixture(ctx.directory)
  await ctx.storage.escribir(RUTA_MAESTRO, original)
  return parsearCsv(original)
}

// ---------- análisis de un mensaje ----------

interface Analisis {
  correo: Correo
  documento: Adjunto | null
  extraccion: Extraccion | null
  motivo?: string
}

async function analizar(ctx: ToolCtx, id: string, maestro: Fila[]): Promise<Analisis> {
  const correo = await leerCorreo(ctx.directory, id)
  const adjuntos = await leerAdjuntos(ctx.directory, correo)
  const documento = documentoContrato(adjuntos)
  if (!documento) return { correo, documento, extraccion: null, motivo: motivoSinContrato(adjuntos) }
  const extraccion = extraerContrato(documento.texto)
  if (!extraccion.contrato.id_contrato) {
    const anio = (extraccion.contrato.fecha_inicio ?? correo.fecha).slice(0, 4)
    extraccion.contrato.id_contrato = siguienteAuto(maestro, anio)
    extraccion.confianza.id_contrato = 0.5
    extraccion.avisos.push("el documento no trae número de contrato: se asigna un identificador AUTO")
  }
  return { correo, documento, extraccion }
}

async function resolverComercial(ctx: ToolCtx, correo: Correo): Promise<{ nombre: string; aviso?: string }> {
  const comercial = (await leerComerciales(ctx.directory)).find((c) => c.email.toLowerCase() === correo.de.toLowerCase())
  if (comercial) return { nombre: comercial.nombre }
  return { nombre: "", aviso: `remitente_no_registrado: ${correo.de} no está en comerciales.json (no bloquea; queda sin comercial asignado)` }
}

/** Contrato que se registraría: valores de la extracción con la fila existente como respaldo para mostrar. */
function vistaContrato(c: Contrato): Record<Campo, unknown> {
  return Object.fromEntries(CAMPOS.map((k) => [k, c[k]])) as Record<Campo, unknown>
}

/** Compara lo que mandó el modelo con la extracción: fuera de revisión, siempre gana la herramienta (CA2). */
function compararEntrada(entrada: ContratoEntrada, c: Contrato, revision: string[]): { propuestos: string[]; ignorados: string[] } {
  const propuestos: string[] = []
  const ignorados: string[] = []
  for (const [campo, valor] of Object.entries(entrada) as [Campo, unknown][]) {
    if (valor === undefined || aCsv(campo, valor) === aCsv(campo, c[campo])) continue
    ;(revision.includes(campo) ? propuestos : ignorados).push(campo)
  }
  return { propuestos, ignorados }
}

function validarFechas(entrada: ContratoEntrada): string | null {
  for (const campo of ["fecha_inicio", "fecha_fin"] as const) {
    const valor = entrada[campo]
    if (valor && !esFechaIso(valor)) return `fecha inválida en ${campo}: ${valor}`
  }
  return null
}

function textoRevision(v: Validacion): string {
  return v.requiere_revision.map((c) => `${c} (${v.motivos_revision[c] ?? "revisar"})`).join(", ")
}

// ---------- herramientas ----------

export const leer_buzon = defineTool({
  description: "Lista los mensajes del buzón de contratos que aún no se han procesado, con remitente, asunto, adjuntos y si traen contrato.",
  args: {},
  async execute(_args, ctx) {
    const procesados = await leerProcesados(ctx)
    const ids = await listarMensajes(ctx.directory)
    const mensajes = []
    for (const id of ids.filter((i) => !procesados[i])) {
      const correo = await leerCorreo(ctx.directory, id)
      const adjuntos = await leerAdjuntos(ctx.directory, correo)
      const tiene = documentoContrato(adjuntos) !== null
      mensajes.push({
        id: correo.id,
        de: correo.de,
        asunto: correo.asunto,
        fecha: correo.fecha,
        adjuntos: correo.adjuntos,
        tiene_contrato: tiene,
        ...(tiene ? {} : { motivo: motivoSinContrato(adjuntos) }),
      })
    }
    return ok({ mensajes, pendientes: mensajes.length, ya_procesados: Object.keys(procesados).length })
  },
})

export const extraer = defineTool({
  description: "Extrae del contrato adjunto a un mensaje los campos del maestro con su confianza (0 a 1) y la evidencia del texto.",
  args: { mensaje_id: argMensaje },
  async execute({ mensaje_id }, ctx) {
    const a = await analizar(ctx, mensaje_id, (await leerMaestro(ctx)).filas)
    if (!a.extraccion || !a.documento)
      return ok({ mensaje_id, tiene_contrato: false, contrato: null, motivo: a.motivo })
    const { contrato, confianza, evidencia, avisos } = a.extraccion
    const baja = CAMPOS.filter((c) => confianza[c] < 0.8 && contrato[c] !== null)
    const datos = {
      mensaje_id,
      tiene_contrato: true,
      documento: a.documento.nombre,
      es_otrosi: contrato.es_otrosi,
      numero_otrosi: contrato.numero_otrosi,
      valor_indeterminado: contrato.valor_indeterminado,
      contrato: vistaContrato(contrato),
      confianza,
      campos_baja_confianza: baja,
      evidencia,
      avisos,
    }
    await ctx.storage.escribir(`extracciones/${mensaje_id}.json`, JSON.stringify(datos, null, 2))
    return ok(datos)
  },
})

export const validar = defineTool({
  description: "Clasifica el contrato de un mensaje contra el maestro (nuevo, actualizacion, duplicado o rechazado) y lista los campos que requieren revisión humana.",
  args: { mensaje_id: argMensaje, contrato: ContratoArg },
  async execute({ mensaje_id, contrato }, ctx) {
    const errorFecha = validarFechas(contrato)
    if (errorFecha) return fail(errorFecha)
    const maestro = (await leerMaestro(ctx)).filas
    const a = await analizar(ctx, mensaje_id, maestro)
    const v = clasificar(a.extraccion, maestro, a.motivo)
    const comercial = await resolverComercial(ctx, a.correo)
    const avisos = [...(a.extraccion?.avisos ?? []), ...(comercial.aviso ? [comercial.aviso] : [])]
    const comparacion = a.extraccion ? compararEntrada(contrato, a.extraccion.contrato, v.requiere_revision) : { propuestos: [], ignorados: [] }
    if (comparacion.ignorados.length)
      avisos.push(`valores enviados que no coinciden con la extracción y se ignoran: ${comparacion.ignorados.join(", ")}`)
    return ok({
      mensaje_id,
      clasificacion: v.clasificacion,
      id_contrato: v.id_contrato,
      ...(v.id_contrato_existente ? { id_contrato_existente: v.id_contrato_existente } : {}),
      requiere_revision: v.requiere_revision,
      motivos_revision: v.motivos_revision,
      ...(v.diferencias && Object.keys(v.diferencias).length ? { diferencias: v.diferencias } : {}),
      ...(v.motivo ? { motivo: v.motivo } : {}),
      ...(v.estado_poliza ? { estado_poliza_propuesto: v.estado_poliza } : {}),
      comercial: comercial.nombre || null,
      ...(a.extraccion ? { contrato: vistaContrato(a.extraccion.contrato) } : {}),
      ...(comparacion.propuestos.length ? { valores_propuestos_en_revision: comparacion.propuestos } : {}),
      avisos,
    })
  },
})

/** Valores del usuario: solo se aceptan en los campos en revisión, y solo con confirmación. */
function aplicarConfirmados(ext: Extraccion, revision: string[], entrada: ContratoEntrada): { aceptados: Cambios; ignorados: string[] } {
  const aceptados: Cambios = {}
  const ignorados: string[] = []
  const original = { ...ext.contrato }
  for (const [campo, valor] of Object.entries(entrada) as [Campo, unknown][]) {
    if (valor === undefined || !CAMPOS.includes(campo)) continue
    const antes = aCsv(campo, ext.contrato[campo])
    if (!revision.includes(campo)) {
      if (aCsv(campo, valor) !== antes) ignorados.push(campo)
      continue
    }
    ;(ext.contrato as unknown as Record<string, unknown>)[campo] = valor
  }
  // Los campos en revisión quedan confirmados por el usuario: con su valor o con el propuesto por la herramienta.
  for (const campo of revision) {
    if (!(CAMPOS as readonly string[]).includes(campo)) continue
    const c = campo as Campo
    const propuesto = aCsv(c, original[c])
    aceptados[c] = [propuesto, aCsv(c, ext.contrato[c])]
    ext.confianza[c] = 1
  }
  return { aceptados, ignorados }
}

export const registrar = defineTool({
  description:
    "Registra el resultado de un mensaje: inserta o actualiza la fila del maestro y archiva el documento; un duplicado o rechazado solo se marca como procesado. Con campos en revisión exige confirmado: true tras la confirmación del usuario.",
  args: {
    mensaje_id: argMensaje,
    contrato: ContratoArg,
    confirmado: z
      .boolean()
      .optional()
      .describe("true solo si el usuario confirmó explícitamente los campos en revisión en su último mensaje"),
  },
  efecto: "externa",
  async execute({ mensaje_id, contrato, confirmado }, ctx) {
    const errorFecha = validarFechas(contrato)
    if (errorFecha) return fail(errorFecha)
    const previo = (await leerProcesados(ctx))[mensaje_id]
    if (previo) return fail(`el mensaje ${mensaje_id} ya fue procesado (${previo.accion}${previo.id_contrato ? ` ${previo.id_contrato}` : ""})`)

    const tabla = await asegurarMaestro(ctx)
    const a = await analizar(ctx, mensaje_id, tabla.filas)
    let v = clasificar(a.extraccion, tabla.filas, a.motivo)
    let confirmados: Cambios = {}
    let ignorados: string[] = []
    if (v.requiere_revision.length > 0) {
      if (confirmado !== true) return fail(`requiere revisión: ${textoRevision(v)}. Pide confirmación al usuario antes de registrar.`)
      if (a.extraccion) {
        ;({ aceptados: confirmados, ignorados } = aplicarConfirmados(a.extraccion, v.requiere_revision, contrato))
        v = clasificar(a.extraccion, tabla.filas, a.motivo)
      }
    }
    const comercial = await resolverComercial(ctx, a.correo)
    const base = { mensaje_id, clasificacion: v.clasificacion, avisos: comercial.aviso ? [comercial.aviso] : [] }
    const procesado = (accion: string, extra: Partial<Procesado> = {}) =>
      marcarProcesado(ctx, mensaje_id, { clasificacion: v.clasificacion, accion, id_contrato: v.id_contrato, fecha: ctx.fechaReferencia, ...extra })

    if (v.clasificacion === "rechazado" || !a.extraccion || !a.documento) {
      await procesado("rechazado", { motivo: v.motivo })
      return ok({ ...base, id_contrato: v.id_contrato || null, accion: "rechazado", motivo: v.motivo, ruta_archivo: null })
    }
    if (v.clasificacion === "duplicado") {
      await procesado("sin_escritura")
      return ok({ ...base, id_contrato: v.id_contrato, accion: "sin_escritura", motivo: "duplicado del maestro (RN1)", ruta_archivo: null })
    }

    const c = a.extraccion.contrato
    const existente = tabla.filas.find((f) => f.id_contrato === v.id_contrato_existente)
    const ruta = rutaArchivo(c, v.id_contrato, existente, a.documento.extension)
    await ctx.storage.escribir(`sharepoint/${ruta}`, a.documento.texto)

    let cambios: Cambios
    if (existente) {
      cambios = v.diferencias ?? {}
      tabla.filas = tabla.filas.map((f) => (f === existente ? aplicarCambios(f, cambios) : f))
    } else {
      const fila = filaNueva(c, v, { comercial: comercial.nombre, ruta, hoy: ctx.fechaReferencia })
      cambios = Object.fromEntries(Object.entries(fila).map(([k, val]) => [k, ["", val]]))
      tabla.filas.push(fila)
    }
    const accion = existente ? "actualizado" : "insertado"
    await ctx.storage.escribir(RUTA_MAESTRO, serializarCsv(tabla))
    await ctx.storage.anexar(
      RUTA_HISTORIAL,
      JSON.stringify({ ts: new Date().toISOString(), fecha: ctx.fechaReferencia, id_contrato: v.id_contrato, accion, cambios, mensaje_id, documento: ruta }),
    )
    await procesado(accion)
    return ok({
      ...base,
      id_contrato: v.id_contrato,
      accion,
      ruta_archivo: `out/sharepoint/${ruta}`,
      estado_poliza: existente ? (cambios.estado_poliza?.[1] ?? existente.estado_poliza) : v.estado_poliza,
      ...(existente ? { cambios } : {}),
      ...(Object.keys(confirmados).length ? { valores_confirmados: confirmados } : {}),
      ...(ignorados.length ? { ignorados } : {}),
    })
  },
})

export const alertas = defineTool({
  description: "Genera out/alertas.md con los contratos que vencen en 60 días o menos, las pólizas pendientes y los registrados desde el corte del 2026-05-30.",
  args: { hoy: argFecha.describe("Fecha de referencia YYYY-MM-DD") },
  efecto: "escritura",
  async execute({ hoy }, ctx) {
    if (!esFechaIso(hoy)) return fail(`fecha inválida: ${hoy}`)
    const tabla = await asegurarMaestro(ctx)
    const historial = ((await ctx.storage.leerTexto(RUTA_HISTORIAL)) ?? "").split("\n").filter(Boolean)
    const actualizaciones: Actualizacion[] = historial.flatMap((linea) => {
      const h = JSON.parse(linea) as { id_contrato: string; accion: string; cambios: Cambios; mensaje_id: string; fecha: string }
      return h.accion === "actualizado" ? [{ id_contrato: h.id_contrato, fecha: h.fecha, campos: Object.keys(h.cambios), mensaje_id: h.mensaje_id }] : []
    })
    const a = calcularAlertas(tabla.filas, hoy, actualizaciones)
    await ctx.storage.escribir(RUTA_ALERTAS, alertasMarkdown(a, `out/${RUTA_MAESTRO}`))
    const corto = (lista: typeof a.vencen) => lista.map((c) => ({ id_contrato: c.id_contrato, cliente: c.cliente, fecha_fin: c.fecha_fin, dias: c.dias, estado_poliza: c.estado_poliza }))
    return ok({
      ruta: `out/${RUTA_ALERTAS}`,
      hoy,
      vencen: corto(a.vencen),
      polizas_pendientes: corto(a.polizas_pendientes),
      registrados_desde_corte: a.registrados_desde_corte.map((c) => ({ id_contrato: c.id_contrato, cliente: c.cliente, fecha_registro: c.fecha_registro })),
      actualizados_desde_corte: a.actualizados_desde_corte,
      vencidos_sin_cierre: corto(a.vencidos_sin_cierre),
    })
  },
})
