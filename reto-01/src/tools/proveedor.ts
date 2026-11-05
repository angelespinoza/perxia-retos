// Herramientas del agente "Registro como Proveedor". Cada export se expone al modelo como proveedor_<export>.
import { z } from "zod"
import { fail, ok } from "../core/result.ts"
import type { Storage } from "../core/storage.ts"
import { defineTool, type ToolCtx } from "../core/types.ts"
import {
  generarBorradorCorreo,
  generarChecklist,
  generarPdf,
  generarValoresPortal,
  generarXlsx,
} from "../domain/documentos.ts"
import {
  type CampoPlantilla,
  type Celda,
  ErrorFixture,
  leerArchivoSoporte,
  leerGlosario,
  leerIndiceSoportes,
  leerMaestro,
  leerPlantillaCampos,
  leerPlantillaCeldas,
  leerSolicitud,
  leerSoportesExigidos,
  listarCasos,
  type Solicitud,
  validarCaso,
} from "../domain/fixtures.ts"
import { agrupar, type CampoMapeado, camposAmbiguos, mapearCampos } from "../domain/mapeo.ts"
import { evaluarSoportes, listoParaFirma, type SoporteEvaluado } from "../domain/soportes.ts"

type Plantilla = { tipo: "celdas"; celdas: Celda[] } | { tipo: "campos"; campos: CampoPlantilla[] }

interface EstadoCaso {
  campos?: CampoMapeado[]
  formulario?: { ruta: string; formato: string }
  soportes?: SoporteEvaluado[]
  listo_para_firma?: boolean
}

const argCaso = z.string().describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/, por ejemplo 'ec-corp-andina'")

// ---------- utilidades internas ----------

async function cargarPlantilla(ctx: ToolCtx, solicitud: Solicitud, caso: string): Promise<Plantilla> {
  if (solicitud.formato === "xlsx") return { tipo: "celdas", celdas: await leerPlantillaCeldas(ctx.directory, caso) }
  return { tipo: "campos", campos: await leerPlantillaCampos(ctx.directory, caso) }
}

function etiquetasDe(plantilla: Plantilla): string[] {
  return plantilla.tipo === "celdas" ? plantilla.celdas.map((c) => c.etiqueta) : plantilla.campos.map((c) => c.etiqueta)
}

async function leerEstado(storage: Storage, caso: string): Promise<EstadoCaso> {
  const texto = await storage.leerTexto(`${caso}/estado.json`)
  return texto ? (JSON.parse(texto) as EstadoCaso) : {}
}

async function guardarEstado(storage: Storage, caso: string, cambios: EstadoCaso): Promise<EstadoCaso> {
  const estado = { ...(await leerEstado(storage, caso)), ...cambios }
  await storage.escribir(`${caso}/estado.json`, JSON.stringify(estado, null, 2))
  return estado
}

/** El mapeo siempre sale de la herramienta (D6): se usa el guardado o se recalcula, nunca el del modelo. */
async function mapeoDelCaso(ctx: ToolCtx, caso: string, solicitud: Solicitud, plantilla: Plantilla): Promise<CampoMapeado[]> {
  const estado = await leerEstado(ctx.storage, caso)
  if (estado.campos && estado.campos.length > 0) return estado.campos
  const [maestro, glosario] = await Promise.all([leerMaestro(ctx.directory), leerGlosario(ctx.directory)])
  const campos = mapearCampos(etiquetasDe(plantilla), solicitud.pais, maestro, glosario)
  await guardarEstado(ctx.storage, caso, { campos })
  return campos
}

async function escribirFormulario(
  ctx: ToolCtx,
  caso: string,
  solicitud: Solicitud,
  plantilla: Plantilla,
  campos: CampoMapeado[],
): Promise<{ ruta: string; formato: string }> {
  if (solicitud.formato === "xlsx" && plantilla.tipo === "celdas") {
    await ctx.storage.escribir(`${caso}/formulario.xlsx`, await generarXlsx(plantilla.celdas, campos))
    return guardarFormulario(ctx, caso, `${caso}/formulario.xlsx`, "xlsx")
  }
  if (solicitud.formato === "pdf" && plantilla.tipo === "campos") {
    await ctx.storage.escribir(`${caso}/formulario.pdf`, await generarPdf(solicitud, plantilla.campos, campos))
    return guardarFormulario(ctx, caso, `${caso}/formulario.pdf`, "pdf")
  }
  await ctx.storage.escribir(`${caso}/valores-portal.md`, generarValoresPortal(solicitud, campos))
  return guardarFormulario(ctx, caso, `${caso}/valores-portal.md`, "portal")
}

async function guardarFormulario(ctx: ToolCtx, caso: string, ruta: string, formato: string) {
  const formulario = { ruta, formato }
  await guardarEstado(ctx.storage, caso, { formulario })
  return formulario
}

function conErrores(fn: (ctx: ToolCtx) => Promise<string>) {
  return async (ctx: ToolCtx): Promise<string> => {
    try {
      return await fn(ctx)
    } catch (e) {
      if (e instanceof ErrorFixture) return fail(e.message)
      throw e
    }
  }
}

// ---------- herramientas ----------

export const listar_casos = defineTool({
  description: "Lista los casos (solicitudes de registro) disponibles en la carpeta de entrada.",
  args: {},
  async execute(_args, ctx) {
    return ok({ casos: await listarCasos(ctx.directory) })
  },
})

export const leer_solicitud = defineTool({
  description:
    "Lee el correo y la plantilla de un caso y devuelve país, cliente, formato de salida, campos pedidos y soportes exigidos.",
  args: { caso: argCaso },
  async execute({ caso }, ctx) {
    return conErrores(async () => {
      await validarCaso(ctx.directory, caso)
      const solicitud = await leerSolicitud(ctx.directory, caso)
      const soportes = await leerSoportesExigidos(ctx.directory, caso)
      const advertencias: string[] = []
      let campos: Array<Record<string, unknown>> = []
      let etiquetas: string[] = []
      try {
        const plantilla = await cargarPlantilla(ctx, solicitud, caso)
        etiquetas = etiquetasDe(plantilla)
        campos =
          plantilla.tipo === "celdas"
            ? plantilla.celdas.map((c) => ({ etiqueta: c.etiqueta, hoja: c.hoja, celda: c.celda_valor }))
            : plantilla.campos.map((c) => ({ etiqueta: c.etiqueta, obligatorio: c.obligatorio }))
      } catch (e) {
        if (!(e instanceof ErrorFixture)) throw e
        advertencias.push(`${e.message}: no se puede llenar el formulario, pero sí revisar los soportes`)
      }
      if (solicitud.formato === "portal")
        advertencias.push("formato no soportado: portal web. Se prepararán los valores para copiar en valores-portal.md")
      const glosario = await leerGlosario(ctx.directory)
      return ok({
        pais: solicitud.pais,
        cliente: solicitud.cliente,
        formato: solicitud.formato,
        de: solicitud.de,
        asunto: solicitud.asunto,
        fecha: solicitud.fecha,
        campos,
        soportes,
        requiere_confirmacion: camposAmbiguos(etiquetas, solicitud.pais, glosario),
        advertencias,
      })
    })(ctx)
  },
})

export const mapear_campos = defineTool({
  description:
    "Cruza los campos pedidos con el maestro y clasifica cada uno en lleno (con su ruta en el maestro), faltante o requiere_confirmacion.",
  args: {
    caso: argCaso,
    campos: z
      .array(z.string())
      .describe("Etiquetas de los campos tal como las devolvió proveedor_leer_solicitud; vacío = todos los de la plantilla"),
  },
  async execute({ caso, campos }, ctx) {
    return conErrores(async () => {
      await validarCaso(ctx.directory, caso)
      const solicitud = await leerSolicitud(ctx.directory, caso)
      const plantilla = await cargarPlantilla(ctx, solicitud, caso)
      const deLaPlantilla = etiquetasDe(plantilla)
      const desconocidas = campos.filter((c) => !deLaPlantilla.includes(c))
      const etiquetas = campos.length > 0 ? campos.filter((c) => deLaPlantilla.includes(c)) : deLaPlantilla
      const [maestro, glosario] = await Promise.all([leerMaestro(ctx.directory), leerGlosario(ctx.directory)])
      const mapeados = mapearCampos(etiquetas, solicitud.pais, maestro, glosario)
      // Un mapeo nuevo invalida el formulario generado antes.
      await guardarEstado(ctx.storage, caso, { campos: mapeados, formulario: undefined })
      return ok({
        ...agrupar(mapeados),
        ...(desconocidas.length > 0 ? { ignorados_no_estan_en_plantilla: desconocidas } : {}),
      })
    })(ctx)
  },
})

export const generar_formulario = defineTool({
  description:
    "Genera el formulario lleno en el formato que pidió el cliente (xlsx o pdf) o, si es portal web, los valores para copiar.",
  args: {
    caso: argCaso,
    mapeo: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe("Opcional. El mapeo de proveedor_mapear_campos; la herramienta usa siempre el mapeo que ella misma calculó"),
  },
  efecto: "escritura",
  async execute({ caso }, ctx) {
    return conErrores(async () => {
      await validarCaso(ctx.directory, caso)
      const solicitud = await leerSolicitud(ctx.directory, caso)
      const plantilla = await cargarPlantilla(ctx, solicitud, caso)
      const campos = await mapeoDelCaso(ctx, caso, solicitud, plantilla)
      const formulario = await escribirFormulario(ctx, caso, solicitud, plantilla, campos)
      if (formulario.formato === "portal")
        return fail(`formato no soportado: portal web. Se generaron los valores para copiar en out/${formulario.ruta}`)
      return ok({ ruta: `out/${formulario.ruta}`, formato: formulario.formato })
    })(ctx)
  },
})

export const armar_paquete = defineTool({
  description:
    "Arma el paquete para firma: formulario, copias de los soportes exigidos, checklist (presentes, ausentes, vencidos) y borrador de correo.",
  args: { caso: argCaso },
  efecto: "escritura",
  async execute({ caso }, ctx) {
    return conErrores(async () => {
      await validarCaso(ctx.directory, caso)
      const solicitud = await leerSolicitud(ctx.directory, caso)
      const [exigidos, indice] = await Promise.all([
        leerSoportesExigidos(ctx.directory, caso),
        leerIndiceSoportes(ctx.directory),
      ])
      const soportes = evaluarSoportes(exigidos, indice, ctx.fechaReferencia)
      const advertencias: string[] = []
      let campos: CampoMapeado[] = []
      let formulario: { ruta: string; formato: string } | null = null
      try {
        const plantilla = await cargarPlantilla(ctx, solicitud, caso)
        campos = await mapeoDelCaso(ctx, caso, solicitud, plantilla)
        formulario = (await leerEstado(ctx.storage, caso)).formulario ?? (await escribirFormulario(ctx, caso, solicitud, plantilla, campos))
      } catch (e) {
        if (!(e instanceof ErrorFixture)) throw e
        advertencias.push(`${e.message}: el paquete se arma sin formulario`)
      }

      const destino = `${caso}/paquete`
      if (formulario) {
        const bytes = await ctx.storage.leer(formulario.ruta)
        const nombre = formulario.ruta.split("/").at(-1) ?? "formulario"
        if (bytes) await ctx.storage.escribir(`${destino}/${nombre}`, bytes)
      }
      for (const s of soportes) {
        if (s.archivo) await ctx.storage.escribir(`${destino}/soportes/${s.archivo}`, await leerArchivoSoporte(ctx.directory, s.archivo))
      }
      const listo = listoParaFirma(soportes) && formulario !== null
      await ctx.storage.escribir(
        `${destino}/checklist.md`,
        generarChecklist(solicitud, soportes, campos, listo, ctx.fechaReferencia),
      )
      await ctx.storage.escribir(
        `${destino}/borrador-correo.md`,
        generarBorradorCorreo(solicitud, soportes, formulario?.ruta.split("/").at(-1) ?? "formulario"),
      )
      await guardarEstado(ctx.storage, caso, { soportes, listo_para_firma: listo })
      return ok({
        ruta: `out/${destino}/`,
        listo_para_firma: listo,
        checklist: soportes.map((s) => ({ tipo: s.tipo, estado: s.estado, vigencia_hasta: s.vigencia_hasta ?? null })),
        campos_faltantes: campos.filter((c) => c.estado === "faltante").map((c) => c.etiqueta),
        campos_por_confirmar: campos.filter((c) => c.estado === "requiere_confirmacion").map((c) => c.etiqueta),
        fecha_referencia: ctx.fechaReferencia,
        advertencias,
      })
    })(ctx)
  },
})

export const simular_envio = defineTool({
  description:
    "Simula el envío del paquete al cliente escribiendo ENVIO-SIMULADO.md; solo procede con confirmación explícita del usuario en este turno.",
  args: {
    caso: argCaso,
    confirmado: z.boolean().describe("true solo si el usuario confirmó el envío en su último mensaje"),
  },
  efecto: "externa",
  async execute({ caso, confirmado }, ctx) {
    return conErrores(async () => {
      if (!confirmado) return fail("requiere confirmación explícita")
      await validarCaso(ctx.directory, caso)
      const estado = await leerEstado(ctx.storage, caso)
      if (estado.listo_para_firma === undefined) return fail("primero arma el paquete con proveedor_armar_paquete")
      const solicitud = await leerSolicitud(ctx.directory, caso)
      const pendientes = (estado.soportes ?? []).filter((s) => s.estado !== "presente").map((s) => `${s.tipo} (${s.estado})`)
      const contenido = [
        `# Envío simulado — ${solicitud.cliente}`,
        "",
        `- Fecha: ${new Date().toISOString()}`,
        `- Para: ${solicitud.de}`,
        `- Paquete: out/${caso}/paquete/`,
        `- Confirmado por el usuario en la sesión ${ctx.sessionId}`,
        `- Listo para firma: ${estado.listo_para_firma ? "sí" : "no"}`,
        ...(pendientes.length > 0 ? [`- Advertencia: se envió con soportes pendientes: ${pendientes.join(", ")}`] : []),
        "",
        "No se envió ningún correo real: este archivo solo deja constancia de la decisión.",
        "",
      ].join("\n")
      await ctx.storage.escribir(`${caso}/ENVIO-SIMULADO.md`, contenido)
      return ok({ ruta: `out/${caso}/ENVIO-SIMULADO.md`, advertencias: pendientes })
    })(ctx)
  },
})
