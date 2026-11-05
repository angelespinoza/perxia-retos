// Herramientas del agente "Órdenes de Compra SAP". Cada export se expone al modelo como oc_<export>.
// Orden: leer_paquete → validar → generar_evidencia → construir_payload → crear.
import { z } from "zod"
import { fail, ok } from "../core/result.ts"
import type { Storage } from "../core/storage.ts"
import { defineTool, type ToolCtx } from "../core/types.ts"
import { registrarControl, type ResultadoControl } from "../domain/control.ts"
import { ErrorFixture, leerArchivosCaso, leerMaestros, listarCasos, validarCaso } from "../domain/fixtures.ts"
import {
  construirOrden,
  generarEvidenciaPdf,
  generarEvidenciaTxt,
  hashPayload,
  type OrdenCompra,
  OrdenCompraSchema,
} from "../domain/orden.ts"
import { armarPaquete, type Paquete } from "../domain/paquete.ts"
import { type ResultadoValidacion, validarPaquete } from "../domain/reglas.ts"
import type { SapAdapter } from "../sap/adapter.ts"
import { MockSap } from "../sap/mock.ts"

interface EstadoCaso {
  paquete_leido?: boolean
  validacion?: ResultadoValidacion
  evidencia?: { ruta: string; ruta_pdf: string; sha256: string }
  payload?: { ruta: string; trazabilidad: string; hash: string }
  oc?: { numero_oc: string; fecha: string }
}

const argCaso = z.string().describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, por ejemplo 'sol-004'")
const argPaquete = z
  .record(z.string(), z.unknown())
  .optional()
  .describe("Opcional. El paquete de oc_leer_paquete; la herramienta siempre lo relee desde los fixtures")

/** SAP simulado por defecto; un test o una integración real puede inyectar otro adaptador. */
let fabricaSap: (ctx: ToolCtx) => SapAdapter = (ctx) => new MockSap(ctx.storage, ctx.directory)
export function usarSap(fabrica: (ctx: ToolCtx) => SapAdapter): void {
  fabricaSap = fabrica
}

// ---------- utilidades internas ----------

async function leerEstado(storage: Storage, caso: string): Promise<EstadoCaso> {
  const texto = await storage.leerTexto(`${caso}/estado.json`)
  return texto ? (JSON.parse(texto) as EstadoCaso) : {}
}

async function guardarEstado(storage: Storage, caso: string, cambios: EstadoCaso): Promise<EstadoCaso> {
  const estado = { ...(await leerEstado(storage, caso)), ...cambios }
  await storage.escribir(`${caso}/estado.json`, JSON.stringify(estado, null, 2))
  return estado
}

/** El paquete y la validación siempre se recalculan desde los fixtures: nunca se confía en lo que envía el modelo. */
async function paqueteDe(ctx: ToolCtx, caso: string): Promise<Paquete> {
  await validarCaso(ctx.directory, caso)
  return armarPaquete(await leerArchivosCaso(ctx.directory, caso))
}

async function validarDesdeFixtures(ctx: ToolCtx, caso: string): Promise<{ paquete: Paquete; validacion: ResultadoValidacion }> {
  const paquete = await paqueteDe(ctx, caso)
  return { paquete, validacion: validarPaquete(paquete, await leerMaestros(ctx.directory)) }
}

const codigos = (h: { regla: string }[]) => h.map((x) => x.regla)

async function control(
  ctx: ToolCtx,
  paquete: Paquete,
  v: ResultadoValidacion,
  resultado: ResultadoControl,
  numero_oc: string | null = null,
): Promise<void> {
  await registrarControl(ctx.storage, {
    solicitud_id: paquete.solicitud.solicitud_id,
    resultado,
    numero_oc,
    retroactiva: v.retroactiva,
    bloqueos: codigos(v.bloqueos),
    confirmaciones: codigos(v.confirmaciones),
    ts: new Date().toISOString(),
  })
}

function conErrores(fn: () => Promise<string>): Promise<string> {
  return fn().catch((e: unknown) => {
    if (e instanceof ErrorFixture) return fail(e.message)
    throw e
  })
}

// ---------- herramientas ----------

export const listar_casos = defineTool({
  description: "Lista las solicitudes de compra disponibles (carpetas de fixtures/reto-03/solicitudes/).",
  args: {},
  async execute(_args, ctx) {
    return ok({ casos: await listarCasos(ctx.directory) })
  },
})

export const leer_paquete = defineTool({
  description:
    "Lee el correo, la solicitud, la cotización, la aprobación y la factura de un caso y los devuelve normalizados; un adjunto ausente sale en null y en faltantes.",
  args: { caso: argCaso },
  async execute({ caso }, ctx) {
    return conErrores(async () => {
      const paquete = await paqueteDe(ctx, caso)
      await guardarEstado(ctx.storage, caso, { paquete_leido: true })
      return ok(paquete)
    })
  },
})

export const validar = defineTool({
  description:
    "Aplica las reglas de control RC1–RC10 contra los maestros y devuelve apta, bloqueos, confirmaciones, valores derivados y si la OC es retroactiva.",
  args: { caso: argCaso, paquete: argPaquete },
  async execute({ caso }, ctx) {
    return conErrores(async () => {
      const estado = await leerEstado(ctx.storage, caso)
      if (!estado.paquete_leido) return fail("falta un paso: primero llama a oc_leer_paquete con este caso")
      const { validacion } = await validarDesdeFixtures(ctx, caso)
      await guardarEstado(ctx.storage, caso, { validacion })
      return ok(validacion)
    })
  },
})

export const generar_evidencia = defineTool({
  description:
    "Genera la evidencia de aprobación (aprobacion.txt con encabezados, cuerpo y sha256, y aprobacion.pdf) para adjuntar a la OC.",
  args: { caso: argCaso },
  efecto: "escritura",
  async execute({ caso }, ctx) {
    return conErrores(async () => {
      const estado = await leerEstado(ctx.storage, caso)
      if (!estado.validacion) return fail("falta un paso: primero llama a oc_validar con este caso")
      await validarCaso(ctx.directory, caso)
      const { aprobacion } = await leerArchivosCaso(ctx.directory, caso)
      if (!aprobacion) return fail("no hay correo de aprobación: pide al solicitante reenviar la aprobación del líder")
      const txt = generarEvidenciaTxt(aprobacion)
      await ctx.storage.escribir(`${caso}/aprobacion.txt`, txt.contenido)
      await ctx.storage.escribir(`${caso}/aprobacion.pdf`, await generarEvidenciaPdf(aprobacion, txt.sha256, caso))
      const evidencia = { ruta: `out/${caso}/aprobacion.txt`, ruta_pdf: `out/${caso}/aprobacion.pdf`, sha256: txt.sha256 }
      await guardarEstado(ctx.storage, caso, { evidencia })
      return ok(evidencia)
    })
  },
})

export const construir_payload = defineTool({
  description:
    "Construye la OC tal como quedaría en SAP (validada con zod) y guarda su trazabilidad campo por campo; solo para solicitudes aptas.",
  args: {
    caso: argCaso,
    paquete: argPaquete,
    derivados: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Opcional. Los derivados de oc_validar; la herramienta usa siempre los que ella misma calculó"),
  },
  efecto: "escritura",
  async execute({ caso }, ctx) {
    return conErrores(async () => {
      const estado = await leerEstado(ctx.storage, caso)
      if (!estado.validacion) return fail("falta un paso: primero llama a oc_validar con este caso")
      if (!estado.evidencia) return fail("falta un paso: primero llama a oc_generar_evidencia (el payload lleva su sha256)")
      const { paquete, validacion } = await validarDesdeFixtures(ctx, caso)
      if (!validacion.apta)
        return fail(`la solicitud tiene bloqueos (${codigos(validacion.bloqueos).join(", ")}): no se construye la OC`)
      const { orden, trazabilidad } = construirOrden(paquete, validacion, estado.evidencia.sha256)
      await ctx.storage.escribir(`${caso}/payload.json`, JSON.stringify(orden, null, 2))
      await ctx.storage.escribir(`${caso}/trazabilidad.json`, JSON.stringify(trazabilidad, null, 2))
      const payload = { ruta: `out/${caso}/payload.json`, trazabilidad: `out/${caso}/trazabilidad.json`, hash: hashPayload(orden) }
      await guardarEstado(ctx.storage, caso, { validacion, payload })
      return ok({
        payload: orden,
        ruta_trazabilidad: payload.trazabilidad,
        ruta_payload: payload.ruta,
        confirmaciones_pendientes: codigos(validacion.confirmaciones),
        derivados: validacion.derivados,
      })
    })
  },
})

export const crear = defineTool({
  description:
    "Crea la OC en el SAP simulado y devuelve su número; idempotente por solicitud_id. Si hay confirmaciones exige confirmado: true tras la confirmación del usuario.",
  args: {
    caso: argCaso,
    payload: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Opcional. El payload de oc_construir_payload sin cambios; si se envía y difiere del guardado, se rechaza"),
    confirmado: z
      .boolean()
      .optional()
      .describe("true solo si el usuario confirmó las excepciones en su último mensaje"),
  },
  efecto: "externa",
  async execute({ caso, payload, confirmado }, ctx) {
    return conErrores(async () => {
      const { paquete, validacion } = await validarDesdeFixtures(ctx, caso)
      const sap = fabricaSap(ctx)
      const s = paquete.solicitud

      if (!validacion.apta) {
        await control(ctx, paquete, validacion, "bloqueada")
        const razones = validacion.bloqueos.map((b) => `${b.regla}: ${b.detalle} Acción: ${b.accion_sugerida}`).join(" | ")
        return fail(`OC bloqueada, no se crea. ${razones}`)
      }

      const existente = await sap.buscarOrdenPorReferencia(s.solicitud_id)
      if (existente) {
        const estado = await leerEstado(ctx.storage, caso)
        await control(ctx, paquete, validacion, "idempotente", existente.numero_oc)
        return ok({ numero_oc: existente.numero_oc, fecha: estado.oc?.fecha ?? null, idempotente: true, retroactiva: validacion.retroactiva })
      }

      const estado = await leerEstado(ctx.storage, caso)
      if (!estado.payload) return fail("falta un paso: primero llama a oc_construir_payload con este caso")

      if (validacion.confirmaciones.length > 0 && confirmado !== true) {
        await control(ctx, paquete, validacion, "pendiente")
        const lista = validacion.confirmaciones.map((c) => `${c.regla}: ${c.detalle}`).join(" | ")
        return fail(
          `requiere confirmación explícita del usuario antes de crear (${lista}) Llama a agente_solicitar_confirmacion y espera su respuesta.`,
        )
      }

      const guardado = OrdenCompraSchema.parse(JSON.parse((await ctx.storage.leerTexto(`${caso}/payload.json`)) ?? "null"))
      if (hashPayload(guardado) !== estado.payload.hash)
        return fail("el payload guardado cambió desde oc_construir_payload: vuelve a construirlo")
      if (payload !== undefined) {
        const enviado = OrdenCompraSchema.safeParse(payload)
        if (!enviado.success || hashPayload(enviado.data) !== estado.payload.hash)
          return fail("el payload enviado no coincide con el de oc_construir_payload: no se modifica una OC validada. Llama sin payload o con el payload sin cambios")
      }

      const proveedorSap = await sap.consultarProveedor(guardado.proveedor.nit)
      if (!proveedorSap?.activo) {
        await control(ctx, paquete, { ...validacion, bloqueos: [{ regla: "RC1", detalle: "proveedor no activo en SAP", accion_sugerida: "" }] }, "bloqueada")
        return fail("SAP no reconoce al proveedor como activo: no se crea la OC")
      }

      const confirmador = `analista (sesión ${ctx.sessionId})`
      const orden: OrdenCompra = {
        ...guardado,
        excepciones: guardado.excepciones.map((e) => ({ ...e, confirmado_por: confirmador })),
      }
      const creada = await sap.crearOrden(orden)
      await ctx.storage.escribir(`${caso}/oc.json`, JSON.stringify({ ...creada, orden }, null, 2))
      await guardarEstado(ctx.storage, caso, { oc: creada })
      await control(ctx, paquete, validacion, "creada", creada.numero_oc)
      return ok({
        numero_oc: creada.numero_oc,
        fecha: creada.fecha,
        idempotente: false,
        retroactiva: validacion.retroactiva,
        evidencia: estado.evidencia?.ruta ?? null,
        evidencia_pdf: estado.evidencia?.ruta_pdf ?? null,
        excepciones_confirmadas: orden.excepciones.map((e) => e.codigo),
        ruta_oc: `out/${caso}/oc.json`,
      })
    })
  },
})
