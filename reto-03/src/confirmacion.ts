// Política de confirmación del reto-03: la creación de la OC en SAP (simulado).
import { crearSolicitarConfirmacion, type PoliticaConfirmacion } from "./core/confirm.ts"
import { leerEstado } from "./domain/estado.ts"
import { ErrorFixture, leerArchivosCaso, leerMaestros, validarCaso } from "./domain/fixtures.ts"
import { OrdenCompraSchema } from "./domain/orden.ts"
import { armarPaquete } from "./domain/paquete.ts"
import { formatoCop, validarPaquete } from "./domain/reglas.ts"

export const politicaConfirmacion: PoliticaConfirmacion = {
  // Procesar una solicitud ya pide crear la OC; con excepciones (o si la analista pidió esperar) se confirma antes.
  async describir(p, ctx) {
    if (p.accion !== "crear_oc") return { error: `acción desconocida: ${p.accion}. La única acción con confirmación es 'crear_oc'` }
    try {
      await validarCaso(ctx.directory, p.referencia)
    } catch (e) {
      if (e instanceof ErrorFixture) return { error: e.message }
      throw e
    }
    const estado = await leerEstado(ctx.storage, p.referencia)
    if (estado.oc) return { error: `la OC ya existe para ${p.referencia}: ${estado.oc.numero_oc}` }
    if (!estado.payload) return { error: "falta un paso: primero llama a oc_construir_payload con este caso" }
    // Se revalida desde los fixtures: la advertencia sale de las reglas, no del modelo.
    const paquete = armarPaquete(await leerArchivosCaso(ctx.directory, p.referencia))
    const v = validarPaquete(paquete, await leerMaestros(ctx.directory))
    if (!v.apta) return { error: `la solicitud tiene bloqueos (${v.bloqueos.map((b) => b.regla).join(", ")}): no se puede crear la OC` }
    const orden = OrdenCompraSchema.safeParse(JSON.parse((await ctx.storage.leerTexto(`${p.referencia}/payload.json`)) ?? "null"))
    const detalle = orden.success
      ? ` a ${orden.data.proveedor.codigo_sap} ${orden.data.proveedor.nombre} por ${formatoCop(
          orden.data.posiciones.reduce((t, x) => t + x.cantidad * x.precio_unitario, 0),
        )} ${orden.data.moneda}`
      : ""
    const pregunta = `¿Confirmas la creación de la OC de ${p.referencia} en SAP (simulado)${detalle}?`
    const avisos = [
      ...v.confirmaciones.map((c) => `${c.regla}: ${c.detalle.replace(/\.$/, "")}`),
      ...(v.retroactiva ? ["la OC es retroactiva y queda marcada en el log de control"] : []),
    ]
    if (avisos.length === 0) return { pregunta }
    return {
      pregunta,
      advertencia: `la OC tiene excepciones que quedarán registradas como confirmadas por ti: ${avisos.join(" | ")}. La OC se crea con los valores de la solicitud, sin ajustarla a la cotización.`,
    }
  },
}

/** Pseudo-herramienta agente_solicitar_confirmacion con la política de este reto. */
export const solicitar_confirmacion = crearSolicitarConfirmacion(politicaConfirmacion, "crear_oc", "sol-004")
